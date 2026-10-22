// Agent tokens: revocable, scoped, stored only as sha256. See docs/design/user-auth.md.
// A token belongs to a user, has a scope (read < act < settings) and an expiry. Only the hash is stored, so a copy of
// the database does not leak working credentials.
import crypto from 'node:crypto';

export const SCOPES = ['read', 'act', 'settings'];
const RANK = Object.fromEntries(SCOPES.map((s, i) => [s, i]));

// Lowest scope that may call each tool. Anything not listed needs `settings` (fail closed).
export const TOOL_SCOPE = {
  browser_get_tabs: 'read', browser_snapshot: 'read', browser_find: 'read', browser_read_section: 'read', browser_diff: 'read',
  browser_screenshot: 'read', browser_scroll: 'read', browser_select_tab: 'read', browser_get_permissions: 'read',
  browser_search_history: 'read', browser_get_session_context: 'read',
  browser_navigate: 'act', browser_click: 'act', browser_fill: 'act', browser_act: 'act', browser_exec: 'act',
  browser_execute_js: 'act', browser_hover: 'act', browser_dialog: 'act', browser_upload: 'act',
  browser_set_permission: 'settings', browser_set_preference: 'settings',
};
export const scopeAllows = (scope, tool) => RANK[scope] !== undefined && RANK[scope] >= RANK[TOOL_SCOPE[tool] ?? 'settings'];

const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = () => crypto.randomBytes(6).toString('hex');
const DAY = 86_400_000;

export class TokenStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, scope TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
    `);
    db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('owner', Date.now());
  }

  // Returns the secret once; it cannot be recovered afterwards.
  mint({ user = 'owner', label, scope = 'act', days = 90 }) {
    if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
    if (!label || !String(label).trim()) throw new Error('a label is required');
    this.db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(user, Date.now());
    const token = 'aur_' + crypto.randomBytes(32).toString('base64url');
    const id = newId(), now = Date.now();
    this.db.prepare('INSERT INTO tokens (id, user_id, label, scope, token_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, user, String(label).trim().slice(0, 80), scope, hash(token), now, days > 0 ? now + days * DAY : null);
    return { token, id, user, scope, expires_at: days > 0 ? now + days * DAY : null };
  }

  // -> { user_id, token_id, scope } or null. Missing, expired and revoked tokens are indistinguishable to the caller.
  verify(token) {
    if (typeof token !== 'string' || !token.startsWith('aur_') || token.length > 200) return null;
    const row = this.db.prepare('SELECT id, user_id, scope, expires_at, revoked_at, last_used_at FROM tokens WHERE token_hash = ?').get(hash(token));
    if (!row || row.revoked_at || (row.expires_at && row.expires_at < Date.now())) return null;
    const now = Date.now();
    if (!row.last_used_at || now - row.last_used_at > 60_000) this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return { user_id: row.user_id, token_id: row.id, scope: row.scope };
  }

  list(user) {
    const q = 'SELECT id, user_id, label, scope, created_at, expires_at, last_used_at, revoked_at FROM tokens' + (user ? ' WHERE user_id = ?' : '') + ' ORDER BY created_at';
    return user ? this.db.prepare(q).all(user) : this.db.prepare(q).all();
  }

  // by id or by label; returns how many were revoked
  revoke(idOrLabel) {
    return this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL AND (id = ? OR label = ?)').run(Date.now(), idOrLabel, idOrLabel).changes;
  }
}
