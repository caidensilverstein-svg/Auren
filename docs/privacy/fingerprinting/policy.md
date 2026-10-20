# Auren fingerprinting policy v1 ("Auren-Mac-Chrome")

Machine-checkable form: `scripts/fingerprint-audit/policy/auren-mac-v1.json` (79 checks + consistency set). Written before the
patches; the baseline FAIL list is the work list.

## Threat model
In scope: cross-site tracking by third-party/first-party scripts using passive (headers, TLS) and active (JS) fingerprinting; trackers that
detect protection tools and treat them as a signal; fingerprint-based bot scoring that must not break the AI agent / claude.ai panel.
Out of scope: network-level adversaries who see the IP (use a VPN/Tor), malware, a site that gets a permission grant (camera, local-fonts),
timing/cache side channels beyond what is listed, and users who install extensions.
Goals, in order: (1) non-unique and stable inside one site session, (2) the same on every Auren install (uniformity), (3) never inconsistent
(no impossible or self-contradicting values), (4) sites keep working.

## Profile decision
Pretend to be what we mostly are: **Chrome (current stable engine) on macOS**. Reasons: the engine already emits the frozen Chrome UA; Chrome is by
far the largest crowd on that engine; Brave's own brand adds nothing but a smaller set. Mac-only keeps GPU/font/rasteriser diversity small
(one rendering stack). Side-panel UA of `Chrome/138` is removed (inconsistent with Chrome/151 UA-CH). Staying current matters: an old engine
version is its own bucket (Chrome stable is 155 at time of writing; Auren is 151).

## Per-surface decisions
Legend: U uniform constant, R per-site/session randomization, B block/hide, N native (unchanged), P prompt/permission (existing).

| Surface | Decision | Exact value / behaviour | Rationale | Compat risk | Patch |
|---|---|---|---|---|---|
| navigator.userAgent, appVersion, platform, vendor | N+U | frozen Chrome-on-macOS string; `MacIntel`; `Google Inc.` | already Chrome's | none | - |
| UA-CH brands (JS + `Sec-CH-UA`) | U | `Google Chrome`, `Chromium`, GREASE; no Brave/Auren | single brand source for JS+header | sites that sniff for Brave (none wanted) | 0006 |
| UA-CH high entropy | U | arch `arm`, bitness 64, model empty, full version `N.0.0.0`, platformVersion `major.0.0` | coarsen build/OS patch level | OS-version feature gating on exact patch | 0006 |
| navigator.brave, window.braveEthereum/Solana | B | removed (`navigator.brave`); wallet providers: **de-Brave scope, not patched here** | brand leak | sites calling brave.isBrave | 0008 |
| languages / Accept-Language | U (configurable) | `["en-US","en"]`, header `en-US,en;q=0.9` (derived: first language + its base) | equals Chrome single-language profile; JS==header | non-English users keep their first language (derived) | 0001, 0007 |
| hardwareConcurrency | U | 8 in main, workers, iframes | modal-ish Mac value (UNVERIFIED frequency) | heavy wasm/thread pools use 8 not 10 | 0001 |
| deviceMemory | U | 8 | valid Chromium bucket | sites that tune quality by RAM | 0001 |
| plugins / mimeTypes / pdfViewerEnabled | U | Chrome's five PDF plugins, true | Chrome crowd | none | 0002 |
| screen, outer*, screenX/Y, availTop/Left, device-width/height | U (=viewport) | all equal the viewport size; screenX/Y/availTop/Left = 0; colorDepth 24 | viewport is public anyway; no display/menu-bar geometry | apps wanting real monitor size (full-screen video sizing uses viewport) | 0005 |
| devicePixelRatio | N | real (2 on Retina) | big crowd, breaks layout if faked | - | - |
| viewport (inner size) | N | letterboxing (Tor-style 200x100 steps) is **future UI work** | highest-entropy remaining window metric | - | open |
| timezone / locale / Intl | N (configurable) | real zone | IP already reveals it; UTC breaks calendars; strict mode = UTC is a future pref | - | - |
| canvas 2D / OffscreenCanvas / toDataURL | R | keep Brave per-site LSB noise | cheap unlinkability; **bypassable (research 2.2)** | noise breaks lossless data-in-canvas | - |
| WebGL unmasked vendor/renderer | U | `Google Inc. (Apple)` / `ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)` | one GPU family string for all | sites choosing quality by GPU model | 0004 |
| WebGL params/extensions | N (no fake) | real; the impossible `-1` perturbation removed | real GPU families share most values (UNVERIFIED across chips) | - | 0004 |
| WebGPU adapter info | B | vendor/architecture/device/description empty | descriptors are pure identifiers | engines that pick paths by vendor | 0004 |
| WebGPU limits/features | N | real | needs bucketing design | - | open |
| Web Audio | R | keep per-site gain farbling | as canvas | audio-analysis apps | - |
| Fonts | U (existing) | Brave allowlist for non-base fonts; macOS base fonts visible | Tor-style allowlist | design tools needing installed fonts | - |
| speechSynthesis voices | B | empty list | 181 voices = OS/language fingerprint | TTS sites | 0003 |
| mediaDevices | N | no labels without permission | already Chrome behaviour | - | - |
| WebRTC | U | no raw IPs (mDNS only) - **already true** | verified: 0 raw IPs | WebRTC apps on same LAN | - |
| battery, WebUSB/HID/Serial/Bluetooth/MIDI, sensors | B | should be absent | no benign need for passive probing | device pairing sites | **not done** (open-risks 3) |
| performance.now / timers | N | Chrome default (100 us + jitter); `performance.memory` should be hidden | `kBraveRoundTimeStamps` rounding is too coarse for animations | - | open |
| GPC | keep ON | `Sec-GPC: 1`, `navigator.globalPrivacyControl` | legal signal; costs ~1 bit (Brave/Firefox/DDG users share it) | - | - |
| TLS / HTTP2 / header order | N | Chrome's (verified, 2.5) | untouched BoringSSL stack | - | - |
| Ad-block / extension detection | N | bait elements are cosmetically filtered (1 bit); extension probes find none | inherent to blocking | - | - |
| Automation hygiene | N | `navigator.webdriver` false without `--enable-automation`; no `Runtime.enable` by the harness; MCP uses CDP and may trip `Runtime.enable` probes | honest, no stealth patches | bot walls | doc only |

Shields-off exceptions: the claude.ai side panel runs with Shields disabled, therefore **with real values** (farbling OFF). It
shares the profile, so it sees the real core count, memory and voices. Accepted (first party the user chose) but flagged in open-risks.

## What the harness verifies vs not
Verified automatically once built: every row marked with a patch has a policy check (`nav.*`, `uach.*`, `screen.*`, `webgl*`, `webgpu*`,
`speech.*`, `headers.*`) plus the consistency set. Not verifiable by the harness: real-world compat of each row (needs manual browsing),
frequency claims behind the constants, multi-machine uniformity.

## Security-bar indicator
`auren_security_handler.cc` no longer computes `fingerprint_score` from the Shields setting (100/66/0). It reports
`n/m` verified configuration items (Shields fingerprinting control, language reduction, screen protection, WebRTC IP policy) and, if
`<profile>/auren-fingerprint-audit.json` exists (written by `run.js --write-profile-report`), the last **measured** audit
(fail/warn counts and date). Tooltip says "not a uniqueness score". Proposed honest labels (docs only; DNS defaults belong to the telemetry work):
- DNS: green only for `SecureDnsConfig mode == secure`; "automatic" (falls back to plaintext) = amber "DoH (may fall back)"; off = red.
- TOR: "Tor available" (a circuit exists) - not "your traffic is routed through Tor". The NTP Tor/DNS toggles currently only flip local JS
  state and do nothing; they should be disabled or wired.
