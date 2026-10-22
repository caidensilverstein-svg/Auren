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
import { PAGE_LIB } from './lib/pagelib.js';
import { TokenStore, scopeAllows } from './lib/auth.js';

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

// Agent tokens (docs/design/user-auth.md): hashed at rest, scoped, revocable. The shared AUREN_MCP_KEY keeps working
// during migration and maps to user 'owner' with scope AUREN_LEGACY_SCOPE (default 'settings' = everything it could do
// before; set it to 'act' to stop a leaked legacy key from filing permission/preference requests).
const AUTH_DB_PATH = process.env.AUREN_AUTH_DB || path.join(os.homedir(), '.auren', 'auth.db');
fs.mkdirSync(path.dirname(AUTH_DB_PATH), { recursive: true, mode: 0o700 });
const tokens = new TokenStore(new Database(AUTH_DB_PATH));
try { fs.chmodSync(AUTH_DB_PATH, 0o600); } catch { /* best effort */ }
const LEGACY_AUTH = { user_id: 'owner', token_id: 'legacy', scope: ['read', 'act', 'settings'].includes(process.env.AUREN_LEGACY_SCOPE) ? process.env.AUREN_LEGACY_SCOPE : 'settings' };

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
const ACTIONS = ['fill', 'click', 'js_execute', 'form_submit', 'navigation', 'read', 'sensitive_input', 'file_upload'];
const DENY_BY_DEFAULT = new Set(['sensitive_input', 'file_upload']); // password / card fields; sending local files to a site

function checkPermission(action) {
  const p = loadPerms();
  const grant = sessionGrants.get(action);
  if (grant && grant.expires <= Date.now()) sessionGrants.delete(action);
  const live = grant && grant.expires > Date.now() ? grant.level : undefined;
  if (p.panic) return { allowed: false, reason: 'Agent access is suspended by the user (panic switch). Ask the user to run: auren-perm panic off' };
  const rule = live ?? p.rules?.[action] ?? (DENY_BY_DEFAULT.has(action) ? 'deny' : 'ask');
  if (rule === 'allow') return { allowed: true };
  if (rule === 'deny') return { allowed: false, reason: `Action '${action}' is denied by permissions policy.` };
  if (p.trust_level === 'trusted') return { allowed: true };
  return { allowed: false, reason: `Action '${action}' requires user approval. Call 'browser_set_permission' to file a request, then ask the user to approve it (auren-perm approve).` };
}

// --- Per-site rules (user-managed): deny = no access at all, readonly = may read/snapshot but not
// click, fill, press, run JS or submit. Matches the host and its subdomains. ---
function domainRule(urlStr) {
  let host;
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch { return undefined; }
  const rules = loadPerms().domains ?? {};
  let best; let bestLen = -1;
  for (const [d, r] of Object.entries(rules)) {
    if ((host === d || host.endsWith('.' + d)) && d.length > bestLen) { best = r; bestLen = d.length; }
  }
  return best;
}
function domainBlocks(urlStr, kind) { // kind: 'read' | 'write'
  const r = domainRule(urlStr);
  if (r === 'deny') return { reason: `The user has blocked this site (${new URL(urlStr).hostname}) for the agent.` };
  if (r === 'readonly' && kind === 'write') return { reason: `The user allows only reading on ${new URL(urlStr).hostname}; clicking, typing and scripts are blocked there.` };
  return null;
}

// --- Audit log: one JSON line per tool call at ~/.auren/audit.log (mode 600, rotated at 5 MB).
// Records what the agent did and the outcome, never typed values, script source or URL query strings. ---
const AUDIT_PATH = path.join(os.homedir(), '.auren', 'audit.log');
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
function auditArgs(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'value' || k === 'code' || k === 'text') out[k + '_len'] = String(v ?? '').length;
    else if (k === 'url') { try { const u = new URL(v); out.url = u.origin + u.pathname; } catch { out.url = '(invalid)'; } }
    else if (k === 'steps' && Array.isArray(v)) out.steps = v.map(x => x.op + (x.url ? ':' + (() => { try { return new URL(x.url).hostname; } catch { return '?'; } })() : ''));
    else if (typeof v === 'string') out[k] = v.slice(0, 120);
    else out[k] = v;
  }
  return out;
}
function auditWrite(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
    try { if (fs.statSync(AUDIT_PATH).size > AUDIT_MAX_BYTES) fs.renameSync(AUDIT_PATH, AUDIT_PATH + '.1'); } catch {}
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) { console.error('audit write failed:', e.message); }
}

// Circuit breaker: a runaway or hijacked agent cannot fire unlimited state-changing actions.
const MAX_ACTIONS_PER_MIN = Number(process.env.AUREN_MAX_ACTIONS_PER_MIN) || 120;
const actionTimes = new Map(); // token id -> timestamps of recent state-changing actions
const STATE_CHANGING = new Set(['browser_click', 'browser_fill', 'browser_navigate', 'browser_execute_js', 'browser_act', 'browser_exec', 'browser_set_preference', 'browser_hover', 'browser_dialog', 'browser_upload']);
function rateLimited(weight, key = 'legacy') {
  const now = Date.now();
  let times = actionTimes.get(key);
  if (!times) actionTimes.set(key, times = []);
  while (times.length && now - times[0] > 60_000) times.shift();
  if (times.length + weight > MAX_ACTIONS_PER_MIN) return true;
  for (let i = 0; i < weight; i++) times.push(now);
  return false;
}

function instrument(server, auth = LEGACY_AUTH) {
  const orig = server.registerTool.bind(server);
  const who = { user: auth.user_id, token: auth.token_id };
  server.registerTool = (name, cfg, handler) => orig(name, cfg, async (args, extra) => {
    const t0 = Date.now();
    const p = loadPerms();
    let res;
    if (!scopeAllows(auth.scope, name)) {
      res = { content: [{ type: 'text', text: `<permission_denied>This token has scope '${auth.scope}', which does not allow ${name}. Ask the user for a token with a higher scope (auren-token mint --scope ...).</permission_denied>` }] };
    } else if (p.panic && name !== 'browser_get_permissions') {
      res = { content: [{ type: 'text', text: '<permission_denied>Agent access is suspended by the user (panic switch). Ask the user to run: auren-perm panic off</permission_denied>' }] };
    } else if (STATE_CHANGING.has(name) && rateLimited(name === 'browser_exec' ? (args?.steps?.length || 1) : 1, auth.token_id)) {
      res = { content: [{ type: 'text', text: `<error tool="${name}">Rate limit: more than ${MAX_ACTIONS_PER_MIN} actions in the last minute. Slow down or ask the user to raise AUREN_MAX_ACTIONS_PER_MIN.</error>` }] };
    } else {
      try { res = await handler(args, extra); } catch (e) { auditWrite({ ts: new Date().toISOString(), ...who, tool: name, args: auditArgs(args), outcome: 'exception', ms: Date.now() - t0 }); throw e; }
    }
    const txt = (res?.content ?? []).map(c => c.text ?? '').join('');
    const outcome = (/<permission_denied>/.test(txt) || /ok="false"[^<]*>[^<]*(denied|blocked|suspended|only reading|requires user approval)/i.test(txt)) ? 'denied' : (/<error/.test(txt.slice(0, 120)) || /ok="false"/.test(txt)) ? 'error' : 'ok';
    auditWrite({ ts: new Date().toISOString(), ...who, tool: name, args: auditArgs(args), outcome, ms: Date.now() - t0 });
    return res;
  });
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


// Privacy housekeeping: query strings/fragments were stored by earlier
// versions; strip them once, then rebuild the external-content FTS index.
function stripUrl(raw) {
  try { const u = new URL(raw); u.search = ''; u.hash = ''; return u.toString(); } catch { return raw; }
}
if (historyDb.pragma('user_version', { simple: true }) < 1) {
  const rows = historyDb.prepare("SELECT id, url FROM visits WHERE url LIKE '%?%' OR url LIKE '%#%'").all();
  const upd = historyDb.prepare('UPDATE visits SET url = ? WHERE id = ?');
  historyDb.transaction(() => { for (const r of rows) upd.run(stripUrl(r.url), r.id); })();
  historyDb.exec("INSERT INTO visits_fts(visits_fts) VALUES('rebuild')");
  historyDb.pragma('user_version = 1');
}

const RETENTION_DAYS = Number(process.env.AUREN_HISTORY_RETENTION_DAYS) || 30;
function pruneHistory() {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const r = historyDb.prepare('DELETE FROM visits WHERE visited_at < ?').run(cutoff);
  if (r.changes) historyDb.exec("INSERT INTO visits_fts(visits_fts) VALUES('rebuild')");
}
function clearHistory() {
  historyDb.exec('DELETE FROM visits');
  historyDb.exec("INSERT INTO visits_fts(visits_fts) VALUES('rebuild')");
  historyDb.exec('VACUUM');
}
pruneHistory();
setInterval(pruneHistory, 3_600_000).unref();
function historyEnabled() {
  return process.env.AUREN_HISTORY !== 'off' && loadPerms().history_enabled !== false;
}

// --- Session state ---
let eidCounter = 0;
const tabState = new Map();

function getTabState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, { step: 0, url: '', lastFPs: new Map(), meta: new Map(), eidFrame: new Map() });
  }
  return tabState.get(tabId);
}



// Evaluate in the frame that owns `raw` (a cross-origin iframe has its own session), else in the main page.
function evalEid(client, target, raw, params) {
  const sid = getTabState(target.id).eidFrame.get(raw);
  return sid ? client.send('Runtime.evaluate', params, sid) : client.Runtime.evaluate(params);
}
// Top-left of an OOPIF's content box in the main page's viewport, so frame-local coordinates can be clicked.
async function frameOrigin(client, target, sid) {
  const f = [...(sessionOf(target)?.frames.values() || [])].find(x => x.sessionId === sid);
  if (!f) throw new Error('The iframe is gone; take a new snapshot');
  const st = sessionOf(target);
  if (!st.domEnabled) { await client.DOM.enable(); st.domEnabled = true; }
  const { backendNodeId } = await client.DOM.getFrameOwner({ frameId: f.targetId });
  await client.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => {});
  const { quads } = await client.DOM.getContentQuads({ backendNodeId });
  return { x: quads[0][0], y: quads[0][1] };
}

// An element reference for page-side code: the eid's element, or (after a re-render) the unique element that matches
// what the eid used to be.
function eidExpr(target, raw) {
  const meta = getTabState(target.id).meta.get(raw);
  return `(__L.byEid(${JSON.stringify(raw)})||__L.relocate(${JSON.stringify(meta || null)}))`;
}

// --- CDP helpers ---
// A dead/unreachable host makes the TCP connect itself hang for many
// seconds (well past the intended backoff budget), so each attempt gets
// its own hard cap - otherwise 4 attempts against an unreachable host can
// take 30s+ instead of the ~7.5s the retry message promises.
const CONNECT_ATTEMPT_TIMEOUT_MS = 1500;
const DEFAULT_TAB_TTL_MS = 1000;
const PROBE_IDLE_MS = 15_000;

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

  // With no tab_id the agent means "the active tab". Resolve it through a short-lived
  // cache and then reuse that tab's pooled session, instead of opening (and leaking) a
  // fresh CDP connection on every call.
  async resolveDefaultTabId() {
    const now = Date.now();
    if (this._defaultId && now - this._defaultAt < DEFAULT_TAB_TTL_MS && this._sessions.has(this._defaultId)) return this._defaultId;
    const t = await getTarget(null);
    if (!t) throw new Error('No open page found in Auren');
    this._defaultId = t.id; this._defaultAt = now;
    return t.id;
  }

  async get(tabId) {
    const existing = this._sessions.get(tabId);
    if (!existing) return null;
    // A socket close already evicts the session (see 'disconnect' below), so a probe is
    // only worth paying for when the connection has sat idle long enough to go half-open.
    if (Date.now() - existing.lastUsed < PROBE_IDLE_MS) { existing.lastUsed = Date.now(); return existing; }
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
    // Page events are needed for load/navigation waits. Runtime.enable is deliberately NOT
    // called: nothing here uses execution-context events, it makes Chrome buffer console and
    // context traffic for the whole session, and it is a well-known automation tell.
    await client.Page.enable();

    let lastVisitId = null;
    client.Page.on('frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      // Query strings and fragments routinely carry session tokens and search
      // terms; the path memory only needs where the user went.
      const url = stripUrl(frame.url);
      if (!historyEnabled()) return;
      // after stripping, SPA route changes repeat the same URL; collapse them
      const prev = historyDb.prepare('SELECT url, visited_at FROM visits WHERE tab_id = ? ORDER BY id DESC LIMIT 1').get(target.id);
      if (prev && prev.url === url && Date.now() - prev.visited_at < 30_000) return;
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

    const session = { client, target, lastUsed: Date.now(), dialog: null, popups: [], frames: new Map() };
    // Cross-origin iframes live in their own renderer process and are separate CDP targets. Attach to them (flat
    // sessions over this same socket) so snapshots, find and act can see and drive their content.
    client.on('Target.attachedToTarget', (p) => {
      if (p.targetInfo?.type === 'iframe') session.frames.set(p.sessionId, { sessionId: p.sessionId, targetId: p.targetInfo.targetId, url: p.targetInfo.url });
    });
    client.on('Target.detachedFromTarget', (p) => { session.frames.delete(p.sessionId); });
    client.on('Target.targetInfoChanged', (p) => { const f = session.frames.get(p.targetInfo?.sessionId); if (f) f.url = p.targetInfo.url; });
    // only iframes (not workers, service workers, ...): everything else would just add sessions nobody uses
    await client.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }, { exclude: true }] })
      .catch(() => client.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {}));
    // A native dialog blocks the page; remember it so tools can say so instead of hanging. window.open / target=_blank
    // popups are remembered so the action that caused them can report the new tab.
    client.Page.on('javascriptDialogOpening', (p) => { session.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt }; });
    client.Page.on('javascriptDialogClosed', () => { session.dialog = null; });
    client.Page.on('windowOpen', (p) => { session.popups.push({ url: p.url, name: p.windowName, at: Date.now() }); if (session.popups.length > 20) session.popups.shift(); });
    this._sessions.set(target.id, session);
    return session;
  }

  async acquire(tabId) {
    const delays = [500, 1000, 2000, 4000];
    let lastErr;
    for (let i = 0; i <= delays.length; i++) {
      try {
        const id = tabId ?? (await this.resolveDefaultTabId());
        return (await this.get(id)) ?? (await this.open(id));
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
async function withCDP(tabId, fn, opts = {}) {
  const session = await sessions.acquire(tabId ?? null);
  session.lastUsed = Date.now();
  if (session.dialog && !opts.allowDialog) {
    throw new Error(`A JavaScript dialog is open on this tab (${session.dialog.type}: "${String(session.dialog.message).slice(0, 120)}"). Call browser_dialog with action accept or dismiss first.`);
  }
  try {
    return await fn(session.client, session.target, session);
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
  if (attrs.opts) a += ` opts="${escapeXml(attrs.opts)}"`;
  if (attrs.ctx) a += ` ctx="${escapeXml(attrs.ctx)}"`;
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
      state.meta.set(item.attrs.eid, { kind: item.kind, text: item.text, ctx: item.attrs.ctx || '' });
      const fp = `${item.kind}|${item.text}|${item.attrs.href || ''}`;
      newFPs.set(fp, { eid: item.attrs.eid, kind: item.kind, text: item.text, val: item.attrs.val });
    }
    const trimmed = region.items.length - added + (region.more || 0);
    if (trimmed > 0) {
      wasTruncated = true;
      regionBody.push(`    <!-- ${trimmed} more; use region="${escapeXml(region.name)}" to see all -->`);
    }
    bodyLines.push(rOpen, ...regionBody, rClose);
  }

  state.lastFPs = newFPs;

  // FIX 3: include truncation signal in state tag so callers can detect it programmatically
  const truncatedAttr = (wasTruncated ? ` truncated="true" total_items="${totalItemCount}"` : '') + (data.hidden > 0 ? ` hidden_skipped="${data.hidden}"` : '');
  const headerLines = [
    `<state step="${state.step}" title="${escapeXml(title)}" url="${escapeXml(url)}"${truncatedAttr}>`,
    `  <meta view="${viewport[0]}x${viewport[1]}" scroll="${scroll[0]},${scroll[1]}" />`,
    `  ${stateTag}`,
  ];

  return [...headerLines, ...bodyLines, '</state>'].join('\n');
}

// In-page "DOM quiet for quiet ms (or max ms)" wait, as source text for embedding in other evaluates.
const SETTLE_PROMISE = (quiet, max) => `await new Promise(res=>{let t;const done=()=>{o.disconnect();res(1)};const o=new MutationObserver(()=>{clearTimeout(t);t=setTimeout(done,${Number(quiet)})});o.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});t=setTimeout(done,${Number(quiet)});setTimeout(done,${Number(max)});});\n`;

// --- Snapshot JS builder ---
function snapshotJs(mode, region, maxItems, settleOpts) {
  const mStr = JSON.stringify(mode || 'interactive');
  const rExpr = region ? `(__L.deepQuery(${JSON.stringify(region)},1)[0]||null)` : 'null';
  const mN = Number(maxItems) || 30;
  const startN = eidCounter;

  return `(async function(){
${settleOpts ? SETTLE_PROMISE(settleOpts.quiet, settleOpts.max) : ''}${PAGE_LIB}try{
let n=${startN};let hid=0;
__L.clearEids();
const mode=${mStr};
const scopeEl=${rExpr};
const maxN=${mN};
const sel=mode==='full'?__L.FULL:mode==='outline'?__L.OUTLINE:__L.INTERACTIVE;
const LM=[['nav','nav,[role="navigation"]'],['header','header,[role="banner"]'],['main','main,[role="main"],[role="search"]'],['aside','aside,[role="complementary"]'],['footer','footer,[role="contentinfo"]']];
function regionOf(el){
  for(let e=el;e;e=null){
    let p=e;
    while(p){
      for(const [nm,q] of LM){try{if(p.matches(q))return nm;}catch(x){}}
      p=p.parentElement||(p.getRootNode&&p.getRootNode().host)||null;
    }
  }
  return 'page';
}
const info={url:location.href,title:document.title,scroll:[Math.round(window.scrollX),Math.round(window.scrollY)],viewport:[window.innerWidth,window.innerHeight]};
const pool=scopeEl?__L.all(scopeEl):__L.all();
const picked=[];
for(const e of pool){
  let ok=false;try{ok=e.matches(sel);}catch(x){}
  if(!ok)continue;
  if(!__L.vis(e)){hid++;continue;}
  picked.push(e);
}
const groups=new Map();
for(const e of picked){
  const r=scopeEl?'content':regionOf(e);
  if(!groups.has(r))groups.set(r,[]);
  groups.get(r).push(e);
}
const order=scopeEl?['content']:['nav','header','main','aside','footer','page'];
const regions=[];
for(const r of order){
  const els=groups.get(r);
  if(!els||!els.length)continue;
  // over the cap: show what is on screen first (then the rest in page order), but list everything in page order
  let take=els;
  if(els.length>maxN){
    const vh=window.innerHeight;
    const on=e=>{try{const r=e.getBoundingClientRect();return r.bottom>0&&r.top<vh;}catch(x){return false;}};
    const idx=new Map(els.map((e,i)=>[e,i]));
    take=[...els.filter(on),...els.filter(e=>!on(e))].slice(0,maxN).sort((a,b)=>idx.get(a)-idx.get(b));
  }
  const items=take.map(el=>{const it=__L.info(el);const eid=it.kind+'-'+(++n);el.setAttribute('data-eid',eid);it.attrs.eid=eid;it._el=el;return it;});
  // controls whose names are not unique (six "Add to cart" buttons) or empty get their row context
  const seen=new Map();
  for(const it of items){const k=it.kind+'|'+it.text;seen.set(k,(seen.get(k)||0)+1);}
  for(const it of items){
    if(it.kind==='h'||it.kind==='alert')continue;
    if(!it.text||seen.get(it.kind+'|'+it.text)>1){const c=__L.context(it._el,it.text);if(c)it.attrs.ctx=c;}
    delete it._el;
  }
  regions.push({name:r,items,more:els.length-take.length});
}
return JSON.stringify({info,regions,nextN:n,hidden:hid});
}catch(e){return JSON.stringify({error:e.message});}
})()`;
}

async function takeSnapshot(client, resolvedTabId, opts = {}) {
  const { mode = 'interactive', region = null, maxItems = 30, isDiff = false, settle: st = null, prevUrl } = opts;
  const state = getTabState(resolvedTabId);
  const js = snapshotJs(mode, region, maxItems, st);
  const result = await client.Runtime.evaluate({ expression: js, returnByValue: true, awaitPromise: true });
  const raw = result?.result?.value;
  if (!raw) throw new Error(result?.exceptionDetails ? 'Snapshot script failed' : 'Snapshot returned no value');
  const data = JSON.parse(raw);
  if (data.info) { const b = domainBlocks(data.info.url, 'read'); if (b) return `<permission_denied>${escapeXml(b.reason)}</permission_denied>`; }
  if (typeof data.nextN === 'number') eidCounter = data.nextN;
  // elements inside cross-origin iframes (separate processes) are added as one region per frame
  state.eidFrame.clear();
  const owner = sessions._sessions.get(resolvedTabId);
  if (owner?.frames.size && !region) {
    // One CDP round trip per frame, all in flight at once (a page full of ad frames must not cost frames x link latency),
    // each frame given its own eid range so the numbering stays unique, and capped so a pathological page stays bounded.
    const frames = [...owner.frames.values()].filter(f => !/^(about:blank|chrome-error:)/.test(f.url || '')).slice(0, MAX_FRAME_SNAPSHOTS);
    const base = eidCounter;
    const results = await Promise.all(frames.map((fr, i) => {
      const expression = snapshotJs(mode, null, maxItems, null).replace(`let n=${base};`, `let n=${base + (i + 1) * 1000};`);
      return client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, fr.sessionId).then(rr => JSON.parse(rr?.result?.value || '{}')).catch(() => null);
    }));
    results.forEach((d, i) => {
      if (!d || !d.regions) return;
      const fr = frames[i];
      const items = d.regions.flatMap(x => x.items);
      for (const it of items) state.eidFrame.set(it.attrs.eid, fr.sessionId);
      let host = ''; try { host = new URL(fr.url).host; } catch { /* odd url */ }
      if (items.length) data.regions.push({ name: `frame ${host}`, items, more: d.regions.reduce((a, x) => a + (x.more || 0), 0) });
      data.hidden = (data.hidden || 0) + (d.hidden || 0);
    });
    eidCounter = base + (frames.length + 1) * 1000;
  }
  // when the caller knows the URL from before the action, decide diff-vs-baseline from the
  // snapshot itself instead of paying another round trip to ask the page for location.href
  const navigated = prevUrl !== undefined && data.info ? data.info.url !== prevUrl : undefined;
  state.lastNavigated = navigated;
  return buildXml(data, state, navigated !== undefined ? !navigated : isDiff);
}

// --- Event-driven waits & shared actions (used by the individual tools and by browser_exec) ---
// Every fixed sleep that used to follow an action is replaced by waiting for the thing the
// sleep was guessing at: the load event, or the DOM going quiet. Round trips to the browser are
// the other cost (Oracle -> Mac is ~35 ms each), so each action is kept to the minimum number:
// locate+url (1), input events pipelined (1), then settle+snapshot fused into a single evaluate (1).
function watch(client, name, ms, pred = () => true) {
  const w = { fired: false };
  let timer;
  const handler = (arg) => { if (!w.fired && pred(arg)) { w.fired = true; w.cancel(); w.resolve(true); } };
  w.promise = new Promise(resolve => { w.resolve = resolve; timer = setTimeout(() => { w.cancel(); resolve(false); }, ms); });
  w.cancel = () => { clearTimeout(timer); client.removeListener(name, handler); };
  client.on(name, handler);
  return w;
}

// Resolves once the page has had no DOM mutations for quietMs (or maxMs elapsed).
// Swallows errors: a navigation destroys the execution context, which callers detect via watch().
function settle(client, quietMs = 50, maxMs = 400) {
  return client.Runtime.evaluate({
    expression: `(async function(){${SETTLE_PROMISE(quietMs, maxMs)}return 1;})()`,
    awaitPromise: true, returnByValue: true
  }).catch(() => null);
}

async function liveUrl(client) {
  return (await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true }))?.result?.value || '';
}

// Start watching for a navigation caused by the action about to be performed.
function watchNav(client) {
  return {
    navW: watch(client, 'Page.frameNavigated', 30000, ({ frame }) => !frame.parentId),
    loadW: watch(client, 'Page.loadEventFired', 15000),
    cancel() { this.navW.cancel(); this.loadW.cancel(); },
  };
}

// After an input action: wait for the page to settle and (optionally) take the snapshot in the same
// evaluate. If a navigation destroys the page mid-flight, wait for the new page's load and retry.
async function afterAction(client, target, ctx, snap, quiet = 50, max = 400) {
  try {
    let xml = null;
    if (ctx.navW.fired) {
      // navigation already started (anchor click): wait for it, then one settled snapshot
      await ctx.loadW.promise;
      if (snap) xml = await takeSnapshot(client, target.id, { ...snap, settle: { quiet: 40, max: 300 }, prevUrl: ctx.prevUrl });
      else await settle(client, 40, 300);
      return { xml, didNavigate: true };
    }
    if (snap) xml = await takeSnapshot(client, target.id, { ...snap, settle: { quiet, max }, prevUrl: ctx.prevUrl });
    else await settle(client, quiet, max);
    if (ctx.navW.fired) {
      // navigation started while we were settling: let it finish, then take the real view
      await ctx.loadW.promise;
      if (snap) xml = await takeSnapshot(client, target.id, { ...snap, settle: { quiet: 40, max: 300 }, prevUrl: ctx.prevUrl });
      else await settle(client, 40, 300);
    }
    return { xml, didNavigate: ctx.navW.fired || (snap ? getTabState(target.id).lastNavigated === true : false) };
  } catch (e) {
    // execution context destroyed by a navigation under us: wait for load and retry once
    if (!ctx.navW.fired) await new Promise(r => setTimeout(r, 30));
    if (ctx.navW.fired || /context|destroyed|navigat|target closed/i.test(e.message)) {
      await ctx.loadW.promise;
      const xml = snap ? await takeSnapshot(client, target.id, { ...snap, settle: { quiet: 40, max: 300 }, prevUrl: ctx.prevUrl }) : null;
      return { xml, didNavigate: true };
    }
    throw e;
  } finally { ctx.cancel(); }
}

async function actNavigate(client, target, url, snap = null) {
  { const b = domainBlocks(url, 'read'); if (b) return { denied: b }; }
  // register the listener BEFORE navigating: awaiting the event afterwards can miss it entirely
  const loadW = watch(client, 'Page.loadEventFired', 15000);
  const r = await client.Page.navigate({ url });
  if (r.errorText) { loadW.cancel(); return { error: `Navigation failed: ${r.errorText}` }; }
  await loadW.promise;
  if (snap) return { xml: await takeSnapshot(client, target.id, { ...snap, settle: { quiet: 40, max: 300 } }) };
  await settle(client, 40, 300);
  return {};
}

// A native alert/confirm/prompt blocks the page's main thread, so the click that opened it never acknowledges. Race the
// pending work against the dialog event and return control with the dialog described, instead of hanging.
function raceDialog(client, work) {
  const w = watch(client, 'Page.javascriptDialogOpening', 120000);
  return Promise.race([work.then(() => 'done'), w.promise.then(v => (v ? 'dialog' : 'timeout'))]).finally(() => w.cancel());
}
function dialogXml(session) {
  const d = session?.dialog;
  return d ? `<dialog type="${escapeXml(d.type)}" message="${escapeXml(String(d.message).slice(0, 300))}"${d.defaultPrompt ? ` default="${escapeXml(d.defaultPrompt)}"` : ''}>A JavaScript dialog is open and blocks the page. Call browser_dialog with action accept or dismiss.</dialog>` : '';
}
// Popups opened by the action (window.open, target=_blank) since `since`: report their tab ids.
async function popupXml(session, since) {
  const fresh = (session?.popups || []).filter(p => p.at >= since);
  if (!fresh.length) return '';
  let tabs = [];
  try { tabs = (await CDP.List(MAC_CDP)).filter(t => t.type === 'page'); } catch { /* best effort */ }
  const lines = fresh.map(p => {
    const t = tabs.find(x => x.url === p.url) || tabs.find(x => x.url.startsWith(p.url));
    return `<new_tab${t ? ` id="${escapeXml(t.id)}"` : ''} url="${escapeXml(String(p.url).slice(0, 200))}">Opened by the last action; pass tab_id to act on it, or browser_select_tab to switch.</new_tab>`;
  });
  return '\n' + lines.join('\n');
}
const sessionOf = (target) => sessions._sessions.get(target.id);
const MAX_FRAME_SNAPSHOTS = 8;

async function actClick(client, target, raw, snap = null) {
  const isEid = EID_RE.test(raw);
  const session = sessionOf(target);
  const fsid = isEid ? getTabState(target.id).eidFrame.get(raw) : null;
  const elResult = await evalEid(client, target, raw, {
    expression: `(function(){${PAGE_LIB}
      const el=${isEid ? eidExpr(target, raw) : `__L.deepQuery(${JSON.stringify(raw)},1)[0]`};
      if(!el)return null;
      const c=__L.center(el);
      const f=el.closest('form');const ty=(el.getAttribute('type')||'').toLowerCase();const tg=el.tagName.toLowerCase();
      const submits=!!f&&((tg==='button'&&(ty===''||ty==='submit'))||(tg==='input'&&(ty==='submit'||ty==='image')));
      const a=el.closest('a[href]');
      const covered=(()=>{try{if(el.ownerDocument!==document)return'';let top=document.elementFromPoint(c.x,c.y);while(top&&top.shadowRoot&&top.shadowRoot.elementFromPoint){const inner=top.shadowRoot.elementFromPoint(c.x,c.y);if(!inner||inner===top)break;top=inner;}
        if(!top)return'';for(let e=el;e;e=__L.parentOf(e))if(e===top)return'';for(let e=top;e;e=__L.parentOf(e))if(e===el)return'';
        return top.tagName.toLowerCase()+(top.id?'#'+top.id:'')+' "'+(top.innerText||'').trim().slice(0,40)+'"';}catch(e){return''}})();
      return JSON.stringify({x:c.x,y:c.y,tag:el.tagName.toLowerCase(),href:a?a.href:'',target:a?(a.getAttribute('target')||''):'',url:location.href,submits,covered});
    })()`,
    returnByValue: true
  });
  if (!elResult?.result?.value) return { error: `Element not found: ${raw}` };
  const el = JSON.parse(elResult.result.value);
  if (fsid) { const o = await frameOrigin(client, target, fsid); el.x += o.x; el.y += o.y; }
  { const b = domainBlocks(el.url, 'write'); if (b) return { denied: b }; }
  if (el.submits) { const p = checkPermission('form_submit'); if (!p.allowed) return { denied: p }; }
  if (el.href && /^https?:/i.test(el.href)) { const b = domainBlocks(el.href, 'read'); if (b) return { denied: b }; }
  const startedAt = Date.now();
  const ctx = { ...watchNav(client), prevUrl: el.url };
  // A plain link to another document is opened directly (deterministic, one round trip). Fragment-only links never fire
  // a load event, links with a target open a popup, and links with handlers may preventDefault: those get a real click.
  const sameDoc = el.href && el.href.split('#')[0] === el.url.split('#')[0];
  const direct = el.tag === 'a' && el.href && /^https?:/i.test(el.href) && !sameDoc && (!el.target || el.target === '_self');
  try {
    if (direct) {
      await client.Page.navigate({ url: el.href });
      await ctx.loadW.promise;
      ctx.navW.fired = true;
    } else {
      // Real pointer events only (a JS .click() followed by a mouse click would activate
      // toggles/checkboxes twice and undo them). Press and release are pipelined: one round trip.
      const work = Promise.all([
        client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: el.x, y: el.y }),
        client.Input.dispatchMouseEvent({ type: 'mousePressed', x: el.x, y: el.y, button: 'left', clickCount: 1 }),
        client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: el.x, y: el.y, button: 'left', clickCount: 1 }),
      ]);
      if ((await raceDialog(client, work)) === 'dialog') {
        ctx.cancel();
        return { xml: dialogXml(session) };
      }
    }
  } catch (e) { ctx.cancel(); throw e; }
  const r = await afterAction(client, target, ctx, snap);
  const extra = await popupXml(session, startedAt);
  const warn = el.covered ? `\n<note covered_by="${escapeXml(el.covered)}">The click landed on another element covering the target; dismiss the overlay first if nothing happened.</note>` : '';
  if (r?.xml !== undefined && (extra || warn)) r.xml += warn + extra;
  return r;
}

async function actHover(client, target, raw, snap = null) {
  const isEid = EID_RE.test(raw);
  const hsid = isEid ? getTabState(target.id).eidFrame.get(raw) : null;
  const r = await evalEid(client, target, raw, {
    expression: `(function(){${PAGE_LIB}
      const el=${isEid ? eidExpr(target, raw) : `__L.deepQuery(${JSON.stringify(raw)},1)[0]`};
      if(!el)return null;
      const c=__L.center(el);
      return JSON.stringify({x:c.x,y:c.y,url:location.href});
    })()`,
    returnByValue: true
  });
  if (!r?.result?.value) return { error: `Element not found: ${raw}` };
  const el = JSON.parse(r.result.value);
  if (hsid) { const o = await frameOrigin(client, target, hsid); el.x += o.x; el.y += o.y; }
  { const b = domainBlocks(el.url, 'read'); if (b) return { denied: b }; }
  // two moves: the first places the pointer, the second guarantees mouseenter/mouseover on the final target
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: Math.max(1, el.x - 3), y: Math.max(1, el.y - 3) });
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: el.x, y: el.y });
  await settle(client, 60, 400);
  if (snap) return { xml: await takeSnapshot(client, target.id, snap) };
  return {};
}

async function actFill(client, target, raw, value, snap = null) {
  const allowSensitive = checkPermission('sensitive_input').allowed;
  const isEid = EID_RE.test(raw);
  const r = await evalEid(client, target, raw, {
    expression: `(function(){${PAGE_LIB}
      const el=${isEid ? eidExpr(target, raw) : `__L.deepQuery(${JSON.stringify(raw)},1)[0]`};
      if(!el)return'Not found';
      const ty=(el.getAttribute('type')||'').toLowerCase();const ac=(el.getAttribute('autocomplete')||'').toLowerCase();
      const nm=((el.getAttribute('name')||'')+' '+(el.id||'')).toLowerCase();
      const sensitive=ty==='password'||/^(cc-|one-time-code|new-password|current-password)/.test(ac)||/(card.?num|cvv|cvc|ssn|social.?sec)/.test(nm);
      if(sensitive&&!${allowSensitive})return JSON.stringify({sensitive:true,url:location.href});
      if(!__L.fillable(el))return JSON.stringify({notFillable:true,tag:el.tagName.toLowerCase(),name:__L.name(el),url:location.href});
      el.focus();
      const want=${JSON.stringify(value)};
      if(el.tagName==='SELECT'){
        const lc=want.toLowerCase();
        const o=[...el.options].find(o=>o.value===want)||[...el.options].find(o=>o.textContent.trim().toLowerCase()===lc)||[...el.options].find(o=>o.textContent.trim().toLowerCase().includes(lc));
        if(!o)return JSON.stringify({noOption:true,options:[...el.options].map(o=>o.textContent.trim()).slice(0,12),url:location.href});
        el.value=o.value;
      }else if(el.isContentEditable&&!('value' in el)){
        el.textContent=want;
      }else{
        const desc=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');
        if(desc&&desc.set)desc.set.call(el,want);
        else el.value=want;
      }
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({ok:true,url:location.href});
    })()`,
    returnByValue: true
  });
  if (r?.result?.value === 'Not found') return { error: `Element not found: ${raw}` };
  const fr = JSON.parse(r?.result?.value || '{}');
  { const b = fr.url ? domainBlocks(fr.url, 'write') : null; if (b) return { denied: b }; }
  if (fr.sensitive) return { denied: { reason: "This is a password / payment / one-time-code field; agent input there is blocked. The user can allow it with 'auren-perm set sensitive_input allow'." } };
  if (fr.notFillable) return { error: `Cannot fill: ${raw} is a <${fr.tag}> ("${fr.name}"), not a text field. Click it first if it opens a search box, or use browser_find with a CSS selector such as input[type=search].` };
  if (fr.noOption) return { error: `No option matches '${value}'. Options: ${fr.options.join(' | ')}` };
  // fill never navigates by itself, so no navigation watch is needed
  return afterAction(client, target, { navW: { fired: false, cancel() {} }, loadW: { promise: Promise.resolve(true), cancel() {} }, cancel() {} }, snap, 30, 150);
}

async function actScroll(client, target, direction, pixels, snap = null) {
  const expr = direction === 'top' ? 'window.scrollTo(0,0)'
    : direction === 'bottom' ? 'window.scrollTo(0,document.body.scrollHeight)'
    : direction === 'up' ? `window.scrollBy(0,-${Number(pixels) || 500})`
    : `window.scrollBy(0,${Number(pixels) || 500})`;
  await client.Runtime.evaluate({ expression: expr + ';new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))', awaitPromise: true });
  if (snap) return { xml: await takeSnapshot(client, target.id, snap) };
  return {};
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};
async function actPress(client, target, key, snap = null) {
  const k = KEYS[key];
  if (!k) return { error: `Unsupported key '${key}'. Supported: ${Object.keys(KEYS).join(', ')}` };
  const st0 = JSON.parse((await client.Runtime.evaluate({ expression: `JSON.stringify({url:location.href,inForm:!!(document.activeElement&&document.activeElement.form)})`, returnByValue: true }))?.result?.value || '{}');
  { const b = domainBlocks(st0.url || '', 'write'); if (b) return { denied: b }; }
  if (key === 'Enter' && st0.inForm) { const p = checkPermission('form_submit'); if (!p.allowed) return { denied: p }; }
  const prevUrl = st0.url || '';
  const ctx = { ...watchNav(client), prevUrl };
  try {
    await Promise.all([
      client.Input.dispatchKeyEvent({ type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text }),
      client.Input.dispatchKeyEvent({ type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk }),
    ]);
  } catch (e) { ctx.cancel(); throw e; }
  return afterAction(client, target, ctx, snap);
}

// Event-driven wait: resolves as soon as the selector/text appears (MutationObserver in the page),
// re-arming across navigations until the deadline.
async function actWaitFor(client, { selector, text, timeout_ms = 5000 }) {
  const deadline = Date.now() + Math.min(Number(timeout_ms) || 5000, 15000);
  const check = `(function(){${selector ? `if(document.querySelector(${JSON.stringify(selector)}))return true;` : ''}${text ? `if((document.body&&document.body.innerText||'').includes(${JSON.stringify(text)}))return true;` : ''}return false;})()`;
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    try {
      const r = await client.Runtime.evaluate({
        expression: `new Promise(res=>{const c=()=>${check};if(c())return res(true);const o=new MutationObserver(()=>{if(c()){o.disconnect();res(true)}});o.observe(document,{subtree:true,childList:true,characterData:true,attributes:true});setTimeout(()=>{o.disconnect();res(false)},${left});})`,
        awaitPromise: true, returnByValue: true });
      return r?.result?.value ? {} : { error: `wait_for timed out after ${timeout_ms}ms` };
    } catch { await new Promise(r => setTimeout(r, 80)); } // context destroyed by a navigation: re-arm
  }
  return { error: `wait_for timed out after ${timeout_ms}ms` };
}

const EID_RE = /^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/;
const errXml = (tool, msg) => ({ content: [{ type: 'text', text: `<error tool="${tool}">${escapeXml(msg)}</error>` }] });

// --- MCP server ---
function buildServer(auth = LEGACY_AUTH) {
  const server = new McpServer({ name: 'auren-browser', version: '2.1.2' });
  instrument(server, auth);

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
    description: 'Navigate to a URL in Auren. Returns a compact baseline snapshot of the loaded page - no need to call browser_snapshot afterwards.',
    inputSchema: { url: z.string(), tab_id: z.string().optional() }
  }, async ({ url, tab_id }) => {
    try {
      const perm = checkPermission('navigation');
      if (!perm.allowed) return denied(perm);
      // javascript:/data:/file: URLs would run script or read local files
      // while bypassing the js_execute permission gate.
      let parsed;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return errXml('browser_navigate', 'Only http(s) URLs are allowed');
      return await withCDP(tab_id, async (client, target) => {
        const r = await actNavigate(client, target, url, { mode: 'interactive', isDiff: false });
        if (r.denied) return denied(r.denied);
        if (r.error) return errXml('browser_navigate', r.error);
        return { content: [{ type: 'text', text: r.xml }] };
      });
    } catch (e) {
      return errXml('browser_navigate', e.message);
    }
  });
  server.registerTool('browser_click', {
    description: 'Click a UI element by eid (e.g. "btn-3") from a recent snapshot, or CSS selector. Prefer eid when available. Returns a baseline snapshot if the click caused navigation, or a mutation diff snapshot for in-page changes.',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), tab_id: z.string().optional() }
  }, async ({ eid, selector, tab_id }) => {
    try {
      const perm = checkPermission('click');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client, target) => {
        const raw = eid || selector;
        if (!raw) return errXml('browser_click', 'Provide eid or selector');
        const r = await actClick(client, target, raw, { mode: 'interactive' });
        if (r.denied) return denied(r.denied);
        if (r.error) return errXml('browser_click', r.error);
        return { content: [{ type: 'text', text: r.xml }] };
      });
    } catch (e) {
      return errXml('browser_click', e.message);
    }
  });
  server.registerTool('browser_fill', {
    description: 'Fill an input field by eid (e.g. "inp-5") from a recent snapshot, or CSS selector. Prefer eid when available. Returns a compact snapshot after filling - no need to call browser_snapshot afterwards.',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), value: z.string(), tab_id: z.string().optional() }
  }, async ({ eid, selector, value, tab_id }) => {
    try {
      const perm = checkPermission('fill');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client, target) => {
        const raw = eid || selector;
        if (!raw) return errXml('browser_fill', 'Provide eid or selector');
        const r = await actFill(client, target, raw, value, { mode: 'interactive', isDiff: true });
        if (r.denied) return denied(r.denied);
        if (r.error) return errXml('browser_fill', r.error);
        return { content: [{ type: 'text', text: r.xml }] };
      });
    } catch (e) {
      return errXml('browser_fill', e.message);
    }
  });
  // Resolve a text/CSS query on the page with the shared library (accessible names, shadow DOM, iframes) and mark the
  // hits with eids. interactiveOnly=false also matches plain text elements (used for reads and as a click fallback).
  const resolveJs = (q, limit, interactiveOnly, intent) => `(function(){${PAGE_LIB}
    let n=${eidCounter};
    const hits=__L.resolve(${JSON.stringify(q)},${limit},${interactiveOnly},${JSON.stringify(intent || null)});
    const items=hits.map(h=>{const it=__L.info(h.el);const eid=it.kind+'-'+(++n);h.el.setAttribute('data-eid',eid);it.attrs.eid=eid;it.score=h.score;const c=__L.context(h.el,it.text);if(c)it.attrs.ctx=c;return it;});
    return JSON.stringify({items,nextN:n,tie:hits.length>1&&hits[1].score===hits[0].score});
  })()`;
  async function resolveQuery(client, target, q, limit, interactiveOnly, intent) {
    const session = sessionOf(target), state = getTabState(target.id);
    const run = async (inter, sid) => {
      const params = { expression: resolveJs(q, limit, inter, intent), returnByValue: true };
      const r = sid ? await client.send('Runtime.evaluate', params, sid).catch(() => null) : await client.Runtime.evaluate(params);
      const f = JSON.parse(r?.result?.value || '{"items":[]}');
      if (typeof f.nextN === 'number') eidCounter = f.nextN;
      return f;
    };
    for (const inter of interactiveOnly ? [true, false] : [false]) {
      let found = await run(inter, null);
      if (!found.items.length && session?.frames.size) {
        for (const fr of session.frames.values()) {
          const ff = await run(inter, fr.sessionId);
          if (ff.items.length) { found = ff; for (const it of ff.items) state.eidFrame.set(it.attrs.eid, fr.sessionId); break; }
        }
      }
      if (found.items.length) {
        for (const it of found.items) state.meta.set(it.attrs.eid, { kind: it.kind, text: it.text, ctx: it.attrs.ctx || '' });
        return found;
      }
    }
    return { items: [] };
  }
  const ambiguityNote = (q, found) => found.tie
    ? `\n<note ambiguous="${found.items.length}">"${escapeXml(q)}" matched several elements equally well; acted on ${escapeXml(found.items[0].attrs.eid)}. Others: ${found.items.slice(1).map(i => `${i.attrs.eid}${i.attrs.ctx ? ` (${escapeXml(i.attrs.ctx)})` : ''}`).join(', ')}. Use browser_find, then an eid.</note>`
    : '';

  server.registerTool('browser_act', {
    description: 'Find an element by its visible name (label, placeholder, button text, aria-label) or CSS selector and act on it in one step. action: "click", "fill", "read". For fill, provide value (for a <select>, the option text or value). Pierces shadow DOM and same-origin iframes. Eliminates the snapshot→find→act round trip.',
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
        if (!perm.allowed) return { content: [{ type: 'text', text: `<permission_denied>${perm.reason}</permission_denied>` }] };
      }
      return await withCDP(tab_id, async (client, target) => {
        const found = await resolveQuery(client, target, find, 3, action !== 'read', action);
        if (!found.items.length) return { content: [{ type: 'text', text: `<error>browser_act: element not found: ${escapeXml(find)}</error>` }] };
        const top = found.items[0].attrs.eid;
        const note = ambiguityNote(find, found);
        if (action === 'read') {
          const r = await evalEid(client, target, top, { expression: `(function(){${PAGE_LIB}const el=__L.byEid(${JSON.stringify(top)});return el?__L.textOf(el).slice(0,2000):'[not found]';})()`, returnByValue: true });
          return { content: [{ type: 'text', text: (r?.result?.value ?? '[no content]') + note }] };
        }
        if (action === 'fill') {
          if (value === undefined) return { content: [{ type: 'text', text: '<error>browser_act fill requires value</error>' }] };
          const r = await actFill(client, target, top, value, { mode: 'interactive', isDiff: true });
          if (r.denied) return denied(r.denied);
          if (r.error) return errXml('browser_act', r.error);
          return { content: [{ type: 'text', text: r.xml + note }] };
        }
        const r = await actClick(client, target, top, { mode: 'interactive' });
        if (r.denied) return denied(r.denied);
        if (r.error) return errXml('browser_act', r.error);
        return { content: [{ type: 'text', text: r.xml + note }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_act">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_find', {
    description: 'Find elements by visible name (label, placeholder, button text, aria-label) or CSS selector. Returns up to 5 matches, best first, with eids and row context for disambiguation. Pierces shadow DOM and same-origin iframes. Use when you need to locate an element without a full page snapshot.',
    inputSchema: { query: z.string(), tab_id: z.string().optional() }
  }, async ({ query, tab_id }) => {
    try {
      const perm = checkPermission('read');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client, target) => {
        const found = await resolveQuery(client, target, query, 5, true);
        if (!found.items.length) {
          return { content: [{ type: 'text', text: `<results count="0">No elements matching: ${escapeXml(query)}</results>` }] };
        }
        const lines = [`<results count="${found.items.length}">`];
        for (const item of found.items) lines.push(buildElementXml(item).replace(/^    /, '  '));
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
          selExpr = `__L.byEid(${JSON.stringify(region)})`;
        } else if (lmMap[region]) {
          selExpr = `(__L.deepQuery(${JSON.stringify(lmMap[region])},1)[0]||null)`;
        } else {
          selExpr = `(__L.deepQuery(${JSON.stringify(region)},1)[0]||null)`;
        }

        const r = await client.Runtime.evaluate({
          expression: `(function(){${PAGE_LIB}const el=${selExpr};if(!el)return'[not found]';const t=(el.innerText||el.textContent||'').replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]|[\\u{E0000}-\\u{E007F}]/gu,'').replace(/\\n{3,}/g,'\\n\\n').trim();return t.length>${cap}?t.slice(0,${cap})+'\\n[truncated]':t;})()`,
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
        return { content: [{ type: 'text', text: JSON.stringify(r.result.value ?? r.result.description) ?? 'undefined' }] };
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
  }, async ({ direction = 'down', pixels = 500, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        const r = await actScroll(client, target, direction, pixels, { mode: 'interactive', isDiff: false });
        return { content: [{ type: 'text', text: r.xml }] };
      });
    } catch (e) {
      return errXml('browser_scroll', e.message);
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

  server.registerTool('browser_exec', {
    description: 'Run a sequence of browser steps in ONE call (one round trip instead of one per step). steps: array (max 25) of {op, ...}. ops: navigate{url} | click{eid|selector} | hover{eid|selector} | fill{eid|selector,value} | press{key: Enter|Tab|Escape|Backspace|Arrow*|Space} | scroll{direction,pixels} | wait_for{selector|text,timeout_ms} | read{region,max_chars} | snapshot{mode,region,max_items} | js{code}. Stops at the first failing step. Each step is permission-checked like its single-step tool. Returns a per-step summary plus the output of read/snapshot/js steps and, unless the last step already returns a view, a final interactive snapshot.',
    inputSchema: {
      steps: z.array(z.object({
        op: z.enum(['navigate', 'click', 'hover', 'fill', 'press', 'scroll', 'wait_for', 'read', 'snapshot', 'js']),
        url: z.string().optional(), eid: z.string().optional(), selector: z.string().optional(), value: z.string().optional(),
        key: z.string().optional(), direction: z.enum(['up', 'down', 'top', 'bottom']).optional(), pixels: z.number().optional(),
        text: z.string().optional(), timeout_ms: z.number().optional(), region: z.string().optional(), max_chars: z.number().optional(),
        mode: z.enum(['interactive', 'full', 'outline']).optional(), max_items: z.number().optional(), code: z.string().optional(),
      })).min(1).max(25),
      tab_id: z.string().optional(),
      final_snapshot: z.boolean().default(true),
    }
  }, async ({ steps, tab_id, final_snapshot }) => {
    const NEED = { navigate: 'navigation', click: 'click', hover: 'click', fill: 'fill', press: 'fill', scroll: 'read', wait_for: 'read', read: 'read', snapshot: 'read', js: 'js_execute' };
    try {
      return await withCDP(tab_id, async (client, target) => {
        const out = []; let completed = 0; let failed = null; let lastView = false; let navigatedSinceView = false;
        for (let i = 0; i < steps.length; i++) {
          const st = steps[i]; const t0 = performance.now();
          const perm = checkPermission(NEED[st.op]);
          let body = ''; let err = null; lastView = false;
          if (!perm.allowed) err = perm.reason;
          else {
            const raw = st.eid || st.selector;
            try {
              if (st.op === 'navigate') {
                let u; try { u = new URL(st.url); } catch { u = null; }
                if (!u || !['http:', 'https:'].includes(u.protocol)) err = 'Only http(s) URLs are allowed';
                else { const r = await actNavigate(client, target, st.url); err = r.error ?? r.denied?.reason ?? null; navigatedSinceView = true; }
              } else if (st.op === 'click') {
                if (!raw) err = 'Provide eid or selector'; else { const r = await actClick(client, target, raw); err = r.error ?? r.denied?.reason ?? null; if (r.didNavigate) navigatedSinceView = true; }
              } else if (st.op === 'hover') {
                if (!raw) err = 'Provide eid or selector'; else { const r = await actHover(client, target, raw); err = r.error ?? r.denied?.reason ?? null; }
              } else if (st.op === 'fill') {
                if (!raw) err = 'Provide eid or selector'; else if (st.value === undefined) err = 'fill requires value'; else { const r = await actFill(client, target, raw, st.value); err = r.error ?? r.denied?.reason ?? null; }
              } else if (st.op === 'press') {
                const r = await actPress(client, target, st.key ?? ''); err = r.error ?? r.denied?.reason ?? null; if (r.didNavigate) navigatedSinceView = true;
              } else if (st.op === 'scroll') {
                await actScroll(client, target, st.direction ?? 'down', st.pixels ?? 500);
              } else if (st.op === 'wait_for') {
                if (!st.selector && !st.text) err = 'wait_for needs selector or text'; else err = (await actWaitFor(client, st)).error ?? null;
              } else if (st.op === 'read') {
                const cap = Math.min(Number(st.max_chars) || 4000, 12000);
                const sel = !st.region ? 'document.body' : EID_RE.test(st.region) ? `__L.byEid(${JSON.stringify(st.region)})` : `(__L.deepQuery(${JSON.stringify(st.region)},1)[0]||null)`;
                const r = await client.Runtime.evaluate({ expression: `(function(){${PAGE_LIB}const el=${sel};if(!el)return'[not found]';const t=(el.innerText||el.textContent||'').replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]|[\\u{E0000}-\\u{E007F}]/gu,'').replace(/\\n{3,}/g,'\\n\\n').trim();return t.length>${cap}?t.slice(0,${cap})+'\\n[truncated]':t;})()`, returnByValue: true });
                body = r?.result?.value ?? ''; lastView = true;
              } else if (st.op === 'snapshot') {
                body = await takeSnapshot(client, target.id, { mode: st.mode ?? 'interactive', region: st.region ?? null, maxItems: st.max_items, isDiff: false }); lastView = true; navigatedSinceView = false;
              } else if (st.op === 'js') {
                const r = await client.Runtime.evaluate({ expression: st.code ?? '', returnByValue: true, awaitPromise: true });
                body = JSON.stringify(r.result?.value ?? r.result?.description ?? null) ?? 'undefined'; lastView = true;
              }
            } catch (e) { err = e.message; }
          }
          const ms = Math.round(performance.now() - t0);
          if (err) { failed = { i, err }; out.push(`  <step n="${i + 1}" op="${st.op}" ms="${ms}" ok="false">${escapeXml(err)}</step>`); break; }
          completed++;
          out.push(body ? `  <step n="${i + 1}" op="${st.op}" ms="${ms}" ok="true">\n${body}\n  </step>` : `  <step n="${i + 1}" op="${st.op}" ms="${ms}" ok="true" />`);
        }
        if (!failed && final_snapshot && !lastView) {
          const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: !navigatedSinceView });
          out.push(xml.split('\n').map(l => '  ' + l).join('\n'));
        }
        return { content: [{ type: 'text', text: `<exec steps="${steps.length}" completed="${completed}" ok="${!failed}">\n${out.join('\n')}\n</exec>` }] };
      });
    } catch (e) {
      return errXml('browser_exec', e.message);
    }
  });

  server.registerTool('browser_hover', {
    description: 'Move the pointer over an element by eid or CSS selector, to open hover menus and tooltips. Returns a snapshot diff showing what appeared.',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), tab_id: z.string().optional() }
  }, async ({ eid, selector, tab_id }) => {
    try {
      const perm = checkPermission('click');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client, target) => {
        const raw = eid || selector;
        if (!raw) return errXml('browser_hover', 'Provide eid or selector');
        const r = await actHover(client, target, raw, { mode: 'interactive', isDiff: true });
        if (r.denied) return denied(r.denied);
        if (r.error) return errXml('browser_hover', r.error);
        return { content: [{ type: 'text', text: r.xml }] };
      });
    } catch (e) {
      return errXml('browser_hover', e.message);
    }
  });

  server.registerTool('browser_dialog', {
    description: 'Answer a native JavaScript dialog (alert, confirm, prompt, beforeunload) that a click opened and that is blocking the page. action: accept or dismiss; text answers a prompt. Any other tool reports the open dialog until it is answered.',
    inputSchema: { action: z.enum(['accept', 'dismiss']), text: z.string().optional(), tab_id: z.string().optional() }
  }, async ({ action, text, tab_id }) => {
    try {
      const perm = checkPermission('click');
      if (!perm.allowed) return denied(perm);
      return await withCDP(tab_id, async (client, target, session) => {
        if (!session.dialog) return errXml('browser_dialog', 'No JavaScript dialog is open on this tab');
        const had = session.dialog;
        await client.Page.handleJavaScriptDialog({ accept: action === 'accept', ...(text !== undefined ? { promptText: text } : {}) });
        session.dialog = null;
        await settle(client, 40, 300);
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: true });
        return { content: [{ type: 'text', text: `<dialog_closed type="${escapeXml(had.type)}" action="${action}" />\n${xml}` }] };
      }, { allowDialog: true });
    } catch (e) {
      return errXml('browser_dialog', e.message);
    }
  });

  server.registerTool('browser_upload', {
    description: 'Attach local files to an <input type=file> (by eid or CSS selector). The paths are on the machine running the browser. Requires the file_upload permission, which is denied until the user allows it (auren-perm set file_upload allow).',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), files: z.array(z.string()).min(1).max(10), tab_id: z.string().optional() }
  }, async ({ eid, selector, files, tab_id }) => {
    try {
      const perm = checkPermission('file_upload');
      if (!perm.allowed) return denied(perm);
      for (const f of files) if (!path.isAbsolute(f)) return errXml('browser_upload', `Use absolute paths: ${f}`);
      return await withCDP(tab_id, async (client, target) => {
        const raw = eid || selector;
        if (!raw) return errXml('browser_upload', 'Provide eid or selector');
        const isEid = EID_RE.test(raw);
        const r = await client.Runtime.evaluate({ expression: `(function(){${PAGE_LIB}
          const el=${isEid ? eidExpr(target, raw) : `__L.deepQuery(${JSON.stringify(raw)},1)[0]`};
          return el&&el.tagName==='INPUT'&&el.type==='file'?el:null;})()` });
        if (!r?.result?.objectId) return errXml('browser_upload', `No file input found: ${raw}`);
        const url = await liveUrl(client);
        { const b = domainBlocks(url, 'write'); if (b) return denied(b); }
        await client.DOM.setFileInputFiles({ files, objectId: r.result.objectId });
        await settle(client, 40, 300);
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: true });
        return { content: [{ type: 'text', text: `<uploaded count="${files.length}" />\n${xml}` }] };
      });
    } catch (e) {
      return errXml('browser_upload', e.message);
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
    { const perm = checkPermission('read'); if (!perm.allowed) return denied(perm); }
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
    { const perm = checkPermission('read'); if (!perm.allowed) return denied(perm); }
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
admin.post('/history', (req, res) => {
  const p = loadPerms();
  if (typeof req.body?.enabled === 'boolean') { p.history_enabled = req.body.enabled; savePerms(p); }
  res.json({ ok: true, enabled: historyEnabled(), retention_days: RETENTION_DAYS,
    rows: historyDb.prepare('SELECT COUNT(*) n FROM visits').get().n });
});
admin.delete('/history', (_, res) => { clearHistory(); res.json({ ok: true }); });
admin.post('/panic', (req, res) => {
  const p = loadPerms(); p.panic = req.body?.on !== false; savePerms(p);
  res.json({ ok: true, panic: p.panic });
});
admin.post('/domains', (req, res) => {
  const { host, rule } = req.body ?? {};
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host)) return res.status(400).json({ error: 'bad host' });
  if (rule !== null && !['deny', 'readonly', 'allow'].includes(rule)) return res.status(400).json({ error: 'rule must be deny|readonly|allow|null' });
  const p = loadPerms(); p.domains = p.domains ?? {};
  if (rule === null) delete p.domains[host.toLowerCase()]; else p.domains[host.toLowerCase()] = rule;
  savePerms(p);
  res.json({ ok: true, domains: p.domains });
});
admin.get('/audit', (req, res) => {
  const n = Math.min(Math.max(Number(req.query.n) || 50, 1), 1000);
  let lines = [];
  try { lines = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').slice(-n); } catch {}
  res.json({ entries: lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }) });
});
admin.post('/revoke', (_, res) => { sessionGrants.clear(); res.json({ ok: true }); });
app.use('/admin', admin);

async function handleMcp(req, res) {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  // The /mcp/<key> path form is the legacy shared key only; a bearer header may be the legacy key or an agent token.
  // Anything else (missing, wrong, expired, revoked) is a plain 404 so the endpoint stays unadvertised.
  let auth = null;
  if (!KEY) auth = LEGACY_AUTH;
  else if (req.params.key !== undefined) auth = keyMatches(req.params.key) ? LEGACY_AUTH : null;
  else auth = keyMatches(bearer) ? LEGACY_AUTH : tokens.verify(bearer);
  if (!auth) return res.status(404).json({ error: 'not found' });
  try {
    const server = buildServer(auth);
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
