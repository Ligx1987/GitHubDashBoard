import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const publicFiles = new Set(['index.html', 'help.html', 'app.js', 'styles.css', 'favicon.svg', 'src/data/github-data.js', 'src/data/history.js', 'src/data/github-snapshot.json', 'src/data/star-history.json']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
let collecting = false;
const collectionInterval = 2 * 60 * 60 * 1000;
async function collectIfDue() {
  if (collecting || process.env.GITHUB_PULSE_AUTOSYNC === '0') return;
  try {
    const saved = JSON.parse(await readFile(resolve(root, 'src/data/github-snapshot.json'), 'utf8'));
    const last = Date.parse(saved.sync?.startedAt || saved.fetchedAt || '');
    if (Number.isFinite(last) && Date.now() - last < collectionInterval) return;
  } catch { /* The collector will report a malformed or unavailable snapshot. */ }
  collecting = true;
  const child = spawn(process.execPath, [resolve(root, 'scripts/sync-github-data.mjs'), '--limit', '750', '--budget', '800', '--discovery-pages', '1'], { cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
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
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(path));
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, '127.0.0.1', () => { console.log(`GitHub Pulse: http://localhost:${port}`); collectIfDue(); });
