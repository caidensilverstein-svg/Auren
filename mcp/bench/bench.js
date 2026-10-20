// Latency benchmark for the Auren MCP server. Drives the real server over HTTP
// (MCP SDK client) against headless Chrome and a local fixture, the way an agent does.
// usage: node bench/bench.js [--n 15] [--json out.json]
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(arg('--n', 15));
const KEY = 'bench-key';

const free = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const chromeBin = ['google-chrome-stable', 'google-chrome', 'chromium'].find(c => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!chromeBin) { console.error('no Chrome found'); process.exit(1); }

const rows = Array.from({ length: 250 }, (_, i) => `<li><a href="/p2?i=${i}">link ${i}</a> <button>b${i}</button></li>`).join('');
const PAGES = {
  '/': `<!doctype html><title>Bench</title><main><h1>Bench</h1>
    <button id="b" onclick="window.n=(window.n||0)+1;document.getElementById('o').textContent='n='+window.n">go</button>
    <span id="o"></span><input id="t" type="text" placeholder="name"><a id="next" href="/p2">next</a></main>`,
  '/p2': `<!doctype html><title>Page 2</title><main><h1>Two</h1><button id="b2">two</button></main>`,
  '/big': `<!doctype html><title>Big</title><main><h1>Big list</h1><ul>${rows}</ul></main>`,
};

const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const results = {};
async function time(name, fn, n = N) {
  const ms = []; let bytes = 0;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const out = await fn(i);
    ms.push(performance.now() - t);
    bytes = typeof out === 'string' ? out.length : bytes;
  }
  results[name] = { n, p50: +q(ms, .5).toFixed(1), p95: +q(ms, .95).toFixed(1), mean: +(ms.reduce((a, b) => a + b, 0) / n).toFixed(1), resp_chars: bytes };
}

const ports = { cdp: await free(), mcp: await free(), web: await free() };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-bench-home-'));
const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-bench-chrome-'));
const web = http.createServer((req, res) => { const u = req.url.split('?')[0]; res.setHeader('content-type', 'text/html'); res.end(PAGES[u] ?? PAGES['/']); }).listen(ports.web, '127.0.0.1');
const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${cdir}`, `--remote-debugging-port=${ports.cdp}`, 'about:blank'], { stdio: 'ignore' });
const waitFor = async fn => { for (let i = 0; i < 100; i++) { try { if (await fn()) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('timeout'); };
await waitFor(() => fetch(`http://127.0.0.1:${ports.cdp}/json/version`).then(r => r.ok));
// the perms file lets the bench act freely
fs.mkdirSync(path.join(home, '.auren'), { recursive: true });
fs.writeFileSync(path.join(home, '.auren', 'agent_permissions.json'), JSON.stringify({ version: 1, trust_level: 'trusted', rules: { read: 'allow', navigation: 'allow', click: 'allow', fill: 'allow', js_execute: 'allow', form_submit: 'allow' } }));
const mcp = spawn(process.execPath, [path.join(here, '..', 'index.js')], { env: { ...process.env, HOME: home, AUREN_MCP_PORT: String(ports.mcp), AUREN_CDP_HOST: '127.0.0.1', AUREN_CDP_PORT: String(ports.cdp), AUREN_MCP_KEY: KEY }, stdio: 'ignore' });
await waitFor(() => fetch(`http://127.0.0.1:${ports.mcp}/health`).then(r => r.ok));

const c = new Client({ name: 'bench', version: '0' });
await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ports.mcp}/mcp/${KEY}`)));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content.map(x => x.text ?? '').join('\n');
const base = `http://127.0.0.1:${ports.web}`;
const tools = (await c.listTools()).tools.map(t => t.name);

await call('browser_navigate', { url: base + '/' }); // warm up
await time('navigate', () => call('browser_navigate', { url: base + '/' }));
await time('snapshot (small page)', () => call('browser_snapshot'));
await call('browser_navigate', { url: base + '/big' });
await time('snapshot (250-link page)', () => call('browser_snapshot'));
await time('find', () => call('browser_find', { query: 'link 100' }));
await call('browser_navigate', { url: base + '/' });
await time('click (in-page)', () => call('browser_click', { selector: '#b' }));
await time('fill', i => call('browser_fill', { selector: '#t', value: 'v' + i }));
await time('act click', () => call('browser_act', { find: 'go', action: 'click' }));
await time('click link (navigation)', async () => { await call('browser_navigate', { url: base + '/' }); const t = performance.now(); const o = await call('browser_click', { selector: '#next' }); return o; });
await time('read_section', () => call('browser_read_section', { region: 'main' }));
await time('screenshot', async () => (await call('browser_screenshot')).length);
// 4-step agent workflow as separate calls
await time('workflow x4 (separate calls)', async () => {
  await call('browser_navigate', { url: base + '/' });
  await call('browser_click', { selector: '#b' });
  await call('browser_fill', { selector: '#t', value: 'x' });
  return call('browser_snapshot');
}, Math.max(5, Math.floor(N / 2)));
if (tools.includes('browser_exec')) {
  await time('workflow x4 (browser_exec, 1 call)', () => call('browser_exec', { steps: [
    { op: 'navigate', url: base + '/' }, { op: 'click', selector: '#b' }, { op: 'fill', selector: '#t', value: 'x' }, { op: 'snapshot' }] }),
  Math.max(5, Math.floor(N / 2)));
}
// connection hygiene: how many CDP sockets does the server hold open?
const targets = await (await fetch(`http://127.0.0.1:${ports.cdp}/json`)).json();
results._meta = { tools: tools.length, chrome_targets: targets.map(t => t.type).join(','), node: process.version, n: N };

for (const p of [chrome, mcp]) try { p.kill('SIGKILL'); } catch {}
web.close(); await c.close().catch(() => {});
for (const d of [home, cdir]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('operation', 38), pad('p50 ms', 9), pad('p95 ms', 9), pad('mean', 9), 'resp chars');
for (const [k, v] of Object.entries(results)) if (!k.startsWith('_')) console.log(pad(k, 38), pad(v.p50, 9), pad(v.p95, 9), pad(v.mean, 9), v.resp_chars);
console.log('meta', JSON.stringify(results._meta));
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(results, null, 2));
process.exit(0);
