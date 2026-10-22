# User authentication and multi-user design (proposal)

Status: **steps 1-2 of the migration are implemented** (2026-10-22): `mcp/lib/auth.js`, `mcp/bin/auren-token.js`, scope
enforcement and per-token rate limits and audit rows in `mcp/index.js`, 5 e2e tests in `mcp/test/e2e.test.js`. Steps 3-6 are
still proposals. Written 2026-10-21 against `mcp/index.js` on `main`.

Decisions made while implementing (change them if you disagree):
* The legacy shared key maps to user `owner` with scope `settings` (everything it could do before, so no connector breaks).
  Set `AUREN_LEGACY_SCOPE=act` to stop it filing permission/preference requests; the design's `act` default can be adopted
  once the connector uses a token.
* The `settings` scope exists: it only lets a token *file requests* (`browser_set_permission`, `browser_set_preference`);
  approving them still needs the admin secret, which no agent credential can use.
* `browser_scroll` and `browser_select_tab` are `read`: they change the view, not the page's state.
* Unknown tools need `settings` (fail closed).
* Tokens live in `~/.auren/auth.db` (separate from history), `aur_` + 256 random bits, only `sha256` stored.
  `auren-token mint|list|revoke`. Missing/wrong/expired/revoked all return the same 404.

## Where we are

| Piece | Today |
|-------|-------|
| Who may call the MCP endpoint | Anyone holding `AUREN_MCP_KEY`, a single shared secret, sent as `/mcp/<key>` in the URL path or as a bearer token. The server refuses to start without it. |
| Identity | None. Every call is "the key holder". The audit log cannot say who acted. |
| Which browser | One fixed CDP target (`AUREN_CDP_HOST:AUREN_CDP_PORT`, the Mac). One user, one browser. |
| User control over the agent | A second secret, `AUREN_ADMIN_KEY`, on loopback only (`/admin`, `auren-perm`). The agent never sees it. Permissions, site rules, panic switch and the pending-request approvals live behind it. |
| Key handling | Compared with SHA-256 + `timingSafeEqual` (good). The key sits in the URL path, so it ends up in reverse-proxy and access logs and in connector configs. |

That is right for one person. It breaks down as soon as a second person, a second device, or a revocable agent
credential is needed.

## Goals

1. Each user has their own identity and their own browser. One user's agent can never reach another's browser,
   history or permissions.
2. Agent credentials are revocable one at a time without touching the user's own access.
3. The user's control plane (approve a permission, panic, change site rules) can never be reached with an agent
   credential.
4. Every logged action names who did it and with which credential.
5. Nothing secret in URLs or logs.

Non-goals: public sign-up, passwords, a hosted multi-tenant service. Auren is private.

## Model

Three kinds of principal, each with its own credential type.

* **User**: a person. Owns exactly one *browser binding* (CDP host/port, or later a reverse tunnel from that
  user's Auren) and their own permission set, site rules, history database and audit log.
* **Agent token**: a credential a user mints for one agent or connector ("claude.ai", "laptop CLI"). It belongs
  to a user, has a label, an expiry, and a **scope**. It can only drive that user's browser, and only within the
  user's current permissions (the token can narrow, never widen).
* **Admin session**: the user acting on their own control plane. Separate from agent tokens, never accepted on
  `/mcp`.

Scopes for an agent token, from least to most:
`read` (snapshot, find, read_section, tabs, screenshot) < `act` (adds click, fill, navigate, form_submit,
exec) < `settings` (adds set_preference / request permission changes, which still need user approval).
Sensitive input stays deny-by-default regardless of scope.

## Credentials

* Tokens are random 256-bit values, shown **once** at creation. The server stores only `sha256(token)`, the
  user id, label, scope, created/expiry/last-used. A database leak does not leak tokens.
* Sent only in `Authorization: Bearer`. The `/mcp/<key>` path form is kept for existing connectors during
  migration, then removed. Request logging must redact the path and the header.
* Expiry by default (90 days for agent tokens), rotation by minting a new token and revoking the old one.
* Rate limits (already per-process via `AUREN_MAX_ACTIONS_PER_MIN`) become per token.
* The admin credential becomes a per-user secret, still loopback only. Optional second factor for the
  highest-risk actions (raising a permission to permanent, disabling the panic switch): a one-time code from
  the `auren-perm` CLI that the agent cannot read.

## Browser binding

Today the target is a global. With users, the target is looked up from the authenticated user:

1. Keep the current model first: `users.json` maps user to `{cdp_host, cdp_port}` on the WireGuard network.
2. Later, an outbound connection from each user's Auren to the server (so users behind NAT need no inbound
   port, and the CDP port never has to be reachable from the network at all). This also removes the risk of an
   exposed 9223.

A user whose browser is offline gets the existing structured offline error, never another user's browser.

## Storage and isolation

* `users` and `tokens` in the existing SQLite file (better-sqlite3 is already a dependency).
* History, audit log, site rules and permissions keyed by `user_id` (they are single-tenant files/tables now).
  Migration: the current data becomes user `owner`.
* The audit log gets `user_id` and `token_id`. It still never records typed values or URL query strings
  (unchanged).
* One user's panic switch suspends only that user's tokens.

## What an attacker gets

| Compromise | Result |
|------------|--------|
| Leaked agent token | That user's browser, within the token's scope and the user's permissions, until revoked. Not the control plane. Visible in the audit log by token id. |
| Leaked admin secret | The control plane for that user only, loopback only, so requires a foothold on the server. |
| Leaked server database | Hashes only. |
| Stolen backup of the old shared key | Dies at migration step 4. |

## Migration (each step shippable and reversible)

1. Add `users`/`tokens` tables and a `auren-token` CLI (`mint`, `list`, `revoke`). Create user `owner`.
2. Accept bearer tokens alongside the legacy shared key. The legacy key maps to `owner` with scope `act` and
   is logged as `legacy`.
3. Add `user_id` to history, audit and permissions; backfill `owner`.
4. Move the connector from the URL key to a bearer token; remove path-key support and rotate the old key.
5. Add a second user with its own browser binding; add tests that user B's token can never see user A's tabs,
   history, audit or permissions.
6. Optional: outbound browser tunnel; OAuth for claude.ai if the connector supports it (then tokens are issued
   by the standard flow instead of pasted).

## Tests to write with step 1-2

* Missing/wrong/expired/revoked token returns 404 (not 401, so the endpoint stays unadvertised, as now).
* Scope enforcement per tool; a `read` token cannot click.
* Agent token rejected on `/admin`; admin secret rejected on `/mcp`.
* Cross-user isolation (step 5).
* Audit rows carry `user_id` and `token_id`; no token material in logs.

## Open questions for Caiden

* Is a second user a real near-term need, or is the goal mainly revocable per-agent tokens? (Steps 1-4 deliver
  the second without step 5.)
* Should `settings` scope exist at all, or should preference/permission changes always be user-only?
