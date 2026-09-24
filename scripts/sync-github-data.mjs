// Sync curated seed stats (stars / forks / open issues) with live GitHub data.
//
// Each run records the day's totals in src/data/star-history.json; once
// baselines exist, the today / week / month star deltas in the seeds are
// recomputed as real diffs (7/30-day deltas become fully real after the
// script has run daily for 7 / 30 days).
//
// Usage: node scripts/sync-github-data.mjs [--dry] [--limit N]
//   --dry     print what would change, write nothing
//   --limit N only sync the first N seeded repos (useful for testing)
// Token: set GITHUB_TOKEN to raise the limit from ~60 to 5000 requests/hour;
// without it the script stops when the unauthenticated budget is spent and
// picks up where it left on the next run.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'src', 'data', 'github-data.js');
const HISTORY_FILE = join(ROOT, 'src', 'data', 'star-history.json');
const DRY = process.argv.includes('--dry');
const limitAt = process.argv.indexOf('--limit');
const LIMIT = limitAt > -1 ? Number(process.argv[limitAt + 1]) : Infinity;
const DAY_MS = 24 * 3600 * 1000;
const today = new Date().toISOString().slice(0, 10);

const resolveToken = () => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const TOKEN = resolveToken();
if (!TOKEN) console.log('note: no GITHUB_TOKEN, unauthenticated budget is ~60 repos/hour');

// --- parse the seeds block by evaluating the array literal (same values the module sees)
const source = readFileSync(DATA_FILE, 'utf8');
const start = source.indexOf('const PROJECT_SEEDS = [');
if (start < 0) throw new Error('PROJECT_SEEDS not found');
const open = source.indexOf('[', start);
const close = source.indexOf('\n];', open);
if (open < 0 || close < 0) throw new Error('PROJECT_SEEDS boundaries not found');
const blockText = source.slice(open, close);
const seeds = Function(`'use strict'; return (${blockText}\n]);`)();
if (!Array.isArray(seeds) || seeds.some((seed) => !Array.isArray(seed) || seed.length !== 14)) {
  throw new Error('unexpected seed shape (need 14 fields per seed)');
}

// --- snapshot history, pruned to a 40-day window (covers the 30-day delta)
let history = {};
try {
  history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
} catch { /* first run */ }
for (const [name, entries] of Object.entries(history)) {
  const kept = Object.fromEntries(Object.entries(entries)
    .filter(([date]) => new Date(today) - new Date(date) <= 40 * DAY_MS));
  if (Object.keys(kept).length) history[name] = kept;
  else delete history[name];
}

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'github-pulse-seed-sync' };
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

const targets = Number.isFinite(LIMIT) ? seeds.slice(0, LIMIT) : seeds;
const modified = new Set();
const changes = [];
const errors = [];
let remaining = Infinity;

for (let index = 0; index < targets.length; index += 1) {
  if (remaining <= 1) {
    console.log(`stopping at ${index}/${targets.length}: rate limit nearly exhausted, next run continues`);
    break;
  }
  const seed = targets[index];
  const [owner, repo] = seed[0].split('/');
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    remaining = Number(response.headers.get('x-ratelimit-remaining') ?? remaining);
    if (response.status === 404) {
      errors.push(`${seed[0]}: not found (deleted or renamed)`);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const prev = { stars: seed[5], forks: seed[6], issues: seed[10] };
    seed[5] = data.stargazers_count ?? seed[5];
    seed[6] = data.forks_count ?? seed[6];
    seed[10] = data.open_issues_count ?? seed[10];
    if (data.license?.spdx_id) seed[11] = data.license.spdx_id;
    modified.add(index);

    const log = (history[seed[0]] ||= {});
    const firstToday = log[today];
    log[today] = seed[5];
    const deltaFrom = (targetDays) => {
      const candidates = Object.entries(log)
        .filter(([date, stars]) => date !== today && stars != null && (new Date(today) - new Date(date)) >= DAY_MS);
      if (!candidates.length) return null;
      const [, base] = candidates.sort((a, b) =>
        Math.abs((new Date(today) - new Date(a[0])) / DAY_MS - targetDays)
        - Math.abs((new Date(today) - new Date(b[0])) / DAY_MS - targetDays))[0];
      return Math.max(0, seed[5] - base);
    };
    // First-ever run for a repo only records the baseline; deltas turn real afterwards.
    if (firstToday !== undefined) seed[7] = Math.max(0, seed[5] - firstToday);
    const week = deltaFrom(7);
    const month = deltaFrom(30);
    if (week !== null) seed[8] = week;
    if (month !== null) seed[9] = month;

    if (seed[5] !== prev.stars || seed[6] !== prev.forks || seed[10] !== prev.issues) {
      changes.push(`${seed[0]}: ★${prev.stars}→${seed[5]}, forks ${prev.forks}→${seed[6]}, issues ${prev.issues}→${seed[10]}`);
    }
  } catch (error) {
    errors.push(`${seed[0]}: ${error.message}`);
  }
}

// --- regenerate the block byte-identically for untouched lines (abort on drift)
const jsString = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\x00-\x1f]/g, ' ')}'`;
const emitSeed = (seed) => `  [${jsString(seed[0])}, ${jsString(seed[1])}, ${jsString(seed[2])}, '${seed[3]}', ${jsString(seed[4])}, ${seed[5]}, ${seed[6]}, ${seed[7]}, ${seed[8]}, ${seed[9]}, ${seed[10]}, ${jsString(seed[11])}, [${seed[12].map(jsString).join(', ')}], ${jsString(seed[13])}],`;
const originalLines = blockText.split('\n');
const nextLines = [];
let cursor = 0;
for (const line of originalLines) {
  // comment / blank / opening-bracket lines pass through untouched
  if (line === '[' || line.trim() === '' || line.trimStart().startsWith('//')) {
    nextLines.push(line);
    continue;
  }
  nextLines.push(emitSeed(seeds[cursor]));
  if (!modified.has(cursor) && nextLines[nextLines.length - 1] !== line) {
    throw new Error(`formatting drift on untouched seed #${cursor}:\n- ${line}\n+ ${nextLines[nextLines.length - 1]}\nrefusing to rewrite the file`);
  }
  cursor += 1;
}
if (cursor !== seeds.length) throw new Error(`line/seed mismatch: ${cursor} seeds consumed of ${seeds.length}`);

let next = '';
if (DRY) {
  console.log(`\n[--dry] ${modified.size} repos would be re-baselined, ${changes.length} with changed stats:`);
} else {
  next = source.slice(0, open) + nextLines.join('\n') + source.slice(close);
  next = next.replace(/(真实数据快照 )\d{4}-\d{2}-\d{2}/, `$1${today}`);
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, DATA_FILE);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
  console.log(`synced ${modified.size} repos, ${changes.length} with changed stats:`);
}
changes.forEach((line) => console.log('  ' + line));
if (errors.length) errors.forEach((line) => console.warn('  ! ' + line));
console.log(`rate limit remaining: ${remaining === Infinity ? 'unknown' : remaining}${DRY ? ' (nothing written)' : ` | history: ${HISTORY_FILE}`}`);
exitSoon(0);

// Node on Git Bash can hit a libuv teardown assertion (UV_HANDLE_CLOSING) when
// stdout is an MSYS pipe; exiting explicitly after a short flush grace avoids
// a bogus non-zero exit code in scheduled runs.
function exitSoon(code) {
  setTimeout(() => process.exit(code), 100);
}
