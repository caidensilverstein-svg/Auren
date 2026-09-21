# Auren

A private, AI-native browser built from source. Chromium/Brave fork with your AI provider as a permanent native side panel and an MCP server giving Claude direct DOM and accessibility tree access to everything the browser sees.

## What's in this repo

```
browser/                          ← Auren-specific C++ source files
  ui/webui/
    auren_new_tab_ui.cc           ← Custom NTP: design token system, Inter/DM Mono, security bar
    auren_new_tab_ui.h
    auren/
      auren_security_handler.cc   ← Live security signals: JS, HTTPS, Cookies, Fingerprint, TOR, DNS
      auren_security_handler.h
      auren_security_handler.mojom
  ui/views/side_panel/auren/
    auren_side_panel_web_view.cc  ← Claude.ai native side panel
    auren_side_panel_web_view.h
    BUILD.gn

docs/
  auren_crash_report.md           ← Crash/stability tracking (CRASH-01/02 fixed; #17 grey-screen partially open)

patches/
  brave_modifications.diff        ← All modifications to Brave source (theme, strings, shields)

mcp/                              ← Auren MCP server (Node.js, CDP-driven browser control)
  index.js                        ← MCP v2.1.2
  package.json
```

The full Chromium/Brave source (~28GB) is not in this repo. Auren is built locally from source. You compile it yourself and own the code.

## Architecture

```
Claude.ai (side panel)
  → MCP connector
  → auren-mcp server (Node.js, Oracle)
  → CDP → Auren browser (Mac)
  → DOM / accessibility tree
```

## MCP tools

- `browser_get_tabs`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_find` — the base find/act primitives.
- `browser_act` — find-by-description + click/fill/read in one round trip, skipping the snapshot→find→act sequence.
- All CDP calls auto-reconnect with exponential backoff (500ms/1s/2s/4s, capped per attempt) and fail with a structured `Auren is offline` error instead of a raw socket hang-up.

## NTP security bar

Six live signals, all backed by real browser state (no mocks): JS, HTTPS, Cookies, Fingerprint (all via Brave Shields), TOR (`TorLauncherFactory::IsTorConnected()` — process-wide circuit status, since the NTP itself never runs in a Tor profile), and DNS (`SecureDnsConfig` mode).

## Design

Dark theme built on a token system (typography, color, spacing, radius, elevation, motion) — see the `:root` block in `auren_new_tab_ui.cc`. Inter for UI text, DM Mono for the security bar, accent `#6c63ff`.

## Status

Active development. Not ready for public use. Build instructions and future developments coming.
