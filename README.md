# Auren

A private, AI-native browser built from source. Chromium/Brave fork with Claude.ai (or configurable ai website provider) as a permanent native side panel and an MCP server giving Claude direct DOM and accessibility tree access to everything the browser sees.

## What's in this repo

```
browser/                          ← Auren-specific C++ source files
  ui/webui/
    auren_new_tab_ui.cc           ← Custom NTP (pure black, gold wordmark)
    auren_new_tab_ui.h
  ui/views/side_panel/auren/
    auren_side_panel_web_view.cc  ← Claude.ai native side panel
    auren_side_panel_web_view.h
    BUILD.gn

patches/
  brave_modifications.diff        ← All modifications to Brave source (theme, strings, shields)

mcp/                              ← Auren MCP server (Node.js, CDP-driven browser control)
  index.js                        ← MCP V2.1.2
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

## Design

Minimal and simplistic, no bloat.

## Status

Active development. Not ready for public use. Build instructions and future developments coming.
