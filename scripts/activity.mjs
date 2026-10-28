#!/usr/bin/env node
// Monthly activity chart for the profile README (last 12 months, current month partial).
//
// Data comes from the GitHub GraphQL API using a token with `repo` + `read:org` (GH_TOKEN or METRICS_TOKEN):
//   - commits + lines: the user's commits on the default branch and long-lived branches (EXTRA_BRANCHES) of
//     every accessible non-fork repo, deduplicated by SHA (rebased/cherry-picked copies by author date + message)
//     (contributionsCollection reports most org contributions only as "restricted", so it can't be used)
//   - pull requests: search issueCount for `is:pr author:<login> created:<month>` (and `is:merged`)
//
// Privacy: only monthly aggregates are ever written or logged. Every repo name seen during the fetch is
// checked against the outputs (and log lines) before anything is written; a hit aborts the run.
//
// Usage: node scripts/activity.mjs [--out metrics]   fetch, check, write
//        node scripts/activity.mjs --check [metrics]  re-check files already written (fetches repo names only)
//        node scripts/activity.mjs --from-json metrics/activity.json [--out metrics]
//                                                      re-render from saved aggregates, no token or fetch;
//                                                      run --check afterwards to verify the outputs

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

let apiCalls = 0;
let rateLimitUsed = []; // [first, last] x-ratelimit-used seen in this run

async function gql(token, query, variables = {}, maxAttempts = MAX_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let wait = Math.min(2 ** attempt * 1000, 60_000);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": `${LOGIN}-activity` },
        body: JSON.stringify({ query, variables }),
      });
      apiCalls++;
      const used = Number(res.headers.get("x-ratelimit-used"));
      if (used) rateLimitUsed = [rateLimitUsed[0] ?? used, used];
      if (res.status === 401) throw Object.assign(new Error("401 Unauthorized: check the token"), { fatal: true, status: 401 });
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
    if (attempt < maxAttempts) {
      wait = Math.min(wait, MAX_WAIT_MS);
      log(`  retry ${attempt}/${maxAttempts - 1} in ${Math.round(wait / 1000)}s (${redact(lastError.message)})`);
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
const COMMIT_FIELDS = "id oid committedDate authoredDate messageHeadline parents { totalCount }";

// Runs one aliased query per batch; aliases that fail (e.g. an unreadable repo) come back as null.
async function batched(token, items, size, field, variables, varDefs) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const query = `query(${varDefs}) { ${batch.map((item, j) => `a${j}: ${field(item)}`).join("\n")} }`;
    let data;
    try {
      data = await gql(token, query, variables);
    } catch (error) {
      if (error.status === 401) throw error;
      if (!error.data && batch.length > 1) {
        results.push(...(await batched(token, batch, 1, field, variables, varDefs))); // too heavy together
        continue;
      }
      data = error.data; // partial result, or one item that keeps failing: skipped as unreadable
    }
    batch.forEach((item, j) => results.push([item, data?.[`a${j}`] ?? null]));
  }
  return results;
}

// Branches counted besides each repo's default branch, when they exist. Feature branches are left out on
// purpose: there are thousands of them, and their work reaches these branches anyway (squash-merged work
// would otherwise be counted twice). Exact names, plus prefixes for families like release/1.2.
export const EXTRA_BRANCHES = ["beta", "develop", "development", "dev", "staging", "stage", "homolog", "homologacao", "main", "master"];
export const EXTRA_BRANCH_PREFIXES = ["release"];

// The default branch plus the long-lived branches above, if their tip was committed inside the window
// (an older tip cannot contain window commits).
async function longLivedBranches(token, repos, since) {
  const sinceDate = new Date(since);
  const tip = "id target { ... on Commit { oid committedDate } }";
  const field = (repo) => `node(id: ${JSON.stringify(repo.id)}) { ... on Repository {
    defaultBranchRef { ${tip} }
    ${EXTRA_BRANCHES.map((name, k) => `b${k}: ref(qualifiedName: ${JSON.stringify(`refs/heads/${name}`)}) { ${tip} }`).join("\n")}
    ${EXTRA_BRANCH_PREFIXES.map((prefix, k) => `p${k}: refs(refPrefix: "refs/heads/", query: ${JSON.stringify(prefix)}, first: 50) { nodes { name ${tip} } }`).join("\n")}
  } }`;
  const branches = [];
  let unreadable = 0;
  for (const [repo, node] of await batched(token, repos, 10, field, {}, "")) {
    if (!node) {
      unreadable++;
      continue;
    }
    const refs = [node.defaultBranchRef, ...EXTRA_BRANCHES.map((_, k) => node[`b${k}`])];
    EXTRA_BRANCH_PREFIXES.forEach((prefix, k) => refs.push(...(node[`p${k}`]?.nodes ?? []).filter((r) => r.name.startsWith(prefix))));
    const seen = new Set();
    for (const ref of refs) {
      if (!ref?.target?.committedDate || seen.has(ref.id) || new Date(ref.target.committedDate) < sinceDate) continue;
      seen.add(ref.id);
      branches.push({ repo, id: ref.id });
    }
  }
  return { branches, unreadable };
}

// One page of the user's commits on a branch. Long histories filtered by author can time out (HTTP 502), so a
// failing page is retried with fewer attempts at smaller sizes before giving up.
const HISTORY_PAGE_SIZES = [100, 50, 25];
async function historyPage(token, branchId, authorId, since, until, after) {
  let lastError;
  for (const [k, size] of HISTORY_PAGE_SIZES.entries()) {
    try {
      const data = await gql(
        token,
        `query($id: ID!, $author: ID!, $since: GitTimestamp!, $until: GitTimestamp!, $after: String) {
          node(id: $id) { ... on Ref { target { ... on Commit { history(first: ${size}, after: $after, ${historyArgs}) {
            pageInfo { hasNextPage endCursor } nodes { ${COMMIT_FIELDS} } } } } } }
        }`,
        { id: branchId, author: authorId, since, until, after },
        k === HISTORY_PAGE_SIZES.length - 1 ? MAX_ATTEMPTS : 3,
      );
      return data.node?.target?.history ?? { nodes: [], pageInfo: { hasNextPage: false } };
    } catch (error) {
      if (error.status === 401) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// The user's commits on the selected branches, deduplicated by SHA. A rebased or cherry-picked copy of a
// commit gets a new SHA but keeps its author date and message, so copies inside one repo are deduplicated by
// that pair too (hashed, kept in memory only). A branch that can't be read fails the run rather than
// silently undercounting.
async function branchCommits(token, branches, authorId, since, until) {
  const commits = new Map(); // oid -> commit, or null for a dropped copy
  const copies = new Set(); // repo id + hash(author date, headline)
  const stats = { branches: 0, listed: 0, copies: 0 };
  const add = (repo, c) => {
    stats.listed++;
    if (commits.has(c.oid)) return;
    const key = `${repo.id}:${createHash("sha256").update(`${c.authoredDate}\n${c.messageHeadline}`).digest("hex")}`;
    if (copies.has(key)) {
      stats.copies++;
      commits.set(c.oid, null);
      return;
    }
    copies.add(key);
    commits.set(c.oid, { id: c.id, committedDate: c.committedDate, merge: c.parents.totalCount > 1 });
  };

  for (const branch of branches) {
    let after = null;
    let found = 0;
    do {
      const history = await historyPage(token, branch.id, authorId, since, until, after);
      history.nodes.forEach((c) => add(branch.repo, c));
      found += history.nodes.length;
      after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (after);
    if (found) stats.branches++;
  }
  return { commits: [...commits.values()].filter(Boolean), stats };
}

// additions/deletions for each commit; big diffs can time out, so failed batches are retried smaller.
async function lineStats(token, commits) {
  const result = new Map();
  let failed = 0;
  const fetchBatch = async (batch, sizes) => {
    try {
      const data = await gql(token, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Commit { id additions deletions } } }`, { ids: batch.map((c) => c.id) }, sizes.length ? 2 : MAX_ATTEMPTS);
      data.nodes.filter(Boolean).forEach((n) => result.set(n.id, n));
    } catch (error) {
      if (error.status === 401) throw error;
      error.data?.nodes?.filter(Boolean).forEach((n) => result.set(n.id, n));
      const missing = batch.filter((c) => !result.has(c.id));
      if (!sizes.length) {
        failed += missing.length;
        return;
      }
      const [size, ...rest] = sizes;
      for (let i = 0; i < missing.length; i += size) await fetchBatch(missing.slice(i, i + size), rest);
    }
  };
  for (let i = 0; i < commits.length; i += 50) await fetchBatch(commits.slice(i, i + 50), [10, 1]);
  return { result, failed };
}

function emptyMonth(window) {
  return { month: window.key, partial: window.partial, commits: 0, additions: 0, deletions: 0, mergeCommits: 0, largeCommits: 0, prsOpened: 0, prsMerged: 0 };
}

export async function collect(token, now = new Date()) {
  const windows = monthWindows(now);
  const months = new Map(windows.map((w) => [w.key, emptyMonth(w)]));
  const since = windows[0].since;
  const until = now.toISOString();

  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const viewer = (await gql(token, "{ viewer { id login } }")).viewer;
  if (viewer.login.toLowerCase() !== LOGIN.toLowerCase()) log(`warning: token belongs to a different user than ${LOGIN}`);

  const repos = await listRepositories(token);
  knownNames = [...new Set(repos.flatMap((r) => [r.nameWithOwner, r.name]))].sort((a, b) => b.length - a.length);
  const candidates = repos.filter((r) => !r.isFork);
  log(`repositories: ${repos.length} accessible, ${candidates.length} non-fork`);

  const { branches, unreadable } = await longLivedBranches(token, candidates, since);
  log(`branches to read: ${branches.length} (default + long-lived, tip inside the window)${unreadable ? `; ${unreadable} repos unreadable, skipped` : ""} [${elapsed()}]`);

  const { commits, stats } = await branchCommits(token, branches, viewer.id, since, until);
  log(`commits: ${stats.listed} listed on ${stats.branches} branches, ${commits.length} unique (${stats.copies} rebased/cherry-picked copies dropped) [${elapsed()}]`);

  const { result: lines, failed } = await lineStats(token, commits.filter((c) => !c.merge));
  log(`line stats read [${elapsed()}]${failed ? `; unavailable for ${failed} commits (counted as commits only)` : ""}`);

  for (const commit of commits) {
    const bucket = months.get(monthKey(new Date(commit.committedDate)));
    if (!bucket) continue;
    bucket.commits++;
    const stat = lines.get(commit.id);
    if (commit.merge) bucket.mergeCommits++;
    else if (!stat) continue;
    else if (stat.additions + stat.deletions > MAX_LINES_PER_COMMIT) bucket.largeCommits++;
    else {
      bucket.additions += stat.additions;
      bucket.deletions += stat.deletions;
    }
  }

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
  log(`pull request counts read [${elapsed()}]`);
  const points = rateLimitUsed.length === 2 && rateLimitUsed[1] >= rateLimitUsed[0] ? `, ~${rateLimitUsed[1] - rateLimitUsed[0] + 1} rate-limit points` : "";
  log(`API calls: ${apiCalls}${points}`);

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

// Series colors are validated for color-vision deficiency in pairs (added/deleted, opened/merged) against
// GitHub's light (#ffffff) and dark (#0d1117) page backgrounds. `surface` is only used for the halo behind
// value labels and the ring around markers; the SVG background itself stays transparent.
export const THEMES = {
  light: { fg: "#1f2328", muted: "#59636e", grid: "#d1d9e0", band: "#818b98", surface: "#ffffff", total: "#818b98", added: "#1a7f37", deleted: "#bf3989", commits: "#0969da", opened: "#1a7f37", merged: "#8250df" },
  dark: { fg: "#f0f6fc", muted: "#9198a1", grid: "#3d444d", band: "#9198a1", surface: "#0d1117", total: "#656c76", added: "#2ea043", deleted: "#db61a2", commits: "#4493f8", opened: "#2ea043", merged: "#a371f7" },
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
const PLOT_LEFT = 52; // room for y-axis tick labels
const PLOT_RIGHT = W - 28;
const PANEL = { header: 16, headroom: 22, plot: 96, gap: 26 };
const LABEL = { size: 11, charWidth: 6.4, height: 12 }; // generous width estimate so collision checks err safe

// Round axis maximum and step (1/2/2.5/5 x 10^k) with at most 5 intervals.
function niceScale(max) {
  if (max <= 0) return { top: 1, step: 1 };
  const pow = 10 ** Math.floor(Math.log10(max / 5));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => max / s <= 5);
  return { top: Math.ceil(max / step) * step, step };
}

// Indices worth a value label, most important first: last (the partial month), peak and low of the complete
// months, and the first month.
function keyPoints(values, partialIndex) {
  const complete = partialIndex >= 0 ? values.slice(0, partialIndex) : values;
  const last = values.length - 1;
  const max = complete.indexOf(Math.max(...complete));
  const min = complete.indexOf(Math.min(...complete));
  return [...new Set([last, max, min, 0])];
}

const overlaps = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

export function renderSvg(stats, themeName) {
  const t = THEMES[themeName];
  const { months, totals } = stats;
  const n = months.length;
  const slot = (PLOT_RIGHT - PLOT_LEFT) / n;
  const x = (i) => PLOT_LEFT + slot * (i + 0.5);
  const partialIndex = months.findIndex((m) => m.partial);

  const panels = [
    {
      title: "Lines changed",
      total: totals.linesChanged,
      series: [
        { label: "total", color: t.total, values: months.map((m) => m.additions + m.deletions), faint: true },
        { label: "added", color: t.added, values: months.map((m) => m.additions), legendValue: totals.additions },
        { label: "deleted", color: t.deleted, values: months.map((m) => m.deletions), legendValue: totals.deletions },
      ],
    },
    { title: "Commits", total: totals.commits, series: [{ label: "commits", color: t.commits, values: months.map((m) => m.commits) }] },
    {
      title: "Pull requests opened",
      total: totals.prsOpened,
      series: [
        { label: "opened", color: t.opened, values: months.map((m) => m.prsOpened) },
        { label: "merged", color: t.merged, values: months.map((m) => m.prsMerged), legendValue: totals.prsMerged },
      ],
    },
  ];

  const top = 50;
  const panelHeight = PANEL.header + PANEL.headroom + PANEL.plot;
  const panelTop = (p) => top + p * (panelHeight + PANEL.gap);
  const axisY = panelTop(panels.length - 1) + panelHeight;
  const back = []; // band, grid
  const lines = [];
  const marks = [];
  const labels = [];

  if (partialIndex >= 0) {
    back.push(`<rect x="${r1(x(partialIndex) - slot / 2 + 2)}" y="${top + PANEL.header + 4}" width="${r1(slot - 4)}" height="${r1(axisY + 34 - (top + PANEL.header + 4))}" rx="6" fill="${t.band}" fill-opacity="0.12"/>`);
  }

  panels.forEach((panel, p) => {
    const headerY = panelTop(p) + 12;
    const plotTop = panelTop(p) + PANEL.header + PANEL.headroom;
    const base = plotTop + PANEL.plot;
    const { top: yTop, step } = niceScale(Math.max(...panel.series.flatMap((s) => s.values)));
    const y = (v) => base - (v / yTop) * PANEL.plot;

    // Header: title, 12-month total, then a line-key legend when there is more than one series.
    const legend = panel.series.length > 1
      ? panel.series
          .map((s) => {
            const key = `<tspan dx="16" font-size="12" fill="${s.color}"${s.faint ? ' fill-opacity="0.8"' : ""}>${s.faint ? "┅" : "━"}</tspan>`;
            return `${key}<tspan dx="4" font-size="12">${s.label}${s.legendValue !== undefined ? ` ${compact(s.legendValue)}` : ""}</tspan>`;
          })
          .join("")
      : "";
    back.push(`<text x="${PAD_X}" y="${headerY}" font-size="13" fill="${t.muted}"><tspan font-weight="600" fill="${t.fg}">${escapeXml(panel.title)}</tspan><tspan dx="8">${compact(panel.total)} total</tspan>${legend}</text>`);

    // Recessive y grid with compact ticks.
    for (let v = 0; v <= yTop + 1e-9; v += step) {
      const gy = r1(y(v)) + 0.5;
      back.push(`<line x1="${PLOT_LEFT}" x2="${PLOT_RIGHT}" y1="${gy}" y2="${gy}" stroke="${t.grid}" stroke-opacity="${v === 0 ? 1 : 0.6}"/>`);
      back.push(`<text x="${PLOT_LEFT - 8}" y="${r1(gy + 3.5)}" font-size="10" text-anchor="end" fill="${t.muted}">${compact(v)}</text>`);
    }

    // Lines: solid through complete months, dashed into the partial month.
    const solidEnd = partialIndex > 0 ? partialIndex : n;
    for (const s of panel.series) {
      const pts = s.values.map((v, i) => `${r1(x(i))},${r1(y(v))}`);
      const width = s.faint ? 1.5 : 2;
      const opacity = s.faint ? ' stroke-opacity="0.7"' : "";
      lines.push(`<polyline points="${pts.slice(0, solidEnd).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${opacity}/>`);
      if (partialIndex > 0) {
        lines.push(`<polyline points="${pts.slice(partialIndex - 1).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${width}" stroke-dasharray="4 4" stroke-linecap="round"${opacity}/>`);
      }
      if (s.faint) continue;
      s.values.forEach((v, i) => {
        const partial = i === partialIndex;
        // Ring in the page color keeps markers legible where lines cross; the partial month is hollow.
        marks.push(`<circle cx="${r1(x(i))}" cy="${r1(y(v))}" r="4" fill="${partial ? t.surface : s.color}" stroke="${partial ? s.color : t.surface}" stroke-width="2"/>`);
      });
    }

    // Value labels for the key points of each non-faint series. The upper series at a month labels above
    // its point, the lower one below; a label that would collide with another label or marker, or leave the
    // panel, tries the other side, then beside the point, then a bit farther out, and is dropped if every spot is taken.
    const drawn = panel.series.filter((s) => !s.faint);
    const boxes = [];
    const markerBoxes = drawn.flatMap((s) => s.values.map((v, i) => ({ x1: x(i) - 5, x2: x(i) + 5, y1: y(v) - 5, y2: y(v) + 5 })));
    // Lines are sampled into small boxes so labels avoid sitting on top of them. The faint total line may sit
    // under a label; the label's halo keeps it readable.
    const lineBoxes = drawn.flatMap((s) =>
      s.values.slice(1).flatMap((v, k) => {
        const [x0, y0, x1, y1] = [x(k), y(s.values[k]), x(k + 1), y(v)];
        const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3);
        return Array.from({ length: steps + 1 }, (_, j) => {
          const [px, py] = [x0 + ((x1 - x0) * j) / steps, y0 + ((y1 - y0) * j) / steps];
          return { x1: px - 1, x2: px + 1, y1: py - 1, y2: py + 1 };
        });
      }),
    );
    const wanted = drawn.flatMap((s) => keyPoints(s.values, partialIndex).map((i, rank) => ({ s, i, rank })));
    wanted.sort((a, b) => a.rank - b.rank);
    for (const { s, i } of wanted) {
      const v = s.values[i];
      const others = drawn.filter((o) => o !== s).map((o) => o.values[i]);
      const isUpper = others.every((o) => v >= o);
      const text = compact(v);
      const w = text.length * LABEL.charWidth;
      const box = (dx, dy, gap = 9) => {
        const cx = x(i) + dx * (w / 2 + 8);
        const baseline = y(v) + (dy < 0 ? -gap : dy > 0 ? gap + LABEL.height - 2 : 4);
        return { cx, x1: cx - w / 2, x2: cx + w / 2, y1: baseline - LABEL.height + 2, y2: baseline + 2, baseline };
      };
      const vertical = isUpper ? [-1, 1] : [1, -1];
      const candidates = [box(0, vertical[0]), box(0, vertical[1]), box(1, 0), box(-1, 0), box(0, vertical[0], 18), box(0, vertical[1], 18)];
      const fits = (b) =>
        b.y1 >= plotTop - PANEL.headroom + 4 && b.y2 <= base + (p < panels.length - 1 ? 14 : -1) && b.x1 >= PLOT_LEFT && b.x2 <= W - 4 &&
        [boxes, markerBoxes, lineBoxes].every((list) => !list.some((o) => overlaps(o, b)));
      const choice = candidates.find(fits);
      if (!choice) continue;
      boxes.push(choice);
      labels.push(`<text x="${r1(choice.cx)}" y="${r1(choice.baseline)}" font-size="${LABEL.size}" text-anchor="middle" fill="${t.fg}" stroke="${t.surface}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${text}</text>`);
    }
  });

  months.forEach((m, i) => {
    const [year, month] = m.month.split("-").map(Number);
    const cx = r1(x(i));
    const notes = [];
    if (i === 0 || month === 1) notes.push(String(year));
    if (m.partial) notes.push("partial");
    back.push(`<text x="${cx}" y="${axisY + 18}" font-size="11" text-anchor="middle" fill="${t.fg}">${MONTH_NAMES[month - 1]}</text>`);
    if (notes.length) back.push(`<text x="${cx}" y="${axisY + 30}" font-size="10" text-anchor="middle" fill="${t.muted}">${notes.join(" · ")}</text>`);
  });

  const excluded = totals.largeCommits;
  const footY = axisY + 56;
  back.push(
    `<text x="${PAD_X}" y="${footY}" font-size="11" fill="${t.muted}">Lines exclude merges and commits over ${compact(MAX_LINES_PER_COMMIT)} changed lines (${excluded} left out). Commits: default + long-lived branches, deduped.</text>`,
    `<text x="${PAD_X}" y="${footY + 17}" font-size="11" fill="${t.muted}">Includes private contributions (aggregated) · updated ${stats.updated}</text>`,
  );

  const height = footY + 28;
  const label = `Monthly activity over the last 12 months: ${compact(totals.linesChanged)} lines changed, ${compact(totals.commits)} commits, ${compact(totals.prsOpened)} pull requests opened.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${escapeXml(label)}" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">
<title>${escapeXml(label)}</title>
<text x="${PAD_X}" y="26" font-size="17" font-weight="600" fill="${t.fg}">Monthly activity, last 12 months</text>
${[...back, ...lines, ...marks, ...labels].join("\n")}
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

async function writeOutputs(outDir, outputs) {
  await mkdir(outDir, { recursive: true });
  for (const [file, content] of Object.entries(outputs)) await writeFile(join(outDir, file), content);
  log(`wrote ${Object.keys(outputs).length} files to ${outDir}/`);
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : "metrics";
  const jsonIndex = process.argv.indexOf("--from-json");
  if (jsonIndex > 0) {
    const stats = JSON.parse(await readFile(process.argv[jsonIndex + 1], "utf8"));
    return writeOutputs(outDir, renderAll(stats));
  }

  const token = process.env.GH_TOKEN || process.env.METRICS_TOKEN;
  if (!token) throw new Error("set GH_TOKEN or METRICS_TOKEN");
  const checkIndex = process.argv.indexOf("--check");
  if (checkIndex > 0) return check(token, process.argv[checkIndex + 1] ?? "metrics");

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

  await writeOutputs(outDir, outputs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${redact(error.message)}`);
    process.exit(1);
  });
}
