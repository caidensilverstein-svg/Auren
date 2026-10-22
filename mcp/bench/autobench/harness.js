// Shared setup for Auren-Bench: fixture sites + headless Chrome + the real MCP server over HTTP, driven by the
// MCP SDK client exactly the way an agent would drive it. Every tool call is counted and its response measured.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startSites } from './sites.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const free = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const waitFor = async (fn, n = 120) => { for (let i = 0; i < n; i++) { try { if (await fn()) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('timeout waiting for service'); };

export function findChrome() {
  for (const c of [process.env.CHROME_BIN, 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    if (!c) continue;
    try { execFileSync('which', [c], { stdio: 'ignore' }); return c; } catch {}
  }
  throw new Error('no Chrome found (set CHROME_BIN)');
}

// opts.cdp = 'host:port' attaches to an existing browser instead of launching headless Chrome.
export async function startHarness(opts = {}) {
  const KEY = 'autobench-' + Math.random().toString(36).slice(2);
  const sites = await startSites();
  const procs = [];
  const tmp = [];
  let cdpHost = '127.0.0.1', cdpPort;
  if (opts.cdp) { [cdpHost, cdpPort] = [opts.cdp.split(':')[0], Number(opts.cdp.split(':')[1])]; }
  else {
    cdpPort = await free();
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'autobench-chrome-')); tmp.push(cdir);
    procs.push(spawn(findChrome(), ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${cdir}`, `--remote-debugging-port=${cdpPort}`, 'about:blank'], { stdio: 'ignore' }));
    await waitFor(() => fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.ok));
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autobench-home-')); tmp.push(home);
  fs.mkdirSync(path.join(home, '.auren'), { recursive: true });
  fs.writeFileSync(path.join(home, '.auren', 'agent_permissions.json'), JSON.stringify({ version: 1, trust_level: 'trusted', rules: { read: 'allow', navigation: 'allow', click: 'allow', fill: 'allow', js_execute: 'allow', form_submit: 'allow', sensitive_input: 'allow' } }));
  const mcpPort = await free();
  procs.push(spawn(process.execPath, [path.join(here, '..', '..', 'index.js')], {
    env: { ...process.env, HOME: home, AUREN_MCP_PORT: String(mcpPort), AUREN_CDP_HOST: cdpHost, AUREN_CDP_PORT: String(cdpPort), AUREN_MCP_KEY: KEY, AUREN_HISTORY: 'off' }, stdio: 'ignore' }));
  await waitFor(() => fetch(`http://127.0.0.1:${mcpPort}/health`).then(r => r.ok));
  const client = new Client({ name: 'autobench', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp/${KEY}`)));
  const tools = (await client.listTools()).tools.map(t => t.name);

  const meter = { calls: 0, chars: 0, ms: 0, log: [] };
  const call = async (name, args = {}) => {
    const t = performance.now();
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content || []).map(x => x.text ?? '').join('\n');
    meter.calls++; meter.chars += text.length; meter.ms += performance.now() - t;
    meter.log.push({ name, args, chars: text.length });
    if (process.env.AUTOBENCH_VERBOSE) console.log(`  > ${name} ${JSON.stringify(args)}\n${text.split('\n').slice(0, +process.env.AUTOBENCH_VERBOSE || 12).map(l => '    ' + l).join('\n')}`);
    return text;
  };
  const state = async () => (await fetch(`http://127.0.0.1:${sites.port}/__state`).then(r => r.json()));
  const reset = async () => { await fetch(`http://127.0.0.1:${sites.port}/__reset`); };
  const cdpList = async () => (await fetch(`http://${cdpHost}:${cdpPort}/json`).then(r => r.json()));
  // One clean tab per attempt: a task that leaves a native dialog or popups open cannot poison the next one.
  const newTab = async () => {
    const old = (await cdpList()).filter(t => t.type === 'page');
    await fetch(`http://${cdpHost}:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    for (const t of old) await fetch(`http://${cdpHost}:${cdpPort}/json/close/${t.id}`).catch(() => {});
    await new Promise(r => setTimeout(r, 1150)); // the MCP server caches the default tab id for 1 s
  };
  const close = async () => {
    await client.close().catch(() => {});
    for (const p of procs) try { p.kill('SIGKILL'); } catch {}
    sites.close();
    for (const d of tmp) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  };
  return { call, tools, meter, sites, state, reset, newTab, cdpList, cdpPort, close, url: (h, p = '/') => `${sites.origin(h)}${p}` };
}
