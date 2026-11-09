import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const publicFiles = new Set(['index.html', 'help.html', 'app.js', 'styles.css', 'favicon.svg', 'src/data/github-data.js', 'src/data/history.js', 'src/data/star-activity.js', 'src/data/repository-state.js', 'src/data/star-activity.json', 'src/data/github-snapshot.json', 'src/data/star-history.json']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
// Text assets compress ~6-15x; binary (none here) would be skipped.
const COMPRESSIBLE = new Set(['.json', '.js', '.css', '.html', '.svg']);
// Cache keyed by path+mtime so collector overwrites produce a fresh gzip.
const gzipCache = new Map();

function maybeGzip(buffer, path, mtimeMs, acceptEncoding) {
  if (!COMPRESSIBLE.has(extname(path).toLowerCase())) return { buffer, headers: {} };
  if (!/\bgzip\b/.test(acceptEncoding || '')) return { buffer, headers: {} };
  const key = `${path}:${mtimeMs}`;
  const cached = gzipCache.get(key);
  if (cached) return { buffer: cached, headers: { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } };
  // Drop stale entries for this path to keep memory bounded.
  for (const staleKey of gzipCache.keys()) if (staleKey.startsWith(`${path}:`)) gzipCache.delete(staleKey);
  const gz = gzipSync(buffer, { level: 6 });
  const chosen = gz.length < buffer.length ? gz : buffer;
  if (chosen === gz) {
    gzipCache.set(key, gz);
    return { buffer: gz, headers: { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } };
  }
  return { buffer, headers: { Vary: 'Accept-Encoding' } };
}

let collecting = false;
const collectionInterval = 2 * 60 * 60 * 1000;
async function collectIfDue() {
  if (collecting || process.env.GITHUB_PULSE_AUTOSYNC !== '1') return;
  try {
    const saved = JSON.parse(await readFile(resolve(root, 'src/data/github-snapshot.json'), 'utf8'));
    const last = Date.parse(saved.sync?.startedAt || saved.fetchedAt || '');
    if (Number.isFinite(last) && Date.now() - last < collectionInterval) return;
  } catch { /* The collector will report a malformed or unavailable snapshot. */ }
  collecting = true;
  const child = spawn(process.execPath, [resolve(root, 'scripts/sync-scheduled.mjs'), '--profile', 'hot', '--budget', '800', '--translate-limit', '0'], { cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', (error) => { collecting = false; console.error(`Background collection could not start: ${error.message}`); });
  child.once('exit', (code) => { collecting = false; if (code) console.warn('Background collection did not complete; saved observations are retained.'); });
}
// Server lifetime owns local collection; closing the server stops future runs.
// No system task or credential is installed. Existing API budgets still apply.
setInterval(collectIfDue, collectionInterval).unref();
createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); return response.end(); }
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const path = resolve(root, name);
    if (!path.startsWith(root + sep) || !publicFiles.has(name)) { response.writeHead(404); return response.end('Not found'); }
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Not a file');
    const raw = await readFile(path);
    const acceptEncoding = request.headers['accept-encoding'] || '';
    const { buffer, headers: encHeaders } = maybeGzip(raw, path, info.mtimeMs, acceptEncoding);
    response.writeHead(200, {
      'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...encHeaders,
    });
    response.end(request.method === 'HEAD' ? undefined : buffer);
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, '127.0.0.1', () => { console.log(`GitHub Pulse: http://localhost:${port}`); collectIfDue(); });
