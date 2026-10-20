// End-to-end tests: drives the real MCP server over HTTP the way an agent
// would (MCP client -> /mcp/<key> -> CDP -> headless Chrome -> fixture page).
// Run with: npm test   (set CHROME_BIN if Chrome is not on PATH)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
const KEY = 'test-key-' + Math.random().toString(36).slice(2);
const ADMIN = 'admin-key-' + Math.random().toString(36).slice(2);

function freePort() {
  return new Promise(res => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function findChrome() {
  for (const c of [process.env.CHROME_BIN, 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    if (!c) continue;
    try { execFileSync('which', [c], { stdio: 'ignore' }); return c; } catch {}
  }
  return null;
}

const PAGE = `<!doctype html><title>Fixture Page</title>
<main><h1>Fixture</h1>
<button id="b" onclick="window.n=(window.n||0)+1;this.textContent='clicked '+window.n">go</button>
<input id="c" type="checkbox" aria-label="agree" onchange="window.toggles=(window.toggles||0)+1">
<input id="t" type="text" placeholder="name">
<input id="p" type="password" aria-label="pw" value="hunter2">
</main>`;

let chrome, fixture, mcp, chromeDir, homeDir, ports = {};
const chromePath = findChrome();
const skip = chromePath ? false : 'Chrome not found (set CHROME_BIN)';

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise(r => setTimeout(r, 150));
  }
}

function startMcp(env = {}) {
  return spawn(process.execPath, [path.join(here, '..', 'index.js')], {
    env: { ...process.env, HOME: homeDir, AUREN_MCP_PORT: String(ports.mcp), AUREN_CDP_HOST: '127.0.0.1',
           AUREN_CDP_PORT: String(ports.cdp), AUREN_MCP_KEY: KEY, AUREN_ADMIN_KEY: ADMIN, ...env },
    stdio: 'ignore',
  });
}

async function connect(key = KEY) {
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ports.mcp}/mcp/${key}`)));
  return client;
}
const text = r => r.content.map(c => c.text ?? '').join('\n');
// Out-of-band approval, as the user would do with `auren-perm approve`.
async function admin(method, p, body, key = ADMIN) {
  const r = await fetch(`http://127.0.0.1:${ports.mcp}/admin${p}`, {
    method, headers: { 'x-admin-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function grant(c, action) {
  const out = await call(c, 'browser_set_permission', { action, level: 'allow', reason: 'test' });
  const id = out.match(/Request ([0-9a-f]+) filed/)?.[1] ?? out.match(/id ([0-9a-f]+)\)/)?.[1];
  assert.ok(id, out);
  assert.equal((await admin('POST', `/requests/${id}/approve`, { scope: 'session', minutes: 5 })).status, 200);
}
const call = async (c, name, args = {}) => text(await c.callTool({ name, arguments: args }));

before(async () => {
  if (skip) return;
  ports = { cdp: await freePort(), mcp: await freePort(), web: await freePort() };
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-mcp-home-'));
  chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-mcp-chrome-'));
  fixture = http.createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); })
    .listen(ports.web, '127.0.0.1');
  chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${chromeDir}`,
    `--remote-debugging-port=${ports.cdp}`, `--remote-debugging-address=127.0.0.1`, 'about:blank'], { stdio: 'ignore' });
  await waitFor(() => fetch(`http://127.0.0.1:${ports.cdp}/json/version`).then(r => r.ok));
  mcp = startMcp();
  await waitFor(() => fetch(`http://127.0.0.1:${ports.mcp}/health`).then(r => r.ok));
});

after(() => {
  for (const p of [chrome, mcp]) { try { p?.kill('SIGKILL'); } catch {} }
  fixture?.close();
  for (const d of [homeDir, chromeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('refuses to start without a key (fail closed)', { skip }, async () => {
  const p = startMcp({ AUREN_MCP_KEY: '', AUREN_MCP_PORT: String(await freePort()) });
  const code = await new Promise(r => p.on('exit', r));
  assert.notEqual(code, 0);
});

test('auth: wrong key is a 404, right key and bearer header work', { skip }, async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const hdr = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const bad = await fetch(`http://127.0.0.1:${ports.mcp}/mcp/nope`, { method: 'POST', headers: hdr, body });
  assert.equal(bad.status, 404);
  const none = await fetch(`http://127.0.0.1:${ports.mcp}/mcp`, { method: 'POST', headers: hdr, body });
  assert.equal(none.status, 404);
  const bearer = await fetch(`http://127.0.0.1:${ports.mcp}/mcp`, { method: 'POST', headers: { ...hdr, authorization: `Bearer ${KEY}` }, body });
  assert.equal(bearer.status, 200);
});

test('lists the expected tools', { skip }, async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map(t => t.name);
  for (const n of ['browser_get_tabs', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill',
    'browser_act', 'browser_find', 'browser_read_section', 'browser_diff', 'browser_screenshot',
    'browser_execute_js', 'browser_scroll', 'browser_set_permission', 'browser_get_permissions',
    'browser_search_history', 'browser_get_session_context']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  await c.close();
});

test('navigate returns a snapshot with element ids', { skip }, async () => {
  const c = await connect();
  const out = await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/` });
  assert.match(out, /<state step="\d+" title="Fixture Page"/);
  assert.match(out, /<btn eid="btn-\d+"[^>]*>go<\/btn>/);
  await c.close();
});

test('navigate rejects javascript:, file: and data: URLs', { skip }, async () => {
  const c = await connect();
  for (const url of ['javascript:window.pwned=1', 'file:///etc/passwd', 'data:text/html,hi', 'not a url']) {
    assert.match(await call(c, 'browser_navigate', { url }), /Only http\(s\) URLs/, url);
  }
  await c.close();
});

test('click fires exactly once (button counter and checkbox toggle)', { skip }, async () => {
  const c = await connect();
  await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/` });
  await call(c, 'browser_snapshot');
  await call(c, 'browser_click', { selector: '#b' });
  await call(c, 'browser_click', { selector: '#c' });
  await grant(c, 'js_execute');
  const n = await call(c, 'browser_execute_js', { code: 'JSON.stringify([window.n, window.toggles, document.getElementById("c").checked])' });
  assert.equal(JSON.parse(JSON.parse(n)).join(), '1,1,true');
  await c.close();
});

test('fill sets an input value', { skip }, async () => {
  const c = await connect();
  await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/` });
  // fill is 'ask' by default under the inspection trust level
  assert.match(await call(c, 'browser_fill', { selector: '#t', value: 'x' }), /permission_denied/);
  await grant(c, 'fill');
  assert.match(await call(c, 'browser_fill', { selector: '#t', value: 'Ada' }), /val="Ada"/);
  await c.close();
});

test('password values are redacted in snapshots', { skip }, async () => {
  const c = await connect();
  const out = await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/` });
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /type="password" val="\[redacted\]"/);
  await c.close();
});

test('unknown tab_id is an error, not a silent fallback to another tab', { skip }, async () => {
  const c = await connect();
  assert.match(await call(c, 'browser_snapshot', { tab_id: 'DOES-NOT-EXIST' }), /No open tab with id/);
  await c.close();
});

test('browsing history records the real page title and is searchable', { skip }, async () => {
  const c = await connect();
  await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/?hist=1` });
  await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/page?token=SECRET#frag` });
  await waitFor(async () => /Fixture Page/.test(await call(c, 'browser_search_history', { query: 'page', limit: 5 })), 5000);
  assert.doesNotMatch(await call(c, 'browser_search_history', { query: '', limit: 20 }), /SECRET|frag/);
  assert.match(await call(c, 'browser_get_session_context', { last_minutes: 5 }), /Fixture Page/);
  await c.close();
});

test('agent cannot grant itself access: allow is only a request until the user approves', { skip }, async () => {
  const c = await connect();
  await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/ask` });
  const out = await call(c, 'browser_set_permission', { action: 'form_submit', level: 'allow' });
  assert.match(out, /NOT active/);
  const perms = JSON.parse(await call(c, 'browser_get_permissions'));
  assert.equal(perms.pending_requests.some(r => r.action === 'form_submit'), true);
  assert.notEqual(perms.session_overrides.form_submit, 'allow');
  await c.close();
});

test('admin API: disabled without key, rejects wrong key, deny discards request', { skip }, async () => {
  assert.equal((await admin('GET', '/permissions', null, 'wrong')).status, 401);
  const bare = await fetch(`http://127.0.0.1:${ports.mcp}/admin/permissions`);
  assert.equal(bare.status, 404);
  const c = await connect();
  const out = await call(c, 'browser_set_permission', { action: 'navigation', level: 'allow' });
  const id = out.match(/Request ([0-9a-f]+) filed/)?.[1] ?? out.match(/id ([0-9a-f]+)\)/)?.[1];
  await admin('POST', `/requests/${id}/deny`);
  const perms = (await admin('GET', '/permissions')).body;
  assert.equal(perms.pending_requests.some(r => r.id === id), false);
  await c.close();
});

test('the agent can tighten its own permissions; a deny rule blocks reads', { skip }, async () => {
  const c = await connect();
  await call(c, 'browser_set_permission', { action: 'read', level: 'deny' });
  assert.match(await call(c, 'browser_snapshot'), /permission_denied/);
  assert.equal((await admin('POST', '/revoke')).status, 200);
  assert.match(await call(c, 'browser_snapshot'), /<state/);
  await c.close();
});

test('history: can be disabled and cleared by the user, and read-gated', { skip }, async () => {
  const c = await connect();
  assert.equal((await admin('POST', '/history', { enabled: false })).body.enabled, false);
  await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/not-recorded` });
  await new Promise(r => setTimeout(r, 400));
  assert.doesNotMatch(await call(c, 'browser_search_history', { query: 'not-recorded' }), /not-recorded/);
  assert.equal((await admin('POST', '/history', { enabled: true })).body.enabled, true);
  await call(c, 'browser_navigate', { url: `http://127.0.0.1:${ports.web}/recorded` });
  await waitFor(async () => /recorded/.test(await call(c, 'browser_search_history', { query: 'recorded' })), 5000);
  await call(c, 'browser_set_permission', { action: 'read', level: 'deny' });
  assert.match(await call(c, 'browser_search_history', { query: 'recorded' }), /permission_denied/);
  await admin('POST', '/revoke');
  assert.equal((await admin('DELETE', '/history')).body.ok, true);
  assert.match(await call(c, 'browser_search_history', { query: '' }), /No history found/);
  await c.close();
});

test('history: migration strips queries from old rows and prunes by retention', { skip }, async () => {
  const Database = (await import('better-sqlite3')).default;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-mig-'));
  fs.mkdirSync(path.join(home, '.auren'));
  const db = new Database(path.join(home, '.auren', 'history.db'));
  db.exec(`CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT, visited_at INTEGER NOT NULL, time_spent_ms INTEGER, scroll_depth_pct INTEGER, tab_id TEXT);
    CREATE VIRTUAL TABLE visits_fts USING fts5(url, title, content='visits', content_rowid='id');`);
  const ins = db.prepare('INSERT INTO visits (url,title,visited_at) VALUES (?,?,?)');
  ins.run('https://a.test/p?token=SECRET#x', 'old-but-fresh', Date.now());
  ins.run('https://a.test/ancient', 'ancient', Date.now() - 400 * 86_400_000);
  db.close();
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(here, '..', 'index.js')], {
    env: { ...process.env, HOME: home, AUREN_MCP_PORT: String(port), AUREN_CDP_PORT: String(ports.cdp), AUREN_MCP_KEY: KEY }, stdio: 'ignore' });
  await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok));
  p.kill('SIGKILL');
  const db2 = new Database(path.join(home, '.auren', 'history.db'), { readonly: true });
  const rows = db2.prepare('SELECT url FROM visits').all().map(r => r.url);
  db2.close();
  fs.rmSync(home, { recursive: true, force: true });
  assert.deepEqual(rows, ['https://a.test/p']);
});

test('reports a structured offline error when Auren is unreachable', { skip }, async () => {
  const c = await connect();
  chrome.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 500));
  const out = await call(c, 'browser_snapshot');
  assert.match(out, /Auren is offline/);
  await c.close();
});

