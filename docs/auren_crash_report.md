# AUREN — Crash & Stability Report
**Last Updated:** August 11, 2026
**Author:** Caiden Silverstein
**Version:** 151.0.7922.47 (Brave fork)
**Status:** Active — ongoing tracking document

All known crashes, launch failures, and stability issues are catalogued here. Each entry includes a severity rating, root cause analysis, fix options, and current workaround. Future crashes should be added here first before being backlogged into Linear.

---

## How to File a New Crash

When Auren crashes:
1. macOS will generate a crash report. Find it at `~/Library/Logs/DiagnosticReports/Auren_*.ips` or via Console.app.
2. Add a new entry to this document following the format below.
3. File a Gitea issue referencing this doc.
4. Note which pages / actions triggered it and whether it's reproducible.

---

## Crash Index

| ID | Severity | Title | Status | First Seen |
|---|---|---|---|---|
| [CRASH-01](#crash-01--webrequest-extension-proxy-dcheck-abort) | 🔴 P0 | WebRequest Extension Proxy DCHECK Abort | ✅ Fixed Aug 7 | Aug 6, 2026 |
| [CRASH-02](#crash-02--service-worker-workerwatcher-dcheck-abort) | 🔴 P0 | Service Worker WorkerWatcher DCHECK Abort | ✅ Fixed Aug 7 | Pre-Aug 5, 2026 |
| [ISSUE-01](#issue-01--grey-screen-on-launch) | 🟡 P1 | Grey Screen on Launch / Requires Multiple Relaunches | 🟡 Partially resolved — residual cause open (Gitea #17) | Ongoing |

---

## CRASH-01 — WebRequest Extension Proxy DCHECK Abort

**Severity:** 🔴 P0
**Type:** EXC_CRASH (SIGABRT) — DCHECK assertion failure
**First Seen:** August 6, 2026
**Fixed:** August 7, 2026 — commit `d71d04f1ac987`, cherry-picked to main as `1dd880d0c9645`
**Incident ID:** `007F3F62-77EC-4491-9261-76D00139733E`
**Process Uptime at Crash:** ~52 minutes. Also confirmed crashing in 4 seconds on subsequent launches (incident `44017DB4`), presenting visually as a grey window before abort.

### What Happened

Auren crashed on the main thread (`CrBrowserMain`) via `abort()` — a hard DCHECK failure because an internal invariant was violated.

### Crash Stack (key frames)

```
Frame 9:   WebRequestPermissions::HideRequest(...)
Frame 10:  extensions::WebRequestEventRouter::OnBeforeRequest(...)
Frame 11:  extensions::WebRequestProxyingURLLoaderFactory::InProgressRequest::RestartInternal()
Frame 12:  extensions::WebRequestProxyingURLLoaderFactory::CreateLoaderAndStart(...)
```

### Root Cause

Brave Shields was stripped at the UI layer only (`BraveToolbarView::AddActionViewForShields` stubbed out). The underlying WebRequest permission infrastructure still had Shields registered as an observer, creating inconsistent permission state. DCHECKs in `HideRequest()` fired on network requests that hit unexpected edge cases.

### Fix Applied

Downgraded three hard DCHECKs in `web_request_permissions.cc` to guarded `LOG(ERROR) + return true` blocks inside `#if DCHECK_IS_ON()`. Debug builds still surface genuine new violations.

**Files changed:** `extensions/browser/api/web_request/web_request_permissions.cc`

---

## CRASH-02 — Service Worker WorkerWatcher DCHECK Abort

**Severity:** 🔴 P0
**Type:** EXC_CRASH (SIGABRT) — DCHECK assertion failure
**First Seen:** Pre-August 5, 2026
**Fixed:** August 7, 2026 — commit `1dd880d0c9645`

### What Happened

Auren crashed on pages with heavy service worker usage (news sites, PWAs). DCHECK abort in the performance manager's worker tracking subsystem.

### Crash Stack (key frames)

```
#9   performance_manager::WorkerWatcher::DisconnectSharedWorkerClient(...)
#10  performance_manager::WorkerWatcher::DisconnectAllServiceWorkerClients(...)
#11  performance_manager::WorkerWatcher::OnVersionStoppedRunning(...)
#12  performance_manager::ServiceWorkerContextAdapterImpl::OnVersionStoppedRunning(...)
```

### Root Cause

Upstream bug in Brave at `151.0.7922.47`. Out-of-order service worker teardown race: `WorkerWatcher` tried to disconnect clients that had already been cleaned up. Not Auren-specific — exists in upstream Brave source at this tag.

### Fix Applied

Downgraded the hard `CHECK`s in `OnVersionStoppedRunning` and `DisconnectSharedWorkerClient` in `worker_watcher.cc` to guarded `LOG(ERROR) + return` early exits.

**Files changed:** `components/performance_manager/worker_watcher.cc`

---

## ISSUE-01 — Grey Screen on Launch

**Severity:** 🟡 P1
**Type:** Launch / rendering failure
**First Seen:** Ongoing since first build
**Status:** 🟡 Partially resolved — Layer 1 fixed Aug 7, Layer 2 open (Gitea #17)
**Tracking:** Gitea caiden/Auren #17

### What Happens

On launch, Auren opens to a solid grey screen with nothing rendered. Quit + relaunch resolves it, sometimes requiring 2–3 attempts.

### Root Cause (Two-Layer)

**Layer 1 — Fixed (CRASH-01):** When CRASH-01 fired within ~4 seconds of startup, the window appeared grey before the process aborted. This was the primary cause of grey screens pre-Aug 7. Eliminated by the CRASH-01 patch.

**Layer 2 — Open (Gitea #17):** Grey screens still occur occasionally post-fix. At least one independent launch failure cause exists. Leading candidates:

**A — CDP port 9223 not releasing (most likely)**
Auren binds `--remote-debugging-port=9223` at startup. After a crash or force-quit, the port may still be held when the new instance tries to bind it. Silent initialization failure → grey screen. Matches the "quit and relaunch fixes it" pattern.

**B — GPU process initialization race**
`is_component_build=true` causes the GPU process to load many `.dylib`s at startup. GPU process may not be ready before the browser attempts first paint → grey compositor surface.

**C — Metal shader compiler warmup stall**
First invocation of the Metal GPU shader compiler after inactivity can stall the GPU process for several seconds.

**D — Side panel WebContents stall**
`AurenSidePanelWebView` loads `https://claude.ai` at startup. Lazy `EnsureAurenPanelCreated()` is in place but a stall in the load may still affect the main window init path.

### Next Steps (tracked in Gitea #17)

1. Add CDP port release check before binding 9223 — cheapest fix to try first
2. Instrument startup with `LOG(INFO)` at GPU ready / side panel init / first paint
3. Reproduce grey screen with logging enabled and identify stall point

### Files to Investigate

```
chrome/browser/app/chrome_main_delegate.cc
chrome/browser/ui/views/frame/browser_frame.cc
brave/browser/ui/views/auren/auren_side_panel_web_view.cc
```

---

## Notes on Version-Level Risk

All crashes are at Brave tag `151.0.7922.47` (pinned). A tag bump would be the highest-leverage single fix but carries risk of patch breakage. Recommended approach: patch locally for known crashes, defer tag upgrade to a dedicated maintenance window.

---

## Template for Future Crashes

```markdown
## CRASH-XX — [Short Title]

**Severity:** 🔴 P0 / 🟡 P1 / 🟢 P2
**Type:** EXC_CRASH (SIGABRT) / EXC_BAD_ACCESS / other
**First Seen:** [Date]
**Incident ID:** [From crash report header]
**Process Uptime at Crash:** [Elapsed time]

### What Happened
[1–2 sentence summary]

### Crash Stack (key frames)
[Relevant frames only]

### Root Cause
[What the code was doing, why it failed, Auren-specific or upstream]

### Triggering Conditions
[What page, what action, reproducible?]

### Fix Options
[A, B, C]

### Fix Applied
[What was done, commit SHA, files changed]

### Files to Investigate
[Source paths]
```
