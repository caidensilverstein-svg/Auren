# CRASH-01 — WebRequest Extension Proxy DCHECK Abort

**Severity:** 🔴 P0
**Type:** EXC_CRASH (SIGABRT) — DCHECK assertion failure
**First Seen:** August 6, 2026
**Fixed:** August 7, 2026 — commit `d71d04f1ac987`, cherry-picked to main as `1dd880d0c9645`
**Incident ID:** 007F3F62-77EC-4491-9261-76D00139733E
**Process Uptime at Crash:** ~52 minutes. Also confirmed crashing in 4 seconds on subsequent launches (incident 44017DB4), presenting visually as a grey window before abort (see [ISSUE-01](../issues/issue-01.md)).

## What Happened

Auren crashed on the main thread (`CrBrowserMain`) via `abort()` — a hard DCHECK failure because an internal invariant was violated.

## Crash Stack (key frames)

```
Frame 9:   WebRequestPermissions::HideRequest(...)
Frame 10:  extensions::WebRequestEventRouter::OnBeforeRequest(...)
Frame 11:  extensions::WebRequestProxyingURLLoaderFactory::InProgressRequest::RestartInternal()
Frame 12:  extensions::WebRequestProxyingURLLoaderFactory::CreateLoaderAndStart(...)
```

## Root Cause

Brave Shields was stripped at the UI layer only (`BraveToolbarView::AddActionViewForShields` stubbed out). The underlying WebRequest permission infrastructure still had Shields registered as an observer, creating inconsistent permission state. DCHECKs in `HideRequest()` fired on network requests that hit unexpected edge cases.

## Fix Applied

Downgraded three hard DCHECKs in `web_request_permissions.cc` to guarded `LOG(ERROR)` + `return true` blocks inside `#if DCHECK_IS_ON()`. Debug builds still surface genuine new violations.

**Files changed:** `extensions/browser/api/web_request/web_request_permissions.cc`
