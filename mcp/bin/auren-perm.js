#!/usr/bin/env node
// User-side control of agent permissions. Talks to the MCP server's /admin API
// on loopback; needs AUREN_ADMIN_KEY (env or ~/.env) - the agent never sees it.
import fs from 'fs';
import os from 'os';
import path from 'path';

try {
  for (const line of fs.readFileSync(path.join(os.homedir(), '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
} catch {}

const base = `http://127.0.0.1:${process.env.AUREN_MCP_PORT || 3012}/admin`;
const key = process.env.AUREN_ADMIN_KEY;
if (!key) { console.error('AUREN_ADMIN_KEY is not set (env or ~/.env).'); process.exit(1); }

async function api(method, p, body) {
  const r = await fetch(base + p, {
    method, headers: { 'x-admin-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`${r.status}: ${j.error ?? 'request failed'}`); process.exit(1); }
  return j;
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'list': console.log(JSON.stringify(await api('GET', '/permissions'), null, 2)); break;
  case 'requests': {
    const { pending_requests } = await api('GET', '/permissions');
    if (!pending_requests.length) console.log('No pending requests.');
    for (const r of pending_requests) console.log(`${r.id}  allow ${r.action}  ${r.requested_at}  ${r.reason}`);
    break;
  }
  case 'approve': {
    const permanent = args.includes('--permanent');
    const mi = args.indexOf('--minutes');
    const minutes = mi >= 0 ? Number(args[mi + 1]) : undefined;
    console.log(JSON.stringify(await api('POST', `/requests/${args[0]}/approve`, { scope: permanent ? 'permanent' : 'session', minutes })));
    break;
  }
  case 'deny': console.log(JSON.stringify(await api('POST', `/requests/${args[0]}/deny`))); break;
  case 'set': console.log(JSON.stringify(await api('POST', '/permissions', { action: args[0], level: args[1] }))); break;
  case 'trust': console.log(JSON.stringify(await api('POST', '/permissions', { trust_level: args[0] }))); break;
  case 'revoke': console.log(JSON.stringify(await api('POST', '/revoke'))); break;
  default:
    console.log('usage: auren-perm <list|requests|approve <id> [--permanent|--minutes N]|deny <id>|set <action> <allow|deny|ask>|trust <inspection|trusted>|revoke>');
}
