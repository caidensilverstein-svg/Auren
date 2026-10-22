#!/usr/bin/env node
// Manage agent tokens for the Auren MCP server (run on the server, as the user).
//   auren-token mint --label "claude.ai" [--scope read|act|settings] [--days 90] [--user owner]
//   auren-token list
//   auren-token revoke <id|label>
// The secret is printed once at mint time; only its sha256 is stored (~/.auren/auth.db).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { TokenStore, SCOPES } from '../lib/auth.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dbPath = process.env.AUREN_AUTH_DB || path.join(os.homedir(), '.auren', 'auth.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new TokenStore(new Database(dbPath));
try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
const when = t => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '-');

if (cmd === 'mint') {
  try {
    const r = store.mint({ label: opt('--label'), scope: opt('--scope', 'act'), days: Number(opt('--days', 90)), user: opt('--user', 'owner') });
    console.log(`token id ${r.id}  user ${r.user}  scope ${r.scope}  expires ${when(r.expires_at)}\n`);
    console.log(r.token);
    console.log('\nStore it now: it is not shown again. Send it as "Authorization: Bearer <token>" to /mcp.');
  } catch (e) { console.error(e.message); process.exit(1); }
} else if (cmd === 'list') {
  const rows = store.list();
  if (!rows.length) console.log('no tokens');
  for (const r of rows) console.log(`${r.id}  ${r.user_id.padEnd(8)} ${r.scope.padEnd(8)} ${(r.revoked_at ? 'REVOKED' : r.expires_at && r.expires_at < Date.now() ? 'expired' : 'active').padEnd(8)} exp ${when(r.expires_at)}  used ${when(r.last_used_at)}  ${r.label}`);
} else if (cmd === 'revoke' && argv[1]) {
  const n = store.revoke(argv[1]);
  console.log(n ? `revoked ${n} token(s)` : 'no matching active token');
  process.exit(n ? 0 : 1);
} else {
  console.error(`usage: auren-token mint --label <name> [--scope ${SCOPES.join('|')}] [--days N] [--user U] | list | revoke <id|label>`);
  process.exit(2);
}
