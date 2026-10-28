#!/usr/bin/env node
// Monthly activity chart for the profile README (last 12 months, current month partial).
//
// Data comes from the GitHub GraphQL API using a token with `repo` + `read:org` (GH_TOKEN or METRICS_TOKEN):
//   - commits + lines: default-branch history of every accessible non-fork repo, filtered by author
//     (contributionsCollection reports most org contributions only as "restricted", so it can't be used)
//   - pull requests: search issueCount for `is:pr author:<login> created:<month>` (and `is:merged`)
//
// Privacy: only monthly aggregates are ever written or logged. Every repo name seen during the fetch is
// checked against the outputs (and log lines) before anything is written; a hit aborts the run.
//
// Usage: node scripts/activity.mjs [--out metrics]   fetch, check, write
//        node scripts/activity.mjs --check [metrics]  re-check files already written (fetches repo names only)

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LOGIN = "fm1randa";
export const TIME_ZONE = "America/Sao_Paulo";
export const MONTHS = 12;
// Commits changing more lines than this (vendored code, lockfiles, generated files) are left out of the
// lines metric. They still count as commits.
export const MAX_LINES_PER_COMMIT = 20_000;

const API = "https://api.github.com/graphql";
const MAX_ATTEMPTS = 6;
const MAX_WAIT_MS = 15 * 60_000;
const BATCH_SIZE = 25;
const PAGE_SIZES = [50, 25, 10];

// ---------------------------------------------------------------------------------------------------------
// Logging: counts only. Lines are kept so the privacy check can scan them too.

const logLines = [];
function log(message) {
  logLines.push(message);
  console.log(message);
}

// Error messages from the API can contain repo names; never print one without redacting.
let knownNames = [];
function redact(text) {
  let out = String(text);
  for (const name of knownNames) out = out.split(name).join("[repo]");
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Time helpers (calendar months in TIME_ZONE)

function tzOffset(date) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName").value; // "GMT-03:00"
  return part === "GMT" ? "+00:00" : part.slice(3);
}

function monthStart(year, month) {
  // month is 1-based and may overflow (13 -> January of next year)
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  const local = `${y}-${String(m).padStart(2, "0")}-01T00:00:00`;
  const offset = tzOffset(new Date(`${local}Z`));
  return { key: `${y}-${String(m).padStart(2, "0")}`, iso: `${local}${offset}`, date: new Date(`${local}${offset}`) };
}

const monthKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit" });
function monthKey(date) {
  const parts = Object.fromEntries(monthKeyFormat.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}`;
}

export function localDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date); // YYYY-MM-DD
}

export function monthWindows(now = new Date()) {
  const [y, m] = monthKey(now).split("-").map(Number);
  const windows = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const start = monthStart(y, m - i);
    const end = monthStart(y, m - i + 1);
    windows.push({ key: start.key, since: start.iso, until: end.iso, sinceDate: start.date, untilDate: end.date, partial: i === 0 });
  }
  return windows;
}

// ---------------------------------------------------------------------------------------------------------
// GraphQL client with retries and rate-limit handling

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GraphQLError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.type ?? "ERROR").join(", "));
    this.errors = errors;
  }
}

function resetWait(headers) {
  const retryAfter = Number(headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && reset) return reset * 1000 - Date.now() + 1000;
  return 0;
}

async function gql(token, query, variables = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let wait = Math.min(2 ** attempt * 1000, 60_000);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": `${LOGIN}-activity` },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401) throw Object.assign(new Error("401 Unauthorized: check the token"), { fatal: true });
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        wait = Math.max(wait, resetWait(res.headers));
        lastError = new Error(`HTTP ${res.status}`);
      } else {
        const body = await res.json();
        if (!body.errors?.length) return body.data;
        if (body.errors.some((e) => e.type === "RATE_LIMITED")) {
          wait = Math.max(wait, resetWait(res.headers), 60_000);
          lastError = new GraphQLError(body.errors);
        } else {
          throw Object.assign(new GraphQLError(body.errors), { fatal: true, data: body.data });
        }
      }
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    if (attempt < MAX_ATTEMPTS) {
      wait = Math.min(wait, MAX_WAIT_MS);
      log(`  retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s (${redact(lastError.message)})`);
      await sleep(wait);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------------------------------------
// Fetching

const REPO_FIELDS = "nodes { id name nameWithOwner isFork }";

async function listRepositories(token) {
  const repos = new Map();
  const add = (nodes) => nodes.filter(Boolean).forEach((r) => repos.set(r.id, r));
  for (const field of [
    "repositories(first: 100, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER])",
    "repositoriesContributedTo(first: 100, after: $after, includeUserRepositories: true, contributionTypes: [COMMIT, PULL_REQUEST])",
  ]) {
    let after = null;
    do {
      const data = await gql(token, `query($after: String) { viewer { list: ${field} { pageInfo { hasNextPage endCursor } ${REPO_FIELDS} } } }`, { after });
      add(data.viewer.list.nodes);
      after = data.viewer.list.pageInfo.hasNextPage ? data.viewer.list.pageInfo.endCursor : null;
    } while (after);
  }
  return [...repos.values()];
}

const historyArgs = "author: { id: $author }, since: $since, until: $until";

// Which repos have commits by the user in the window (batched; repos that error out are counted and skipped).
async function reposWithCommits(token, repos, authorId, since, until) {
  const active = [];
  let unreadable = 0;
  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const fields = batch
      .map((r, j) => `r${j}: node(id: ${JSON.stringify(r.id)}) { ... on Repository { defaultBranchRef { target { ... on Commit { history(${historyArgs}) { totalCount } } } } } }`)
      .join("\n");
    let data;
    try {
      data = await gql(token, `query($author: ID!, $since: GitTimestamp!, $until: GitTimestamp!) { ${fields} }`, { author: authorId, since, until });
    } catch (error) {
      if (!error.data) throw error;
      data = error.data; // partial result: some repos unreadable
    }
    batch.forEach((repo, j) => {
      const node = data?.[`r${j}`];
      if (!node) unreadable++;
      else if (node.defaultBranchRef?.target?.history?.totalCount > 0) active.push(repo);
    });
  }
  return { active, unreadable };
}

async function historyPage(token, repo, authorId, since, until, after) {
  let lastError;
  for (const size of PAGE_SIZES) {
    try {
      const data = await gql(
        token,
        `query($id: ID!, $author: ID!, $since: GitTimestamp!, $until: GitTimestamp!, $after: String) {
          node(id: $id) { ... on Repository { defaultBranchRef { target { ... on Commit {
            history(first: ${size}, after: $after, ${historyArgs}) {
              pageInfo { hasNextPage endCursor }
              nodes { committedDate additions deletions parents { totalCount } }
            } } } } } }
        }`,
        { id: repo.id, author: authorId, since, until, after },
      );
      return data.node.defaultBranchRef.target.history;
    } catch (error) {
      lastError = error; // big diffs can time out computing additions/deletions; retry with a smaller page
    }
  }
  throw lastError;
}

function emptyMonth(window) {
  return { month: window.key, partial: window.partial, commits: 0, additions: 0, deletions: 0, mergeCommits: 0, largeCommits: 0, prsOpened: 0, prsMerged: 0 };
}

export async function collect(token, now = new Date()) {
  const windows = monthWindows(now);
  const months = new Map(windows.map((w) => [w.key, emptyMonth(w)]));
  const since = windows[0].since;
  const until = now.toISOString();

  const viewer = (await gql(token, "{ viewer { id login } }")).viewer;
  if (viewer.login.toLowerCase() !== LOGIN.toLowerCase()) log(`warning: token belongs to a different user than ${LOGIN}`);

  const repos = await listRepositories(token);
  knownNames = [...new Set(repos.flatMap((r) => [r.nameWithOwner, r.name]))].sort((a, b) => b.length - a.length);
  const candidates = repos.filter((r) => !r.isFork);
  log(`repositories: ${repos.length} accessible, ${candidates.length} non-fork`);

  const { active, unreadable } = await reposWithCommits(token, candidates, viewer.id, since, until);
  log(`repositories with commits in the window: ${active.length}${unreadable ? ` (${unreadable} unreadable, skipped)` : ""}`);

  let commitsSeen = 0;
  for (const repo of active) {
    let after = null;
    do {
      const history = await historyPage(token, repo, viewer.id, since, until, after);
      for (const commit of history.nodes) {
        const bucket = months.get(monthKey(new Date(commit.committedDate)));
        if (!bucket) continue;
        commitsSeen++;
        bucket.commits++;
        if (commit.parents.totalCount > 1) bucket.mergeCommits++;
        else if (commit.additions + commit.deletions > MAX_LINES_PER_COMMIT) bucket.largeCommits++;
        else {
          bucket.additions += commit.additions;
          bucket.deletions += commit.deletions;
        }
      }
      after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (after);
  }
  log(`commits read: ${commitsSeen}`);

  for (const w of windows) {
    const end = new Date(Math.min(w.untilDate, now) - 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const range = `created:${w.since}..${end}`;
    const data = await gql(
      token,
      `query($opened: String!, $merged: String!) {
        opened: search(query: $opened, type: ISSUE, first: 0) { issueCount }
        merged: search(query: $merged, type: ISSUE, first: 0) { issueCount }
      }`,
      { opened: `is:pr author:${LOGIN} ${range}`, merged: `is:pr is:merged author:${LOGIN} ${range}` },
    );
    Object.assign(months.get(w.key), { prsOpened: data.opened.issueCount, prsMerged: data.merged.issueCount });
  }
  log("pull request counts: done");

  return summarize([...months.values()], now);
}

export function summarize(months, now) {
  const sum = (field) => months.reduce((total, m) => total + m[field], 0);
  return {
    updated: localDate(now),
    timeZone: TIME_ZONE,
    maxLinesPerCommit: MAX_LINES_PER_COMMIT,
    months,
    totals: {
      commits: sum("commits"),
      additions: sum("additions"),
      deletions: sum("deletions"),
      linesChanged: sum("additions") + sum("deletions"),
      mergeCommits: sum("mergeCommits"),
      largeCommits: sum("largeCommits"),
      prsOpened: sum("prsOpened"),
      prsMerged: sum("prsMerged"),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Rendering

export const THEMES = {
  light: { fg: "#1f2328", muted: "#59636e", rule: "#d1d9e0", band: "#818b98", added: "#1a7f37", deleted: "#cf222e", commits: "#0969da", prs: "#8250df" },
  dark: { fg: "#f0f6fc", muted: "#9198a1", rule: "#3d444d", band: "#9198a1", added: "#3fb950", deleted: "#f85149", commits: "#4493f8", prs: "#ab7df8" },
};

export function compact(n) {
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) {
      const value = n / size;
      const digits = value >= 100 ? 0 : 1;
      return `${Number(value.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(n));
}

const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const r1 = (n) => Math.round(n * 10) / 10;

const W = 800;
const PAD_X = 16;
const PANEL = { header: 18, headroom: 16, plot: 72, gap: 20 };

export function renderSvg(stats, themeName) {
  const t = THEMES[themeName];
  const { months, totals } = stats;
  const slot = (W - 2 * PAD_X) / months.length;
  const barWidth = Math.round(slot * 0.56);
  const x = (i) => PAD_X + i * slot;

  const panels = [
    {
      title: "Lines changed",
      total: totals.linesChanged,
      legend: [[t.added, "added", totals.additions], [t.deleted, "deleted", totals.deletions]],
      segments: (m) => [[m.additions, t.added], [m.deletions, t.deleted]],
    },
    { title: "Commits", total: totals.commits, legend: [], segments: (m) => [[m.commits, t.commits]] },
    {
      title: "Pull requests opened",
      total: totals.prsOpened,
      legend: [[t.prs, "merged", totals.prsMerged], [t.prs, "not merged", totals.prsOpened - totals.prsMerged, 0.35]],
      segments: (m) => [[m.prsMerged, t.prs], [m.prsOpened - m.prsMerged, t.prs, 0.35]],
    },
  ];

  const font = `font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  const out = [];
  const top = 58;
  const panelHeight = PANEL.header + PANEL.headroom + PANEL.plot;
  const plotBottom = (p) => top + p * (panelHeight + PANEL.gap) + panelHeight;
  const axisY = plotBottom(panels.length - 1);
  const partialIndex = months.findIndex((m) => m.partial);

  if (partialIndex >= 0) {
    const bandX = x(partialIndex) + 2;
    out.push(`<rect x="${r1(bandX)}" y="${top - 6}" width="${r1(slot - 4)}" height="${axisY + 36 - (top - 6)}" rx="6" fill="${t.band}" fill-opacity="0.12"/>`);
  }

  out.push(`<text x="${PAD_X}" y="28" font-size="17" font-weight="600" fill="${t.fg}">Monthly activity, last 12 months</text>`);

  panels.forEach((panel, p) => {
    const headerY = top + p * (panelHeight + PANEL.gap) + 12;
    const base = plotBottom(p);
    // Legend follows the total on the left, so it never collides with the partial-month band or the right edge.
    const legend = panel.legend
      .map(([color, label, value, opacity]) => `<tspan dx="14" font-size="12" fill="${color}"${opacity ? ` fill-opacity="${opacity}"` : ""}>■</tspan><tspan dx="4" font-size="12">${label} ${compact(value)}</tspan>`)
      .join("");
    out.push(
      `<text x="${PAD_X}" y="${headerY}" font-size="13" fill="${t.muted}"><tspan font-weight="600" fill="${t.fg}">${escapeXml(panel.title)}</tspan><tspan dx="8">${compact(panel.total)} total</tspan>${legend}</text>`,
    );
    out.push(`<line x1="${PAD_X}" x2="${W - PAD_X}" y1="${base + 0.5}" y2="${base + 0.5}" stroke="${t.rule}"/>`);

    const totalsByMonth = months.map((m) => panel.segments(m).reduce((s, [v]) => s + v, 0));
    const max = Math.max(...totalsByMonth, 1);
    months.forEach((m, i) => {
      const bx = r1(x(i) + (slot - barWidth) / 2);
      let y = base;
      for (const [value, color, opacity] of panel.segments(m)) {
        if (value <= 0) continue;
        const h = Math.max((value / max) * PANEL.plot, 1);
        y -= h;
        out.push(`<rect x="${bx}" y="${r1(y)}" width="${barWidth}" height="${r1(h)}" fill="${color}"${opacity ? ` fill-opacity="${opacity}"` : ""}/>`);
      }
      out.push(`<text x="${r1(x(i) + slot / 2)}" y="${r1(y - 4)}" font-size="11" text-anchor="middle" fill="${totalsByMonth[i] ? t.fg : t.muted}">${compact(totalsByMonth[i])}</text>`);
    });
  });

  months.forEach((m, i) => {
    const [year, month] = m.month.split("-").map(Number);
    const cx = r1(x(i) + slot / 2);
    const notes = [];
    if (i === 0 || month === 1) notes.push(String(year));
    if (m.partial) notes.push("partial");
    out.push(`<text x="${cx}" y="${axisY + 16}" font-size="11" text-anchor="middle" fill="${t.fg}">${MONTH_NAMES[month - 1]}</text>`);
    if (notes.length) out.push(`<text x="${cx}" y="${axisY + 29}" font-size="10" text-anchor="middle" fill="${t.muted}">${notes.join(" · ")}</text>`);
  });

  const excluded = totals.largeCommits;
  const footY = axisY + 56;
  out.push(
    `<text x="${PAD_X}" y="${footY}" font-size="11" fill="${t.muted}">Lines exclude merge commits and commits over ${compact(MAX_LINES_PER_COMMIT)} changed lines (${excluded} ${excluded === 1 ? "commit" : "commits"} left out). Commits: default branches.</text>`,
    `<text x="${PAD_X}" y="${footY + 17}" font-size="11" fill="${t.muted}">Includes private contributions (aggregated) · updated ${stats.updated}</text>`,
  );

  const height = footY + 28;
  const label = `Monthly activity over the last 12 months: ${compact(totals.linesChanged)} lines changed, ${compact(totals.commits)} commits, ${compact(totals.prsOpened)} pull requests opened.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${escapeXml(label)}" ${font}>
<title>${escapeXml(label)}</title>
${out.join("\n")}
</svg>
`;
}

export function renderJson(stats) {
  return `${JSON.stringify(stats, null, 2)}\n`;
}

export function renderAll(stats) {
  return {
    "activity-light.svg": renderSvg(stats, "light"),
    "activity-dark.svg": renderSvg(stats, "dark"),
    "activity.json": renderJson(stats),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Privacy check

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Returns the names found in the outputs. A name that the renderer also emits with all-zero data (e.g. a repo
// called "commits") comes from the template, not from fetched data, so it doesn't count as a leak.
export function findLeaks(outputs, names, now = new Date()) {
  const template = Object.values(renderAll(summarize(monthWindows(now).map(emptyMonth), now))).join("\n");
  const leaks = new Set();
  for (const name of names) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(name)}($|[^A-Za-z0-9_-])`, "i");
    if (!name.includes("/") && pattern.test(template)) continue;
    for (const [file, text] of Object.entries(outputs)) if (pattern.test(text)) leaks.add(`${file}: one repo name`);
  }
  return [...leaks];
}

// ---------------------------------------------------------------------------------------------------------

async function check(token, dir) {
  const repos = await listRepositories(token);
  knownNames = [...new Set(repos.flatMap((r) => [r.nameWithOwner, r.name]))].sort((a, b) => b.length - a.length);
  const files = (await readdir(dir)).filter((f) => /\.(svg|json)$/.test(f));
  const outputs = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(join(dir, f), "utf8")])));
  const leaks = findLeaks(outputs, knownNames);
  if (leaks.length) {
    console.error(`privacy check FAILED (${leaks.length} hits):\n${leaks.join("\n")}`);
    process.exit(1);
  }
  log(`privacy check passed: ${files.length} files, ${knownNames.length} repo names checked`);
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.METRICS_TOKEN;
  if (!token) throw new Error("set GH_TOKEN or METRICS_TOKEN");
  const checkIndex = process.argv.indexOf("--check");
  if (checkIndex > 0) return check(token, process.argv[checkIndex + 1] ?? "metrics");
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : "metrics";

  const now = new Date();
  const stats = await collect(token, now);
  const { totals } = stats;
  log(`totals: ${totals.linesChanged} lines (+${totals.additions} -${totals.deletions}), ${totals.commits} commits, ${totals.prsOpened} PRs opened, ${totals.prsMerged} merged`);
  log(`lines exclusions: ${totals.mergeCommits} merge commits, ${totals.largeCommits} commits over ${MAX_LINES_PER_COMMIT} lines`);

  const outputs = renderAll(stats);
  const leaks = findLeaks({ ...outputs, log: logLines.join("\n") }, knownNames, now);
  if (leaks.length) {
    console.error(`privacy check FAILED, nothing written (${leaks.length} hits):\n${leaks.join("\n")}`);
    process.exit(1);
  }
  log(`privacy check passed (${knownNames.length} repo names checked)`);

  await mkdir(outDir, { recursive: true });
  for (const [file, content] of Object.entries(outputs)) await writeFile(join(outDir, file), content);
  log(`wrote ${Object.keys(outputs).length} files to ${outDir}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${redact(error.message)}`);
    process.exit(1);
  });
}
