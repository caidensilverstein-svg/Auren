# MCP speed work (branch `perf/speed`)

Method: `cd mcp && node bench/bench.js --n 12` drives the real server over HTTP with the MCP SDK client
against headless Chrome and a local fixture (no network). Numbers are p50 ms on a dev machine with a
local CDP link, so they isolate **server + browser overhead**. Over the real WireGuard hop (Oracle -> Mac)
and the model loop, every avoided round trip is worth far more than the local figures suggest.

| operation | before | after | change |
|---|---:|---:|---|
| navigate | 498 | 83 | event-driven load wait instead of listener-after-navigate + 400 ms sleep |
| snapshot / find / read | ~50 | 6-11 | session reuse (see below) |
| click (in-page) | 416 | 68 | DOM-quiet wait (50 ms) instead of 350 ms sleep + second attempt |
| fill | 207 | 42 | DOM-quiet wait instead of 150 ms sleep |
| click that navigates | 1097 | 126 | wait for frameNavigated + load, no sleeps |
| 4-step workflow (4 calls) | 1247 | 200 | all of the above |
| 4-step workflow (`browser_exec`, 1 call) | n/a | 178 | one round trip |

## Round trips (simulated 30 ms RTT, `node bench/bench.js --rtt 30`)
Oracle -> Mac over WireGuard measured 13-118 ms (avg 34 ms) per ping, and every CDP command pays it.
After the sleeps were gone, the cost left is the number of sequential CDP commands per action. A click took
~7; it now takes 3 (locate + URL in one evaluate, press/release pipelined, settle + snapshot fused into one
evaluate, with an automatic retry if a navigation destroys the page mid-flight).

| operation (30 ms RTT) | sleeps removed only | + fewer round trips |
|---|---:|---:|
| navigate | 191 | 161 |
| click (in-page) | 286 | 196 |
| fill | 134 | 102 |
| 4-step workflow (4 calls) | 667 | 521 |
| 4-step workflow (`browser_exec`) | 525 | 468 |

## What was wrong
1. **A new CDP connection on every call without `tab_id`.** `acquire(null)` looked the session up under
   key `null` but stored it under the real target id, so it always missed: every call did an HTTP
   `/json` list, a websocket connect, `Page.enable`, `Runtime.enable`, and leaked the old socket (and
   its history listeners). Now the default tab id is resolved through a 1 s cache and the pooled
   session is reused.
2. **Per-call liveness probe** (an extra `Runtime.evaluate` round trip). Dropped; a socket close already
   evicts the session. The probe only runs if the session has been idle > 15 s (half-open sockets).
3. **Fixed sleeps** (400/350/300/200/150 ms) after navigate/click/fill/scroll. Replaced by waiting for
   the actual event: `Page.loadEventFired` (listener registered *before* navigating - the old code
   registered it after, which could miss the event entirely and wait forever), `Page.frameNavigated`,
   and an in-page MutationObserver "DOM quiet for N ms" settle.
4. **`Runtime.enable` removed.** Nothing uses execution-context events; it makes Chrome stream console
   and context events for the session and is a well-known automation-detection tell.

## New: `browser_exec` (Gitea #7)
Up to 25 steps in one call: `navigate, click, fill, press, scroll, wait_for, read, snapshot, js`.
Each step is permission-checked like its single tool, the batch stops at the first failure, and the
result carries per-step timings plus the output of read/snapshot/js steps and a final snapshot.
`wait_for` is event-driven (MutationObserver), not polling.

## Landscape notes (web research, Oct 2026; mostly vendor/blog claims, not independent)
- Browser Use's own matched eval put Playwright MCP fastest on median task time, then Chrome DevTools MCP,
  Browser Harness, agent-browser; no significant difference in task score. Single run per task, vendor-run.
- Task time in agent loops is dominated by model turns and context size, not CDP call latency; hence
  fewer round trips (`browser_exec`) and small payloads matter more than shaving ms.
- Playwright MCP snapshots are reported at roughly 10-30k tokens for a moderately complex page; CLI-style
  tools cost far fewer tokens. Browser Use moved to a raw-CDP harness; Stagehand v3 went CDP-native and
  caches resolved actions. Auren's compact eid snapshot (<= 7.5k chars, truncation-aware) is already on the
  lean side.

## Not done / ideas
- Action caching (replay resolved element lookups), parallel tab fan-out, accessibility-tree
  (`Accessibility.getFullAXTree`) based snapshots, `Page.captureScreenshot` format/quality options.
- The remaining floor for an in-page click is the 50 ms DOM-quiet window; a caller that knows the
  page is static can use `browser_exec` with no waits... or we can expose the window as a parameter.
