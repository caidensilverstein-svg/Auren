---
title: Auren Master Reference
version: 2.1.2
updated: 2026-08-05
project: Auren
---

# Auren — Master Reference Document

> Custom browser built on Brave-core (Chromium fork). Claude.ai side panel, dark/gold theme, CDP-connected MCP server for AI browser control. Built from source on Mac M4 Air.

---

## What Auren Is

Auren is a production Chromium browser forked from Brave, built to serve as a dedicated AI workspace. It is not Electron. It is not a wrapper. It is a full native macOS browser binary compiled from ~120M lines of Chromium/Brave source.

**Core thesis:** A browser that knows what's on screen and can act on it — working in parallel with AI or letting AI operate autonomously while the user watches.

**What it has today:**
- Full dark/gold visual identity (#0e0e0e background, #c9a84c gold, #e8e8e6 text)
- Claude.ai loaded in a persistent side panel (logged in, session cookies persist across launches)
- Custom NTP (Auren New Tab) — dark page with gold wordmark
- All Brave branding replaced with Auren throughout UI strings
- Shield icon removed from omnibar
- MCP server (V2.1.2) running on Oracle, connected via CDP to Auren at Mac 10.8.0.3:9223

---

## Build Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Source acquisition (gclient sync, 116GB) | ✅ Complete |
| 2 | Full Chromium/Brave compile | ✅ Complete |
| 3 | Visual rebrand (dark/gold, all string patches) | ✅ Complete |
| 4 | Claude.ai side panel (AurenSidePanelWebView) | ✅ Complete |
| 5 | MCP server — CDP control over browser | ✅ V2.1.2 live |
| 6 | Native C++ Mojo bridge | 📋 Planned (V3) |

**Binary location:** `~/brave-src/src/out/auren/Auren.app`
**Build command:** `cd ~/brave-src/src && PYTHONPATH="$(pwd)/brave/script" autoninja -C out/auren chrome`
**CDP debug port:** `9223` (launched with `--remote-debugging-port=9223`)

---

## MCP Server

### Infrastructure

| Key | Value |
|-----|-------|
| File | `/home/ubuntu/scos/auren-mcp/index.js` |
| Host | Oracle (`150.136.235.242`) |
| PM2 | id 30, name `auren-mcp` |
| Port | `3012` |
| CDP target | `http://10.8.0.3:9223` (Mac WireGuard IP) |
| Connector URL | `https://command-dispatch.mooo.com/auren-browser/mcp/53dbeedd097aa96ec240806129abade64dc48ea65ea0f07b2d88984527f536ed` |
| GitHub | `https://github.com/caidensilverstein-svg/Auren` |
| Version | `2.1.2` |

### Architecture

**State model:** Every browser action produces a compact XML snapshot of the page, capped at 7,500 characters.

- **Navigation** → `<baseline reason="navigation"/>` — full page snapshot after load
- **In-page mutation** (click, fill, scroll) → `<diff type="mutation"/>` — only changed elements
- **URL change after click** → switches to baseline (same as navigation)

**Stable element IDs (eids):** Assigned via `data-eid` DOM attribute injection, keyed on CDP target.id. Format: `btn-N`, `lnk-N`, `inp-N`, `h-N`, `elt-N`, `sel-N`, `chk-N`, `alert-N`. Eids are stable within a tab session and reset on navigation.

**EID resolution:** `EID_RE = /^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/` → resolves to `[data-eid="X"]` CSS selector.

### Tools (V2.1.2)

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Compact XML page state, eids, 7500-char cap |
| `browser_navigate` | Navigate to URL, returns baseline on load |
| `browser_click` | Click element by eid or selector. JS `.click()` first (triggers form submit events), mouse events as fallback. Detects URL change → returns baseline instead of diff. |
| `browser_fill` | Fill input by eid or selector. Returns diff. |
| `browser_find` | Search for text/pattern across page, returns matching elements with eids |
| `browser_read_section` | Read a specific section of page content by heading or eid |
| `browser_diff` | Get current diff snapshot (what changed since last baseline) |
| `browser_screenshot` | PNG screenshot of current tab |
| `browser_execute_js` | Execute arbitrary JavaScript in page context |
| `browser_scroll` | Scroll up/down by pixels, returns full viewport snapshot inline |
| `browser_get_tabs` | List all open tabs with tab_id, title, url |
| `browser_select_tab` | Switch active CDP connection to a different tab |

### Parameter notes
- `browser_click` and `browser_fill` accept either `eid` (e.g. `btn-3`) OR `selector` (CSS) — either alone is sufficient
- `browser_snapshot` accepts `mode`: `interactive` (buttons/links/inputs only) or `outline` (headings only)
- All tools accept optional `tab_id` to target a specific tab

### Version History

| Version | Change |
|---------|--------|
| V1.0 | Initial: browser_get_page (full HTML), browser_navigate, browser_click, browser_fill, browser_screenshot, browser_execute_js, browser_scroll, browser_get_tabs, browser_select_tab |
| V2.0 | Compact XML, stable eids, 7500-char budget, baseline/diff model. Added browser_snapshot, browser_find, browser_read_section, browser_diff. Removed browser_get_page. |
| V2.1.0 | Three fixes: (1) browser_click URL change detection → baseline on navigation. (2) browser_scroll returns viewport snapshot inline. (3) truncated="true" total_items="N" attribute when budget cap hits. |
| V2.1.1 | browser_click and browser_fill: `selector` made optional, `eid` added as standalone param. Either `eid` or `selector` is sufficient. |
| V2.1.2 | browser_click: Uses JS `el.click()` first (fires native form submit events), falls back to dispatchMouseEvent if no navigation detected. Fixed form submission. |

---

## GitHub Repository

**URL:** `https://github.com/caidensilverstein-svg/Auren`
**SSH remote:** `git@github.com:caidensilverstein-svg/Auren.git`
**Repo root:** `/home/ubuntu/scos/auren-mcp/` on Oracle

### SSH Auth — All Nodes (Tokenless)

All three SCOS nodes have SSH keys configured for tokenless GitHub push. No GITHUB_TOKEN required.

| Node | Key file | Added to GitHub |
|------|----------|-----------------|
| Oracle | `/home/ubuntu/.ssh/id_ed25519` (oracle-scos-mesh) | ✅ 2026-08-05 |
| Mac | `/Users/caidensilverstein/.ssh/id_ed25519_github` | ✅ 2026-08-05 |
| Moxon | `/home/caiden/.ssh/id_ed25519_github` | ✅ 2026-08-05 |

**Git identity for commits:**
- Email: `273366514+caidensilverstein-svg@users.noreply.github.com` (GitHub noreply — required for privacy setting)
- Name: `caidensilverstein-svg`

**Push procedure from Oracle:**
```bash
git -C /home/ubuntu/scos/auren-mcp add -A
git -C /home/ubuntu/scos/auren-mcp commit -m "message"
git -C /home/ubuntu/scos/auren-mcp push
```

---

## Known Issues / Bug Tracker

### P0 — DCHECK crash (WorkerWatcher)
**Symptom:** Browser hard-crashes (DCHECK abort) on heavy service worker pages
**Error:** `DCHECK abort in performance_manager::WorkerWatcher::DisconnectSharedWorkerClient`
**Brave version:** `151.0.7922.47`
**Root cause:** Upstream Brave bug — race condition in SharedWorker lifecycle tracking
**Status:** Unresolved. Not fixed in current build.
**Mitigation:** Avoid service-worker-heavy pages (certain SPA dashboards). Hard crash requires browser restart.
**Fix path:** Cherry-pick upstream Brave fix when released, or bump Brave tag

### P1 — Cmd+V paste broken in Claude panel
**Symptom:** Paste (⌘V) does not work inside the Claude.ai side panel WebView
**Root cause:** `AcceleratorPressed` override needed in `AurenSidePanelWebView`. Borderless/titled windows on macOS 15 drop keyboard accelerators for sandboxed WebViews unreliably.
**Fix path:** Override `AddAccelerator` in `AurenSidePanelWebView` constructor, handle Cmd+V/A/C/X explicitly
**File:** `brave/browser/ui/views/side_panel/auren/auren_side_panel_web_view.cc`
**Status:** Open — not fixed

### P2 — CDP reconnect on crash
**Symptom:** After browser crash/restart, MCP server loses CDP connection
**Current state:** Auto-reconnect retry exists but could be more graceful
**Workaround:** `pm2 restart auren-mcp` on Oracle

### P3 — Brave NTP search bar
**Symptom:** "Ask anything, find anything" search bar may still appear on NTP
**Status:** Unverified — needs check after next build

---

## V3 Architecture Plan

### Core concept: User-AI parallel browsing

V3 is about awareness. The MCP server should know when the user (not Claude) changes the page — navigation, mutations, form inputs — and reflect that shared state without requiring Claude to re-navigate.

### V3 Components

**1. Persistent background CDP sessions**
One CDP session per tab kept alive in background (not opened fresh per tool call). Subscribes to all DOM mutation events and navigation events, tracking user-initiated changes as they happen.

**2. Per-tab eid counters**
Each tab has its own eid counter, reset on navigation. Tab session ownership model: which Claude instance "owns" a tab at a given time.

**3. Cooperative lock model**
When user is actively interacting with a tab, Claude yields. When Claude is running tools on a tab, user sees "AI working" indicator. Neither blocks the other — cooperative, not exclusive.

**4. Parallel tab operation**
Claude and user can work in different tabs simultaneously. `browser_get_tabs` shows both user-active and Claude-active tabs with no conflicts.

**5. User mutation awareness**
`browser_diff` with no prior action returns mutations since last snapshot — enables Claude to pick up where the user left off without navigating itself.

---

## Key File Paths

| Item | Path | Node |
|------|------|------|
| Browser source | `~/brave-src/src/` | Mac |
| Browser binary | `~/brave-src/src/out/auren/Auren.app` | Mac |
| Build args | `~/brave-src/src/out/auren/args.gn` | Mac |
| Side panel WebView | `brave/browser/ui/views/side_panel/auren/auren_side_panel_web_view.{h,cc}` | Mac |
| Color mixer | `brave/browser/themes/brave_color_mixer.cc` | Mac |
| Custom NTP | `brave/browser/ui/webui/auren_new_tab/` | Mac |
| Shield stub | `brave/browser/ui/views/brave_actions/brave_actions_container.cc` | Mac |
| MCP server | `/home/ubuntu/scos/auren-mcp/index.js` | Oracle |
| MCP repo | `/home/ubuntu/scos/auren-mcp/` | Oracle |
| MCP PM2 | id 30, `auren-mcp` | Oracle |

---

## Open Threads

- [ ] Fix DCHECK crash (WorkerWatcher) — P0, upstream Brave bug
- [ ] Fix Cmd+V in Claude panel — AcceleratorPressed override needed
- [ ] MCP V2 field validation (OpenAI Research Index, multi-step navigation, form filling)
- [ ] CDP reconnect on crash — make more graceful
- [ ] V3 planning: persistent background CDP sessions, per-tab eid counters, cooperative lock
- [ ] Custom Auren app icon (.icns)
- [ ] Brave NTP search bar — verify removed
- [ ] Reconnect claude.ai connector to pick up V2 tool surface (browser_get_page → browser_snapshot)

---

## Session History

| Date | Milestone |
|------|-----------|
| 2026-08-04 | Brave source compiled, AurenSidePanelWebView created, rebrand complete, Claude panel live and logged in, custom NTP registered |
| 2026-08-05 (AM) | MCP V2 built: compact XML, stable eids, 7500-char budget, baseline/diff model, browser_find/read_section/diff added |
| 2026-08-05 (AM) | auren_master.md written, auren_deck.pptx built (12 slides, dark/gold) |
| 2026-08-05 (PM) | MCP V2 field test: 3 fixes shipped (URL detection, scroll snapshot, truncated attr) → V2.1.0 |
| 2026-08-05 (PM) | V2.1.1: eid-only params on browser_click and browser_fill (selector no longer required) |
| 2026-08-05 (PM) | V2.1.2: JS .click() for form submissions, mouse events as fallback |
| 2026-08-05 (PM) | GitHub repo created (caidensilverstein-svg/Auren), SSH auth configured on all 3 nodes, pushed V2.1.2 |

---

## Glossary

| Term | Definition |
|------|------------|
| CDP | Chrome DevTools Protocol — WebSocket API for controlling Chromium |
| eid | Stable element ID injected as `data-eid` DOM attribute by MCP server |
| baseline | Full page XML snapshot returned after navigation or major state change |
| diff | Compact XML showing only elements that changed since last baseline |
| auren-mcp | Node.js/Express MCP server on Oracle connecting to Auren via CDP |
| brave-core | Chromium fork (Brave browser source) that Auren is built on |
| WireGuard | VPN mesh — Oracle (10.8.0.1), Mac (10.8.0.3), Moxon (10.8.0.4) |
| DCHECK | Chromium debug assertion — P0 crash is a DCHECK abort in WorkerWatcher |
| noreply email | `273366514+caidensilverstein-svg@users.noreply.github.com` — required for GitHub email privacy |
