# Backend Audit — 2026-10-19

Scope: Gitea `caiden/Auren` #1–#17 (tracker only; code lives here), GitHub issue #9 "Backend Audit",
`mcp/index.js` (v2.1.2), the NTP/side-panel C++ in `browser/`, and the live deployment
(Oracle `auren-mcp`, pm2 id 27) and Mac build (`~/brave-src/src/out/auren`).

Severity: **P0** fix now · **P1** before wider use · **P2** hardening/backlog.
"Fixed" means fixed on branch `audit/backend-2026-10` with an e2e test in `mcp/test/e2e.test.js`;
nothing here has been deployed to Oracle yet.

## 0. Findings that changed the plan

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | P0 | **Repo ≠ production.** Oracle ran uncommitted edits (better-sqlite3 history, `browser_search_history`, `browser_get_session_context`, new dependency). A fresh deploy from GitHub would have silently dropped Gitea #12. | Synced byte-identically in the first commit of the branch. Oracle's working tree is still dirty; `git pull` there will need `git checkout mcp/` first. |
| 2 | P0 | **Fail-open auth.** `if (KEY && ...)` — with `AUREN_MCP_KEY` unset the endpoint is an unauthenticated remote-control API for a logged-in browser. | Fixed: server exits unless key set (`AUREN_MCP_ALLOW_NO_KEY=1` for local dev). |
| 3 | P0 | **`browser_navigate` accepted `javascript:`, `data:`, `file:`** and did not check the `navigation` permission, so the `js_execute` gate was bypassable by navigating to `javascript:...`. | Fixed: http(s) only + `navigation` rule enforced. Same scheme check on `<a>` clicks. |
| 4 | P0 | **`~/.env` (holds the key) was mode 664; `~/.auren/` and `history.db` world-readable.** | Fixed on Oracle (600/700). |
| 5 | P1 | **Permission model is self-service.** `browser_set_permission` is an MCP tool, so the agent that is being restricted can grant itself `allow` (session or permanent). Production `trust_level` is currently `"trusted"`, which turns every `ask` into `allow`. The `read` and `form_submit` rules are defined but never checked anywhere. | **Not fixed** (design decision). Needs an out-of-band approval channel (browser UI prompt via the C++ side, or a user-only HTTP route). Until then the permission system is advisory. |
| 6 | P1 | **`browser_click` JS-click path was dead code.** `\${JSON.stringify(resolved)}` was escaped inside a template literal, so the injected script was a syntax error; every non-anchor click silently fell through to the mouse path. Fixing only the escape would have caused double activation (JS click then mouse click toggles checkboxes twice). | Fixed: pointer events only; covered by a test (counter == 1, checkbox toggled once). |
| 7 | P1 | `getTarget` silently fell back to the first tab when `tab_id` was unknown, so an agent could act on the wrong tab. The error also went through the 4-retry backoff (~7.5 s). | Fixed: explicit error, no retry. |
| 8 | P1 | Click used the last *snapshot's* URL as "previous URL"; before any snapshot it is `''`, so every click reported navigation. | Fixed (reads live `location.href`). |
| 9 | P1 | History stored `frame.name` (almost always empty) as the title; FTS index never saw real titles. | Fixed: title read on `loadEventFired`, FTS row re-indexed; DB errors no longer break navigation tracking. |
| 10 | P1 | **History privacy.** Full URLs incl. query strings (session tokens, search terms) recorded for every tab, forever, unencrypted, no purge tool, while the product pitch is anti-telemetry. | Open. Proposal: strip query/fragment by default, retention window, `browser_clear_history`, opt-in toggle in the UI. |
| 11 | P2 | Secret lives in the URL path (`/mcp/<key>`): ends up in proxy/access logs, browser history, Claude connector config. Compare was `!==` (non-constant time). | Bearer header now accepted at `/mcp`; constant-time compare. URL form kept for the existing connector. Move connectors to the header form, then drop the path form. |
| 12 | P2 | No rate limiting, no request/user logging, 10 MB JSON limit, `browser_get_tabs`/`browser_select_tab` bypass the session manager and timeouts, `eidCounter` is global across tabs. | Open. |

## 1. Test suite (item: "test like the agents would")

`cd mcp && npm test` — black-box: starts headless Chrome with CDP, a fixture web server and the real
MCP server (random ports, throw-away `HOME`), then drives it with the official MCP SDK client over
Streamable HTTP exactly as Claude does. 10 tests: fail-closed startup, auth (bad key / header / path),
tool list, navigate+snapshot, URL-scheme rejection, single-fire click, permission-gated fill, bad tab id,
history titles + search, offline error. ~12 s. Skips with a message if no Chrome (`CHROME_BIN`).
Recommended next: run it on Oracle/Mac before each deploy (pre-commit hook or the Gitea Actions runner),
and add cases for `browser_act`, `browser_diff`, `browser_scroll`, screenshots, and concurrent clients.

Routing/latency observations: stateless per-request `McpServer` + a pooled CDP session per tab is fine.
The cost is the liveness probe (`Runtime.evaluate('1')`) before every call and the fixed
`setTimeout` sleeps (400/350/300/150 ms) in navigate/click/fill — replace with
`Page.lifecycleEvent`/`DOM` quiescence waits for a noticeable speed-up.

## 2. User-based auth (feasibility: yes, medium effort)

Today: one shared secret, one browser, one implicit user, CDP on `10.8.0.3:9223` reached over WireGuard.
CDP itself is unauthenticated full control of the browser, so *any* host on the WG mesh can bypass the MCP
layer entirely — the MCP key protects nothing against a compromised mesh node.

Proposed shape:
1. Browser UI (new WebUI page, same pattern as `AurenSecurityHandler`) mints a 256-bit token, shows it once,
   stores only its hash plus a `user_id` (UUID) on the server.
2. MCP server maps `Authorization: Bearer <token>` → `user_id`; per-user rate limit, audit log
   (`user_id, tool, tab, ts, outcome`), per-user permissions file (replaces global `agent_permissions.json`).
3. For Claude's custom-connector flow implement the MCP authorization spec (OAuth 2.1 + PKCE, dynamic client
   registration) so users paste only the server URL; token mint becomes the consent screen. Other providers
   that only support static headers keep using the bearer token.
4. Multi-user requires inverting the CDP link: the browser dials *out* to the server (reverse WebSocket
   tunnel with the user token) instead of Oracle dialing in to a fixed `MAC_CDP`. Without this, user-based
   auth only works for one browser per server.

## 3. Grey screen on launch (Gitea #17 / `docs/crashes`)

I could not reproduce: Auren is not running on the Mac and there are no `Auren_*.ips` reports, so the
following is code-reading, not a confirmed root cause.

* **Candidate A (CDP port held) is weaker than the docs say.** Chromium's DevTools HTTP handler logs and
  continues if the bind fails; it does not block window creation. And the suggested fix
  `lsof -ti:9223 | xargs kill -9` would kill a *healthy running* Auren if a second launch happens. Don't ship that.
  If a port check is wanted, do it with a bind probe and log only.
* **Candidate D is the most plausible from the source.** `AurenSidePanelWebView`'s constructor calls
  `LoadClaudeAI()` synchronously, which creates a `WebContents` and starts a navigation during browser-view
  construction — the docs say loading is lazy (`EnsureAurenPanelCreated`), but this constructor is not.
  Any code path that constructs the view at window init pays for it on the main thread.
* B/C (component build GPU/Metal warmup) remain plausible for "first launch after idle" and would be visible
  in the startup markers below (`is_component_build=true` loads many dylibs in the GPU process).
* Next step (needs a Mac rebuild, ~minutes with an incremental `autoninja -C out/auren chrome`): add
  `LOG(INFO)` markers at (1) `BrowserView` init, (2) side-panel construct/first load commit, (3) GPU
  channel established, (4) first `DidFirstVisuallyNonEmptyPaint`, launch with `--enable-logging=stderr --v=0`
  and keep the log of any grey launch. The missing marker identifies the stall. I did not touch the Mac build tree.

## 4. Do the safety methods do what the security bar says?

`auren_security_handler.cc` reads real Brave settings, but several lights claim more than the value means:
* **TOR**: `IsTorConnected()` = "a Tor client has a circuit" (process-wide), not "this tab is routed through Tor".
  Normal windows are not Tor-routed. Label it "Tor available" or show it only inside a Tor window.
* **DNS**: `mode != kOff` is also true for `automatic`, which falls back to plaintext DNS. Light should be on only for `secure`.
* **Cookies**: `!= ALLOW` is true for the default "block third-party"; it says nothing about isolation/partitioning.
* **Fingerprint**: 66 for the Brave default (BLOCK_THIRD_PARTY) is arbitrary; the score isn't measured.
* **Side panel**: Shields are *disabled for claude.ai in the shared profile* (persistent), and the UA is forced to
  `Chrome/138` on a 151 engine — a distinctive, inconsistent fingerprint and a Client-Hints mismatch.
  Use a separate storage partition/profile for the AI panel instead of exempting the domain globally.
* **Extensions/telemetry**: crash fixes downgraded `CHECK`s in WebRequest and WorkerWatcher; stripping Shields
  at the UI layer left its observers wired (the CRASH-01 root cause). Prefer disabling the feature flag/service
  over stubbing the UI. Not reviewed: whether `patches/brave_modifications.diff` (3.3k lines, not read in this
  audit) actually removes Brave-service endpoints (P3A, update checks, Rewards/News/VPN/Wallet, safe-browsing, field trials). A real effectiveness test is a capture:
  launch with a clean profile, `mitmproxy`/`tcpdump` for 10 minutes of idle, and diff the destination list against
  an allowlist. A `~/capture0.pcap` exists on the Mac (not inspected) — possibly a starting point.
Goal for "go significantly further": a `scripts/telemetry-audit` that fails CI when an unexpected host is contacted.

## 5. Other AI providers (research notes — verify before building)

Because the side panel is a top-level `WebView` (not an iframe), `X-Frame-Options`/frame-ancestors don't block
embedding; the real blockers are:
* **Login in embedded/Chromium-embedded UAs**: Google sign-in (Gemini) rejects embedded webviews
  (`disallowed_useragent`) — the current UA spoof is the hack that makes this work and is fragile.
  OAuth-in-system-browser with loopback redirect is the durable fix.
* **Provider list by effort**: ChatGPT (chatgpt.com) and Perplexity — same pattern as Claude, cheap;
  Gemini — blocked on Google sign-in; Grok — X login; Copilot — Microsoft login + Edge-UA sniffing.
  For API-key providers (Anthropic, OpenAI, Google, xAI, Mistral, local Ollama) build a native side panel
  against their HTTP APIs instead of a website embed; this is what enables tool use.
* **Tool use without leaking secrets to the model**: keep credentials server-side (Oracle) in a vault keyed by
  `secret_ref`; add `browser_fill({secret_ref})` that resolves the value inside the MCP process and writes it
  via CDP, and redact `val=` for password/secret-typed inputs in `buildElementXml` and `browser_diff` (today a
  filled password echoes back in the snapshot). Provider keys stay in the browser/MCP process and are never
  put in a prompt or tool result. Differences to plan for: MCP support (Claude/OpenAI Responses have remote MCP;
  Gemini/others need an adapter that translates tool schemas), tool-call format, and auth model of each connector.

## 6. Gitea backlog triage (suggestions; nothing was closed or edited on Gitea)

* #2 CDP reconnect — done (v2.1.x). #10 negotiated permissions — implemented but see finding 5; keep open.
* #9 AI-controlled settings — partial (`browser_set_preference` live-only items). #12 path memory — implemented
  but uncommitted until now; privacy work in finding 10 remains.
* #1 V2 field validation, #7 `browser_exec` DSL, #13 Mojo bridge (would also remove the CDP-over-mesh exposure),
  #14 Tor/Arti, #16 AX-tree computer use, #8 co-presence: long-term, unchanged. #4/#5 shipped on the Mac
  (`brave` repo commits `9959bb5`, `44b0cae`, `e2e4034`) but the security-bar accuracy items above are new.
* #17 grey screen — see §3.
