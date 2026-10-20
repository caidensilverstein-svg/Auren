import express from 'express';
import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';

(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (_) {}
})();

const PORT = Number(process.env.AUREN_MCP_PORT) || 3012;
const KEY = process.env.AUREN_MCP_KEY;
const MAC_CDP = {
  host: process.env.AUREN_CDP_HOST || '10.8.0.3',
  port: Number(process.env.AUREN_CDP_PORT) || 9223
};

// Fail closed: without a key the endpoint would be an unauthenticated remote
// browser-control API (js execution, form fill, screenshots of logged-in tabs).
if (!KEY && process.env.AUREN_MCP_ALLOW_NO_KEY !== '1') {
  console.error('AUREN_MCP_KEY is not set; refusing to start an unauthenticated MCP server.');
  process.exit(1);
}

function keyMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// --- Negotiated AI permissions (#10) ---
const PERMS_PATH = path.join(os.homedir(), '.auren', 'agent_permissions.json');
const DEFAULT_PERMS = {
  version: 1,
  trust_level: 'inspection',
  rules: { form_submit: 'ask', navigation: 'allow', read: 'allow', fill: 'ask', click: 'allow', js_execute: 'ask' },
  session_overrides: {}
};

function loadPerms() {
  try {
    return JSON.parse(fs.readFileSync(PERMS_PATH, 'utf8'));
  } catch {
    savePerms(DEFAULT_PERMS);
    return DEFAULT_PERMS;
  }
}
function savePerms(p) {
  fs.mkdirSync(path.dirname(PERMS_PATH), { recursive: true });
  fs.writeFileSync(PERMS_PATH, JSON.stringify(p, null, 2));
}

// Session grants live in memory only and expire, so a restart or timeout
// always returns to the persisted policy. Only the user (admin API / CLI)
// can create an 'allow' grant: the agent-facing tool just files a request.
const sessionGrants = new Map(); // action -> { level, expires }
const pendingRequests = new Map(); // id -> { id, action, reason, requested_at }
const DEFAULT_GRANT_MINUTES = 60;
const MAX_PENDING = 50;
const ACTIONS = ['fill', 'click', 'js_execute', 'form_submit', 'navigation', 'read'];

function checkPermission(action) {
  const p = loadPerms();
  const grant = sessionGrants.get(action);
  if (grant && grant.expires <= Date.now()) sessionGrants.delete(action);
  const live = grant && grant.expires > Date.now() ? grant.level : undefined;
  const rule = live ?? p.rules?.[action] ?? 'ask';
  if (rule === 'allow') return { allowed: true };
  if (rule === 'deny') return { allowed: false, reason: `Action '${action}' is denied by permissions policy.` };
  if (p.trust_level === 'trusted') return { allowed: true };
  return { allowed: false, reason: `Action '${action}' requires user approval. Call 'browser_set_permission' to file a request, then ask the user to approve it (auren-perm approve).` };
}

function denied(perm) {
  return { content: [{ type: 'text', text: `<permission_denied>${perm.reason}</permission_denied>` }] };
}

// --- Browsing path memory (#12) ---
const HISTORY_DB_PATH = path.join(os.homedir(), '.auren', 'history.db');
fs.mkdirSync(path.dirname(HISTORY_DB_PATH), { recursive: true });
const historyDb = new Database(HISTORY_DB_PATH);
historyDb.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT,
    visited_at INTEGER NOT NULL,
    time_spent_ms INTEGER,
    scroll_depth_pct INTEGER,
    tab_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_visits_url ON visits(url);
  CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON visits(visited_at);
  CREATE VIRTUAL TABLE IF NOT EXISTS visits_fts USING fts5(url, title, content='visits', content_rowid='id');
`);



// --- Session state ---
let eidCounter = 0;
const tabState = new Map();

function getTabState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, { step: 0, url: '', lastFPs: new Map() });
  }
  return tabState.get(tabId);
}

// --- CDP helpers ---
// A dead/unreachable host makes the TCP connect itself hang for many
// seconds (well past the intended backoff budget), so each attempt gets
// its own hard cap - otherwise 4 attempts against an unreachable host can
// take 30s+ instead of the ~7.5s the retry message promises.
const CONNECT_ATTEMPT_TIMEOUT_MS = 1500;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

async function getTarget(tabId) {
  const targets = await withTimeout(CDP.List(MAC_CDP), CONNECT_ATTEMPT_TIMEOUT_MS, 'CDP.List');
  const pages = targets.filter(t => t.type === 'page');
  if (tabId) {
    const match = pages.find(t => t.id === tabId);
    if (!match) {
      const err = new Error(`No open tab with id ${tabId}; call browser_get_tabs for current ids`);
      err.noRetry = true;
      throw err;
    }
    return match;
  }
  return pages[0];
}

// --- Persistent CDP session manager (MCP V3, #6) ---
// Holds one live CDP connection per tab, reused across tool calls instead of
// reconnecting every time. Retries only cover establishing/repairing the
// connection (List + connect) — once acquired, errors from fn() (element not
// found, bad selector, etc.) propagate immediately on the first attempt, since
// retrying fn() itself could re-run side effects like a click or form submit.
class SessionManager {
  constructor() {
    this._sessions = new Map(); // tabId → { client, target, lastUsed }
    this._ttl = 5 * 60 * 1000; // 5 min idle TTL
    setInterval(() => this._evict(), 60_000).unref();
  }

  async get(tabId) {
    const existing = this._sessions.get(tabId);
    if (!existing) return null;
    try {
      await withTimeout(
        existing.client.Runtime.evaluate({ expression: '1', returnByValue: true }),
        CONNECT_ATTEMPT_TIMEOUT_MS, 'session liveness probe');
      existing.lastUsed = Date.now();
      return existing;
    } catch {
      this._sessions.delete(tabId);
      await existing.client.close().catch(() => {});
      return null;
    }
  }

  async open(tabId) {
    const target = await getTarget(tabId);
    if (!target) throw new Error('No open page found in Auren');

    const client = await withTimeout(
      CDP({ ...MAC_CDP, target: target.id }), CONNECT_ATTEMPT_TIMEOUT_MS, 'CDP connect');
    await client.Page.enable();
    await client.Runtime.enable();

    let lastVisitId = null;
    client.Page.on('frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      // Query strings and fragments routinely carry session tokens and search
      // terms; the path memory only needs where the user went.
      let url = frame.url;
      try { const u = new URL(frame.url); u.search = ''; u.hash = ''; url = u.toString(); } catch {}
      if (!url || url === 'about:blank' || url.startsWith('chrome://')) return;
      try {
        // The title is not known yet; it is filled in on loadEventFired below.
        const info = historyDb.prepare('INSERT INTO visits (url, title, visited_at, tab_id) VALUES (?, ?, ?, ?)')
          .run(url, '', Date.now(), target.id);
        historyDb.prepare('INSERT INTO visits_fts (rowid, url, title) VALUES (?, ?, ?)')
          .run(info.lastInsertRowid, url, '');
        lastVisitId = info.lastInsertRowid;
      } catch (e) {
        console.error('history write failed:', e.message);
      }
    });
    client.Page.on('loadEventFired', async () => {
      if (!lastVisitId) return;
      const id = lastVisitId;
      try {
        const r = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
        const title = String(r?.result?.value ?? '').slice(0, 200);
        if (!title) return;
        historyDb.prepare('UPDATE visits SET title = ? WHERE id = ?').run(title, id);
        // external-content FTS5 table: re-index the row with the new title
        const row = historyDb.prepare('SELECT url FROM visits WHERE id = ?').get(id);
        historyDb.prepare("INSERT INTO visits_fts (visits_fts, rowid, url, title) VALUES ('delete', ?, ?, ?)").run(id, row.url, '');
        historyDb.prepare('INSERT INTO visits_fts (rowid, url, title) VALUES (?, ?, ?)').run(id, row.url, title);
      } catch (_) { /* tab may have closed; title stays blank */ }
    });

    // auto-evict on disconnect so a dropped socket does not linger in the pool
    client.on('disconnect', () => this._sessions.delete(target.id));

    const session = { client, target, lastUsed: Date.now() };
    this._sessions.set(target.id, session);
    return session;
  }

  async acquire(tabId) {
    const delays = [500, 1000, 2000, 4000];
    let lastErr;
    for (let i = 0; i <= delays.length; i++) {
      try {
        return (await this.get(tabId)) ?? (await this.open(tabId));
      } catch (e) {
        lastErr = e;
        if (e.noRetry) throw e;
        this._sessions.delete(tabId);
        if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
      }
    }
    const backoffSeconds = delays.reduce((a, b) => a + b, 0) / 1000;
    const maxSeconds =
        backoffSeconds + (delays.length + 1) * (CONNECT_ATTEMPT_TIMEOUT_MS / 1000);
    throw new Error(
      `Auren is offline — retried ${delays.length} times over ~${maxSeconds}s: ${lastErr.message}`
    );
  }
  _evict() {
    const now = Date.now();
    for (const [id, s] of this._sessions) {
      if (now - s.lastUsed > this._ttl) {
        s.client.close().catch(() => {});
        this._sessions.delete(id);
      }
    }
  }

  async closeAll() {
    for (const s of this._sessions.values()) await s.client.close().catch(() => {});
    this._sessions.clear();
  }
}

const sessions = new SessionManager();
async function withCDP(tabId, fn) {
  const session = await sessions.acquire(tabId ?? null);
  session.lastUsed = Date.now();
  try {
    return await fn(session.client, session.target);
  } catch (e) {
    // Session may be stale/broken after this error, so drop it here rather
    // than reuse a possibly-dead connection on the next call.
    sessions._sessions.delete(session.target.id);
    session.client.close().catch(() => {});
    throw e;
  }
}

// --- XML utilities ---
function escapeXml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildElementXml(item) {
  const { kind, text, attrs } = item;
  let a = ` eid="${escapeXml(attrs.eid)}"`;
  if (attrs.href) a += ` href="${escapeXml(attrs.href)}"`;
  if (attrs.type) a += ` type="${escapeXml(attrs.type)}"`;
  if (attrs.val !== undefined && attrs.val !== '') a += ` val="${escapeXml(attrs.val)}"`;
  if (attrs.checked !== undefined) a += ` checked="${attrs.checked}"`;
  if (attrs.disabled) a += ' disabled="true"';
  if (attrs.expanded !== undefined) a += ` expanded="${attrs.expanded}"`;
  return `    <${kind}${a}>${escapeXml(text)}</${kind}>`;
}

const MAX_XML = 7500;

function buildXml(data, state, isDiff) {
  if (!data.info) {
    return `<error>Snapshot failed: ${escapeXml(data.error || 'unknown')}</error>`;
  }
  const { url, title, scroll, viewport } = data.info;
  state.step++;
  const stateTag = isDiff
    ? '<diff type="mutation" />'
    : `<baseline reason="${state.url === url ? 'reload' : 'navigation'}" />`;
  state.url = url;

  const newFPs = new Map();
  // Build body first so we can report truncation in the state tag
  let budget = MAX_XML - 200;
  let wasTruncated = false;
  let totalItemCount = 0;

  const bodyLines = [];
  for (const region of data.regions) {
    if (!region.items || !region.items.length) continue;
    totalItemCount += region.items.length;
    const rOpen = `  <region name="${escapeXml(region.name)}">`;
    const rClose = '  </region>';
    const overhead = rOpen.length + rClose.length + 2;
    if (budget - overhead < 80) break;
    budget -= overhead;

    const regionBody = [];
    let added = 0;
    for (const item of region.items) {
      const line = buildElementXml(item);
      if (budget - line.length < 80) break;
      regionBody.push(line);
      budget -= line.length + 1;
      added++;
      const fp = `${item.kind}|${item.text}|${item.attrs.href || ''}`;
      newFPs.set(fp, { eid: item.attrs.eid, kind: item.kind, text: item.text, val: item.attrs.val });
    }
    const trimmed = region.items.length - added;
    if (trimmed > 0) {
      wasTruncated = true;
      regionBody.push(`    <!-- ${trimmed} more; use region="${escapeXml(region.name)}" to see all -->`);
    }
    bodyLines.push(rOpen, ...regionBody, rClose);
  }

  state.lastFPs = newFPs;

  // FIX 3: include truncation signal in state tag so callers can detect it programmatically
  const truncatedAttr = wasTruncated ? ` truncated="true" total_items="${totalItemCount}"` : '';
  const headerLines = [
    `<state step="${state.step}" title="${escapeXml(title)}" url="${escapeXml(url)}"${truncatedAttr}>`,
    `  <meta view="${viewport[0]}x${viewport[1]}" scroll="${scroll[0]},${scroll[1]}" />`,
    `  ${stateTag}`,
  ];

  return [...headerLines, ...bodyLines, '</state>'].join('\n');
}

// --- Snapshot JS builder ---
function snapshotJs(mode, region, maxItems) {
  const mStr = JSON.stringify(mode || 'interactive');
  const rExpr = region ? `document.querySelector(${JSON.stringify(region)})` : 'null';
  const mN = Number(maxItems) || 30;
  const startN = eidCounter;

  return `(function(){
try{
let n=${startN};
function kind(el){
  const t=el.tagName.toLowerCase(),r=(el.getAttribute('role')||'').toLowerCase(),ty=(el.type||'').toLowerCase();
  if(t==='button'||r==='button'||ty==='button'||ty==='submit'||ty==='reset')return'btn';
  if((t==='a'&&el.href)||r==='link')return'lnk';
  if(t==='input'||t==='textarea'||r==='textbox'||r==='searchbox')return'inp';
  if(t==='select'||r==='combobox'||r==='listbox')return'sel';
  if(ty==='checkbox'||r==='checkbox')return'chk';
  if(ty==='radio'||r==='radio')return'chk';
  if(/^h[1-6]$/.test(t)||r==='heading')return'h';
  if(r==='alert'||r==='status')return'alert';
  if(r==='menuitem'||r==='tab'||r==='option')return'btn';
  return'elt';
}
function txt(el){
  return(el.getAttribute('aria-label')||el.textContent||el.value||el.getAttribute('placeholder')||el.getAttribute('title')||'').trim().replace(/\\s+/g,' ').slice(0,80);
}
function ex(el){
  const k=kind(el),t=txt(el),eid=k+'-'+(++n);
  el.setAttribute('data-eid',eid);
  const tg=el.tagName.toLowerCase(),a={eid};
  if(el.href)a.href=el.href.slice(0,120);
  const ty=el.type;
  if(ty&&!['text','hidden'].includes(ty))a.type=ty;
  if(el.value&&!['button','submit','reset','a'].includes(tg))a.val=(ty==='password')?'[redacted]':String(el.value).slice(0,50);
  if(ty==='checkbox'||ty==='radio')a.checked=el.checked;
  if(el.disabled)a.disabled=true;
  const exp=el.getAttribute('aria-expanded');
  if(exp!==null)a.expanded=exp==='true';
  return{kind:k,text:t,attrs:a};
}
document.querySelectorAll('[data-eid]').forEach(e=>e.removeAttribute('data-eid'));
const mode=${mStr};
const scopeEl=${rExpr};
const maxN=${mN};
const sels={
  interactive:'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"]',
  full:'a[href],button,input:not([type="hidden"]),select,textarea,h1,h2,h3,h4,h5,h6,p,li,[role="button"],[role="link"],[role="alert"]',
  outline:'h1,h2,h3,h4,h5,h6,[role="heading"]'
};
const sel=sels[mode]||sels.interactive;
const root=scopeEl||document.body;
const info={url:location.href,title:document.title,scroll:[Math.round(window.scrollX),Math.round(window.scrollY)],viewport:[window.innerWidth,window.innerHeight]};
let regions;
if(!scopeEl){
  const lms=[
    {name:'nav',q:'nav,[role="navigation"]'},
    {name:'header',q:'header,[role="banner"]'},
    {name:'main',q:'main,[role="main"],[role="search"]'},
    {name:'aside',q:'aside,[role="complementary"]'},
    {name:'footer',q:'footer,[role="contentinfo"]'}
  ];
  const assigned=new WeakSet();
  regions=[];
  for(const lm of lms){
    const c=document.querySelector(lm.q);
    if(!c)continue;
    const items=[...c.querySelectorAll(sel)].filter(e=>{if(assigned.has(e))return false;assigned.add(e);return true;}).slice(0,maxN).map(ex);
    if(items.length)regions.push({name:lm.name,items});
  }
  const rem=[...document.body.querySelectorAll(sel)].filter(e=>!assigned.has(e)).slice(0,maxN).map(ex);
  if(rem.length)regions.push({name:'page',items:rem});
}else{
  const items=[...root.querySelectorAll(sel)].slice(0,maxN).map(ex);
  regions=[{name:'content',items}];
}
return JSON.stringify({info,regions,nextN:n});
}catch(e){return JSON.stringify({error:e.message});}
})()`;
}

async function takeSnapshot(client, resolvedTabId, opts = {}) {
  const { mode = 'interactive', region = null, maxItems = 30, isDiff = false } = opts;
  const state = getTabState(resolvedTabId);
  const js = snapshotJs(mode, region, maxItems);
  const result = await client.Runtime.evaluate({ expression: js, returnByValue: true, awaitPromise: false });
  const raw = result?.result?.value;
  if (!raw) throw new Error('Snapshot returned no value');
  const data = JSON.parse(raw);
  if (typeof data.nextN === 'number') eidCounter = data.nextN;
  return buildXml(data, state, isDiff);
}

// --- MCP server ---
function buildServer() {
  const server = new McpServer({ name: 'auren-browser', version: '2.1.2' });

  server.registerTool('browser_get_tabs', {
    description: 'List all open tabs in Auren',
    inputSchema: {}
  }, async () => {
    try {
      const targets = await CDP.List(MAC_CDP);
      const pages = targets.filter(t => t.type === 'page').map(t => ({ id: t.id, url: t.url, title: t.title }));
      return { content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `<error>Auren is offline: ${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_snapshot', {
    description: 'Get a compact XML snapshot of the page with stable element IDs (eids). mode="interactive" for actionable elements (default), "outline" for heading structure, "full" for readable content. Use region= (CSS selector) to scope to a subtree. Eids from this snapshot can be passed directly to browser_click and browser_fill.',
    inputSchema: {
      tab_id: z.string().optional(),
      mode: z.enum(['interactive', 'full', 'outline']).optional(),
      region: z.string().optional(),
      max_items: z.number().optional(),
    }
  }, async ({ tab_id, mode = 'interactive', region, max_items }) => {
    try {
      const perm = checkPermission('read');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client, target) => {
        const xml = await takeSnapshot(client, target.id, { mode, region, maxItems: max_items, isDiff: false });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_snapshot">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_navigate', {
    description: 'Navigate to a URL in Auren. Returns a compact baseline snapshot of the loaded page — no need to call browser_snapshot afterwards.',
    inputSchema: { url: z.string(), tab_id: z.string().optional() }
  }, async ({ url, tab_id }) => {
    try {
      const perm = checkPermission('navigation');
      if (!perm.allowed) return { content: [{ type: 'text', text:
`<permission_denied>${perm.reason}</permission_denied>` }] };
      // javascript:/data:/file: URLs would run script or read local files
      // while bypassing the js_execute permission gate.
      let parsed;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        return { content: [{ type: 'text', text: `<error tool="browser_navigate">Only http(s) URLs are allowed</error>` }] };
      }
      return await withCDP(tab_id, async (client, target) => {
        await client.Page.navigate({ url });
        await client.Page.loadEventFired().catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: false });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_navigate">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_click', {
    description: 'Click a UI element by eid (e.g. "btn-3") from a recent snapshot, or CSS selector. Prefer eid when available. Returns a baseline snapshot if the click caused navigation, or a mutation diff snapshot for in-page changes.',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), tab_id: z.string().optional() }
  }, async ({ eid, selector, tab_id }) => {
    try {
      const perm = checkPermission('click');
      if (!perm.allowed) return { content: [{ type: 'text', text: 
`<permission_denied>${perm.reason}</permission_denied>` }] };
      return await withCDP(tab_id, async (client, target) => {
        const EID_RE = /^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/;
        const raw = eid || selector;
        if (!raw) return { content: [{ type: 'text', text: '<error>Provide eid or selector</error>' }] };
        const resolved = EID_RE.test(raw) ? `[data-eid="${raw}"]` : raw;

        const elResult = await client.Runtime.evaluate({
          expression: `(function(){
            const el=document.querySelector(${JSON.stringify(resolved)});
            if(!el)return null;
            const r=el.getBoundingClientRect();
            return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:(el.textContent||el.value||'').trim().slice(0,60),tag:el.tagName.toLowerCase(),href:el.href||''});
          })()`,
          returnByValue: true
        });

        if (!elResult?.result?.value) {
          return { content: [{ type: 'text', text: `<error>Element not found: ${escapeXml(raw)}</error>` }] };
        }
        const el = JSON.parse(elResult.result.value);

        // FIX 1: capture URL before action — check after to detect any navigation,
        // including form submissions and JS-triggered navigations, not just <a> clicks
        // Read the live URL rather than the last snapshot's, which is empty
        // before the first snapshot and would report a bogus navigation.
        const prevUrl = (await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true }))?.result?.value || '';

        if (el.href && el.tag === 'a' && /^https?:/i.test(el.href)) {
          await client.Page.navigate({ url: el.href });
          await client.Page.loadEventFired().catch(() => {});
          await new Promise(r => setTimeout(r, 400));
        } else {
          // Real pointer events only. (A JS .click() followed by a mouse click
          // would activate toggles/checkboxes twice and undo them.)
          await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: el.x, y: el.y, button: 'left', clickCount: 1 });
          await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: el.x, y: el.y, button: 'left', clickCount: 1 });
          await new Promise(r => setTimeout(r, 350));
          const urlCheck = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
          if ((urlCheck?.result?.value || '') !== prevUrl) {
            await client.Page.loadEventFired().catch(() => {});
            await new Promise(r => setTimeout(r, 300));
          }
        }

        // Determine if navigation happened by comparing state URL to pre-click URL
        const urlCheckFinal = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
        const didNavigate = (urlCheckFinal?.result?.value || '') !== prevUrl;

        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: !didNavigate });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_click">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_fill', {
    description: 'Fill an input field by eid (e.g. "inp-5") from a recent snapshot, or CSS selector. Prefer eid when available. Returns a compact snapshot after filling — no need to call browser_snapshot afterwards.',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), value: z.string(), tab_id: z.string().optional() }
  }, async ({ eid, selector, value, tab_id }) => {
    try {
      const perm = checkPermission('fill');
      if (!perm.allowed) return { content: [{ type: 'text', text: 
`<permission_denied>${perm.reason}</permission_denied>` }] };
      return await withCDP(tab_id, async (client, target) => {
        const EID_RE = /^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/;
        const raw = eid || selector;
        if (!raw) return { content: [{ type: 'text', text: '<error>Provide eid or selector</error>' }] };
        const resolved = EID_RE.test(raw) ? `[data-eid="${raw}"]` : raw;

        const r = await client.Runtime.evaluate({
          expression: `(function(){
            const el=document.querySelector(${JSON.stringify(resolved)});
            if(!el)return'Not found';
            el.focus();
            const desc=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');
            if(desc&&desc.set)desc.set.call(el,${JSON.stringify(value)});
            else el.value=${JSON.stringify(value)};
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            return'ok';
          })()`,
          returnByValue: true
        });

        if (r?.result?.value === 'Not found') {
          return { content: [{ type: 'text', text: `<error>Element not found: ${escapeXml(raw)}</error>` }] };
        }
        await new Promise(res => setTimeout(res, 150));
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: true });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_fill">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_act', {
    description: 'Find an element by natural language description and act on it in one step. action: "click", "fill", "read". For fill, provide value. Eliminates the snapshot→find→act round trip.',
    inputSchema: {
      find: z.string(),
      action: z.enum(['click', 'fill', 'read']),
      value: z.string().optional(),
      tab_id: z.string().optional(),
    }
  }, async ({ find, action, value, tab_id }) => {
    try {
      if (action === 'click' || action === 'fill') {
        const perm = checkPermission(action);
        if (!perm.allowed) return { content: [{ type: 'text', text: 
`<permission_denied>${perm.reason}</permission_denied>` }] };
      }
      return await withCDP(tab_id, async (client, target) => {
        const startN = eidCounter;
        const findResult = await client.Runtime.evaluate({
          expression: `(function(){
            let n=${startN};
            const q=${JSON.stringify(find)};
            const isSel=/^[.#[*]/.test(q)||q.includes('>')||/\\s[.#[]/.test(q);
            function kind(el){const t=el.tagName.toLowerCase(),r=(el.getAttribute('role')||'').toLowerCase(),ty=(el.type||'').toLowerCase();if(t==='button'||r==='button'||ty==='button')return'btn';if((t==='a'&&el.href)||r==='link')return'lnk';if(t==='input'||t==='textarea'||r==='textbox')return'inp';if(t==='select'||r==='combobox')return'sel';return'elt';}
            let results=[];
            if(isSel){try{results=[...document.querySelectorAll(q)].slice(0,1);}catch(_){}}
            if(!results.length){const all=[...document.querySelectorAll('a,button,input,select,textarea,[role]')];results=all.filter(el=>(el.textContent||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').trim().toLowerCase().includes(q.toLowerCase())).slice(0,1);}
            if(!results.length)return JSON.stringify({error:'not found'});
            const el=results[0];const k=kind(el);const eid=k+'-'+(++n);el.setAttribute('data-eid',eid);
            return JSON.stringify({eid,kind:k,text:(el.textContent||el.value||el.getAttribute('aria-label')||'').trim().slice(0,80),nextN:n});
          })()`,
          returnByValue: true
        });
        const found = JSON.parse(findResult?.result?.value || '{}');
        if (found.error) return { content: [{ type: 'text', text: `<error>browser_act: element not found: ${escapeXml(find)}</error>` }] };
        if (typeof found.nextN === 'number') eidCounter = found.nextN;

        const resolved = `[data-eid="${found.eid}"]`;
        if (action === 'read') {
          const r = await client.Runtime.evaluate({ expression: `(function(){const el=document.querySelector(${JSON.stringify(resolved)});return el?(el.innerText||el.textContent||el.value||'').trim().slice(0,2000):'[not found]';})()`, returnByValue: true });
          return { content: [{ type: 'text', text: r?.result?.value ?? '[no content]' }] };
        }
        if (action === 'fill') {
          if (value === undefined) return { content: [{ type: 'text', text: '<error>browser_act fill requires value</error>' }] };
          await client.Runtime.evaluate({ expression: `(function(){const el=document.querySelector(${JSON.stringify(resolved)});if(!el)return;el.focus();const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');if(d&&d.set)d.set.call(el,${JSON.stringify(value)});else el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`, returnByValue: true });
          await new Promise(r => setTimeout(r, 150));
          const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: true });
          return { content: [{ type: 'text', text: xml }] };
        }
        if (action === 'click') {
          const state = getTabState(target.id);
          const prevUrl = state.url;
          await client.Runtime.evaluate({ expression: `(function(){const el=document.querySelector(${JSON.stringify(resolved)});if(el)el.click();})()` });
          await new Promise(r => setTimeout(r, 350));
          const urlCheck = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
          const didNavigate = (urlCheck?.result?.value || '') !== prevUrl;
          if (didNavigate) { await client.Page.loadEventFired().catch(() => {}); await new Promise(r => setTimeout(r, 300)); }
          const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: !didNavigate });
          return { content: [{ type: 'text', text: xml }] };
        }
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_act">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_find', {
    description: 'Find elements matching a text query, CSS selector, or ARIA label. Returns up to 5 matches with eids. Use when you need to locate an element without a full page snapshot.',
    inputSchema: { query: z.string(), tab_id: z.string().optional() }
  }, async ({ query, tab_id }) => {
    try {
      const perm = checkPermission('read');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client) => {
        const startN = eidCounter;
        const r = await client.Runtime.evaluate({
          expression: `(function(){
            let n=${startN};
            const q=${JSON.stringify(query)};
            const isSel=/^[.#[*]/.test(q)||q.includes('>')||/\\s[.#[]/.test(q);
            function kind(el){const t=el.tagName.toLowerCase(),r=(el.getAttribute('role')||'').toLowerCase(),ty=(el.type||'').toLowerCase();if(t==='button'||r==='button'||ty==='button')return'btn';if((t==='a'&&el.href)||r==='link')return'lnk';if(t==='input'||t==='textarea'||r==='textbox')return'inp';if(t==='select'||r==='combobox')return'sel';if(/^h[1-6]$/.test(t)||r==='heading')return'h';return'elt';}
            let results=[];
            if(isSel){try{results=[...document.querySelectorAll(q)].slice(0,5);}catch(_){}}
            if(!results.length){
              const all=[...document.querySelectorAll('a,button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6')];
              results=all.filter(el=>(el.textContent||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').trim().toLowerCase().includes(q.toLowerCase())).slice(0,5);
            }
            const items=results.map(el=>{const k=kind(el);const eid=k+'-'+(++n);el.setAttribute('data-eid',eid);return{kind:k,eid,text:(el.textContent||el.value||el.getAttribute('aria-label')||'').trim().slice(0,80),href:el.href||'',type:el.type||''};});
            return JSON.stringify({items,nextN:n});
          })()`,
          returnByValue: true
        });

        const raw = r?.result?.value;
        if (!raw) return { content: [{ type: 'text', text: '<results count="0" />' }] };
        const data = JSON.parse(raw);
        if (typeof data.nextN === 'number') eidCounter = data.nextN;

        if (!data.items.length) {
          return { content: [{ type: 'text', text: `<results count="0">No elements matching: ${escapeXml(query)}</results>` }] };
        }
        const lines = [`<results count="${data.items.length}">`];
        for (const item of data.items) {
          let a = ` eid="${escapeXml(item.eid)}"`;
          if (item.href) a += ` href="${escapeXml(item.href.slice(0, 100))}"`;
          if (item.type && !['text', 'hidden', ''].includes(item.type)) a += ` type="${escapeXml(item.type)}"`;
          lines.push(`  <${item.kind}${a}>${escapeXml(item.text)}</${item.kind}>`);
        }
        lines.push('</results>');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_find">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_read_section', {
    description: 'Read the readable text of a page section. Use region= with a CSS selector, landmark name (main, nav, footer, header, aside), or eid. Much smaller response than reading the full page.',
    inputSchema: {
      region: z.string().optional(),
      tab_id: z.string().optional(),
      max_chars: z.number().optional(),
    }
  }, async ({ region, tab_id, max_chars = 4000 }) => {
    try {
      const perm = checkPermission('read');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client) => {
        const cap = Math.min(Number(max_chars) || 4000, 12000);
        const lmMap = {
          main: 'main,[role="main"]',
          nav: 'nav,[role="navigation"]',
          footer: 'footer,[role="contentinfo"]',
          header: 'header,[role="banner"]',
          aside: 'aside,[role="complementary"]'
        };
        let selExpr;
        if (!region) {
          selExpr = 'document.body';
        } else if (/^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/.test(region)) {
          selExpr = `document.querySelector('[data-eid="${region}"]')`;
        } else if (lmMap[region]) {
          selExpr = `document.querySelector(${JSON.stringify(lmMap[region])})`;
        } else {
          selExpr = `document.querySelector(${JSON.stringify(region)})`;
        }

        const r = await client.Runtime.evaluate({
          expression: `(function(){const el=${selExpr};if(!el)return'[not found]';const t=(el.innerText||el.textContent||'').replace(/\n{3,}/g,'\n\n').trim();return t.length>${cap}?t.slice(0,${cap})+'\n[truncated]':t;})()`,
          returnByValue: true
        });
        return { content: [{ type: 'text', text: r?.result?.value ?? '[no content]' }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_read_section">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_diff', {
    description: 'Return what changed on the page since the last browser_snapshot call. Shows added, removed, and value-changed elements by fingerprint comparison. Best used after in-page mutations (dropdowns, modals, form updates) — not after navigation.',
    inputSchema: { tab_id: z.string().optional() }
  }, async ({ tab_id }) => {
    try {
      const perm = checkPermission('read');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client, target) => {
        const state = getTabState(target.id);
        const prevFPs = new Map(state.lastFPs);

        await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: true });
        const currFPs = state.lastFPs;

        const added = [], removed = [], changed = [];
        for (const [fp, curr] of currFPs) {
          const prev = prevFPs.get(fp);
          if (!prev) added.push(curr);
          else if (prev.val !== curr.val) changed.push({ ...curr, prevVal: prev.val });
        }
        for (const [fp, prev] of prevFPs) {
          if (!currFPs.has(fp)) removed.push(prev);
        }

        if (!added.length && !removed.length && !changed.length) {
          return { content: [{ type: 'text', text: '<diff type="no-change" />' }] };
        }
        const lines = [`<diff added="${added.length}" removed="${removed.length}" changed="${changed.length}">`];
        for (const i of added) lines.push(`  <add eid="${escapeXml(i.eid)}" kind="${i.kind}">${escapeXml(i.text)}</add>`);
        for (const i of removed) lines.push(`  <remove eid="${escapeXml(i.eid)}" kind="${i.kind}">${escapeXml(i.text)}</remove>`);
        for (const i of changed) lines.push(`  <change eid="${escapeXml(i.eid)}" kind="${i.kind}" prevVal="${escapeXml(String(i.prevVal ?? ''))}">${escapeXml(i.text)}</change>`);
        lines.push('</diff>');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_diff">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_screenshot', {
    description: 'Take a screenshot of the current page',
    inputSchema: { tab_id: z.string().optional() }
  }, async ({ tab_id }) => {
    try {
      const perm = checkPermission('read');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client) => {
        const { data } = await client.Page.captureScreenshot({ format: 'png' });
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_screenshot">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_execute_js', {
    description: 'Execute JavaScript in the page and return the result',
    inputSchema: { code: z.string(), tab_id: z.string().optional() }
  }, async ({ code, tab_id }) => {
    try {
      const perm = checkPermission('js_execute');
      if (!perm.allowed) return { content: [{ type: 'text', text: 
`<permission_denied>${perm.reason}</permission_denied>` }] };
      return await withCDP(tab_id, async (client) => {
        const r = await client.Runtime.evaluate({ expression: code, returnByValue: true, awaitPromise: true });
        return { content: [{ type: 'text', text: JSON.stringify(r.result.value ?? r.result.description) }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_execute_js">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_scroll', {
    description: 'Scroll the page up, down, to top, or to bottom. Returns a snapshot of the new viewport after scrolling.',
    inputSchema: {
      direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
      pixels: z.number().optional(),
      tab_id: z.string().optional()
    }
  // FIX 2: return snapshot after scroll so below-fold content is immediately visible
  }, async ({ direction = 'down', pixels = 500, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        const expr = direction === 'top' ? 'window.scrollTo(0,0)'
          : direction === 'bottom' ? 'window.scrollTo(0,document.body.scrollHeight)'
          : direction === 'up' ? `window.scrollBy(0,-${pixels})`
          : `window.scrollBy(0,${pixels})`;
        await client.Runtime.evaluate({ expression: expr });
        await new Promise(r => setTimeout(r, 200));
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: false });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_scroll">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_select_tab', {
    description: 'Switch to a tab by ID (from browser_get_tabs)',
    inputSchema: { tab_id: z.string() }
  }, async ({ tab_id }) => {
    try {
      const client = await CDP({ ...MAC_CDP, target: tab_id });
      await client.Target.activateTarget({ targetId: tab_id });
      await client.close();
      return { content: [{ type: 'text', text: `Switched to tab ${tab_id}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_select_tab">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_set_permission', {
    description: 'Request a permission change. Tightening (level deny/ask) applies immediately for this session. Loosening (level allow) is only a REQUEST: it is filed for the user, who must approve it out-of-band (auren-perm approve <id>); the agent cannot grant itself access. action: fill, click, js_execute, form_submit, navigation, read. reason: why you need it.',
    inputSchema: {
      action: z.enum(ACTIONS),
      level: z.enum(['allow', 'deny', 'ask']),
      scope: z.enum(['session', 'permanent']).default('session').describe('Ignored for loosening: the user chooses the scope when approving.'),
      reason: z.string().max(300).optional(),
    }
  }, async ({ action, level, reason }) => {
    if (level !== 'allow') {
      // Tightening is always safe to self-apply.
      sessionGrants.set(action, { level, expires: Date.now() + DEFAULT_GRANT_MINUTES * 60_000 });
      return { content: [{ type: 'text', text: `Permission for '${action}' tightened to '${level}' for this session.` }] };
    }
    for (const r of pendingRequests.values()) {
      if (r.action === action) return { content: [{ type: 'text', text: `A request for '${action}' is already pending (id ${r.id}). Ask the user to approve it.` }] };
    }
    if (pendingRequests.size >= MAX_PENDING) return { content: [{ type: 'text', text: 'Too many pending permission requests; ask the user to clear them.' }] };
    const id = crypto.randomBytes(4).toString('hex');
    pendingRequests.set(id, { id, action, reason: reason ?? '', requested_at: new Date().toISOString() });
    return { content: [{ type: 'text', text: `Request ${id} filed: allow '${action}'. It is NOT active until the user approves it (auren-perm approve ${id}). Tell the user.` }] };
  });

  server.registerTool('browser_get_permissions', {
    description: 'Read the current agent permission policy.',
    inputSchema: {}
  }, async () => {
    const p = loadPerms();
    const grants = Object.fromEntries([...sessionGrants].filter(([, g]) => g.expires > Date.now()).map(([k, g]) => [k, g.level]));
    return { content: [{ type: 'text', text: JSON.stringify({ ...p, session_overrides: grants, pending_requests: [...pendingRequests.values()] }, null, 2) }] };
  });

  server.registerTool('browser_set_preference', {
    description: 'Set a browser preference. font_size (int, live via CDP), zoom_level (float, via CDP page scale factor), theme/search_engine/show_bookmarks_bar (advisory only, no persistent write path yet).',
    inputSchema: {
      preference: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      tab_id: z.string().optional(),
    }
  }, async ({ preference, value, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client) => {
        let result;

        if (preference === 'font_size') {
          await client.Runtime.evaluate({
            expression: 
`document.documentElement.style.fontSize = '${Number(value)}px'`,
          });
          result = 
`Font size set to ${value}px (live only, resets on navigation)`;
        }
        else if (preference === 'zoom_level') {
          await client.Emulation.setPageScaleFactor({ pageScaleFactor: Number(value) });
          result = `Zoom set to ${value}`;
        }
        else if (preference === 'theme') {
          const isDark = String(value).toLowerCase() === 'dark';
          await client.Runtime.evaluate({
            expression: 
`document.documentElement.setAttribute('data-theme', '${isDark ? 'dark' : 'light'}')`,
          });
          result = 
`Theme attribute set to ${value} (advisory only, no persistent storage outside extension context)`;
        }
        else if (preference === 'show_bookmarks_bar') {
          result = `show_bookmarks_bar is advisory only (no C++/settings write path yet)`;
        }
        else if (preference === 'search_engine') {
          const engines = { google: 'https://google.com/search?q={searchTerms}', brave: 'https://search.brave.com/search?q={searchTerms}', kagi: 'https://kagi.com/search?q={searchTerms}', ddg: 'https://duckduckgo.com/?q={searchTerms}' };
          const url = engines[String(value).toLowerCase()];
          if (!url) return { content: [{ type: 'text', text: 
`Unknown search engine: ${value}. Options: google, brave, kagi, ddg` }] };
          result = `search_engine noted as ${value} (advisory only, no persistent write path yet)`;
        }
        else {
          return { content: [{ type: 'text', text: 
`Unknown preference: ${preference}` }] };
        }
        return { content: [{ type: 'text', text: result }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: 
`<error tool="browser_set_preference">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_search_history', {
    description: 'Search your Auren browsing history by keyword. Returns matching URLs with titles and timestamps.',
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
      since_hours: z.number().optional(),
    }
  }, async ({ query, limit, since_hours }) => {
    try {
      let rows;
      const since = since_hours ? Date.now() - since_hours * 3600_000 : 0;
      if (query.trim()) {
        const phrase = '"' + query.replace(/"/g, '""') + '"';
        rows = historyDb.prepare(`
          SELECT v.url, v.title, v.visited_at, v.time_spent_ms
          FROM visits_fts f
          JOIN visits v ON v.id = f.rowid
          WHERE visits_fts MATCH ? AND v.visited_at >= ?
          ORDER BY v.visited_at DESC
          LIMIT ?
        `).all(phrase, since, limit);
      } else {
        rows = historyDb.prepare(`
          SELECT url, title, visited_at, time_spent_ms FROM visits
          WHERE visited_at >= ?
          ORDER BY visited_at DESC LIMIT ?
        `).all(since, limit);
      }
      if (!rows.length) return { content: [{ type: 'text', text: 
`No history found matching that query.` }] };
      const formatted = rows.map(r =>
`${new Date(r.visited_at).toISOString()} — ${r.title || '(no title)'}
  ${r.url}${r.time_spent_ms ? ` (${Math.round(r.time_spent_ms/1000)}s)` : ''}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 
`<error>${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_get_session_context', {
    description: 'Get a summary of what you have been browsing recently.',
    inputSchema: {
      last_minutes: z.number().int().min(1).max(480).default(60),
    }
  }, async ({ last_minutes }) => {
    const since = Date.now() - last_minutes * 60_000;
    const rows = historyDb.prepare(`
      SELECT url, title, visited_at, time_spent_ms FROM visits
      WHERE visited_at >= ? ORDER BY visited_at ASC
    `).all(since);
    if (!rows.length) return { content: [{ type: 'text', text: 
`No browsing activity in the last ${last_minutes} minutes.` }] };
    const lines = rows.map(r =>
`${new Date(r.visited_at).toLocaleTimeString()} — ${r.title || r.url}`
    );
    return { content: [{ type: 'text', text: 
`Browsing context (last ${last_minutes} min):\n\n${lines.join('\n')}` }] };
  });

  return server;
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'auren-mcp', version: '2.1.2' }));


// --- Admin API (user-only; loopback + separate key; disabled unless AUREN_ADMIN_KEY is set) ---
const ADMIN_KEY = process.env.AUREN_ADMIN_KEY;
function adminAuth(req, res, next) {
  const hdr = req.get('x-admin-key');
  if (!ADMIN_KEY || typeof hdr !== 'string') return res.status(404).json({ error: 'not found' });
  const a = crypto.createHash('sha256').update(hdr).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const admin = express.Router();
admin.use(adminAuth);
admin.get('/permissions', (_, res) => {
  const grants = Object.fromEntries([...sessionGrants].filter(([, g]) => g.expires > Date.now())
    .map(([k, g]) => [k, { level: g.level, expires: new Date(g.expires).toISOString() }]));
  res.json({ ...loadPerms(), session_overrides: grants, pending_requests: [...pendingRequests.values()] });
});
admin.post('/requests/:id/approve', (req, res) => {
  const r = pendingRequests.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no such request' });
  const scope = req.body?.scope === 'permanent' ? 'permanent' : 'session';
  const minutes = Math.min(Math.max(Number(req.body?.minutes) || DEFAULT_GRANT_MINUTES, 1), 24 * 60);
  if (scope === 'permanent') {
    const p = loadPerms(); p.rules[r.action] = 'allow'; savePerms(p);
  } else {
    sessionGrants.set(r.action, { level: 'allow', expires: Date.now() + minutes * 60_000 });
  }
  pendingRequests.delete(r.id);
  res.json({ ok: true, action: r.action, scope, minutes: scope === 'session' ? minutes : undefined });
});
admin.post('/requests/:id/deny', (req, res) => {
  res.json({ ok: pendingRequests.delete(req.params.id) });
});
admin.post('/permissions', (req, res) => {
  const { action, level, trust_level } = req.body ?? {};
  const p = loadPerms();
  if (trust_level !== undefined) {
    if (!['inspection', 'trusted'].includes(trust_level)) return res.status(400).json({ error: 'bad trust_level' });
    p.trust_level = trust_level;
  }
  if (action !== undefined) {
    if (!ACTIONS.includes(action) || !['allow', 'deny', 'ask'].includes(level)) return res.status(400).json({ error: 'bad action/level' });
    p.rules[action] = level;
  }
  savePerms(p);
  res.json({ ok: true, trust_level: p.trust_level, rules: p.rules });
});
admin.post('/revoke', (_, res) => { sessionGrants.clear(); res.json({ ok: true }); });
app.use('/admin', admin);

async function handleMcp(req, res) {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (KEY && !keyMatches(req.params.key ?? bearer)) return res.status(404).json({ error: 'not found' });
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { try { transport.close(); server.close(); } catch (_) {} });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message || e) }, id: null });
  }
}

app.post('/mcp/:key', handleMcp);
app.post('/mcp', handleMcp);
app.get('/mcp/:key', (_, res) => res.status(405).json({ error: 'use POST' }));

if (!process.env.AUREN_MCP_NO_LISTEN) app.listen(PORT, '127.0.0.1', () => console.log(`Auren MCP v2.1 on :${PORT}  path=/mcp/<key>  cdp=${MAC_CDP.host}:${MAC_CDP.port}`));
