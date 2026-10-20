# Fingerprinting research notes (retrieved 2026-10-19/20)

Method: web search + page fetches, plus first-hand reading of this exact Brave/Chromium 151 tree and measurements
with the harness. Confidence: **H** verified first-hand (code or measurement here), **M** primary/official source read,
**L** secondary/vendor blog or only a search snippet (treat as a lead, not a fact). Items I could not fetch are marked UNVERIFIED.

## 1. Defence families and trade-offs

| Family | Idea | Examples | Strength | Weakness |
|---|---|---|---|---|
| Uniformity | Everyone reports the same value | Tor Browser, Mullvad Browser, Firefox RFP | Anonymity set = all users of that profile; nothing to detect except "is Tor/Mullvad" | Needs a big, real crowd; breaks sites that use real values (timezone, locale, size); one leaked real value un-does it |
| Randomization ("farbling") | Per-site/session noise | Brave Shields, Safari AFP, Firefox ETP strict (new), extensions | Cheap; unlinkability across sites without breaking APIs | Noise can be detected (the *presence* of noise is a signal), averaged out (see 2.2), and partial coverage creates inconsistencies that are themselves a fingerprint ("paradox of fingerprintable PETs") |
| Blocking / prompting | API missing, empty, or permission-gated | Tor canvas prompt, Brave "strict" (deprecated), Safari gating | Strongest per API | Compat cost; "API missing" is itself a bit |

Laperdrix et al. (TWEB 2020 survey, M/L: only snippet read) call out the same trade: partial or inconsistent modification makes users
*more* visible. Our harness measures exactly that: cross-API consistency checks.

## 2. Findings that change what Auren does

### 2.1 Brave farbling, as implemented in THIS tree (H, read from source + measured)
Per (eTLD+1, session) seed `farbling_token`; levels OFF/BALANCED/MAXIMUM per webcompat type. Observed on the unmodified Auren build (baseline):
- `hardwareConcurrency` random in [2, real] (saw 3, 9 on a 10-core M4) and `deviceMemory` random from {2,4,8,16,32}.
- `navigator.plugins`: two random-named fake plugins added, PDF plugins renamed ("JavaScript PDF and PS Renderer"), list shuffled. No real browser has such a list.
- `navigator.languages` truncated to `["en-US"]` while the `Accept-Language` header is `en-US,en;q=0.5..0.9` (q random per site/session): header and JS disagree and the header differs from Chrome's `q=0.9`.
- UA-CH brand list `Not=A?Brand, Brave, Chromium` (Sec-CH-UA and `navigator.userAgentData`), `navigator.brave.isBrave()`, `window.braveEthereum/braveSolana`.
- Screen: `screen.width/height` bucketed to {1280x800,...}; `outerWidth/Height`, `screenX/Y` get random +0..8; `matchMedia(device-width)` = viewport + random: **screen.width and device-width disagree** (1280 vs 1160..1166).
- Canvas 2D: 256 channel bits (LSB XOR) of a canvas flipped, positions keyed by HMAC(token, whole buffer); `toDataURL` and `getImageData` get different perturbations (700-800 differing bytes), `putImageData` then `getImageData` does not round-trip (~200 bytes).
- Audio: every sample of `getChannelData` changed (x 0.999..1.0 factor), WebGL2 limits `MAX_*_UNIFORM_*` randomly decremented by 1 (31 vs 32: values no GPU reports), voices list real + one fake voice.
- Not active in this build: WebGL unmasked renderer masking and fake WebGL extension names (`kWebGLBalancedFingerprintingProtection` is off), WebGPU adapter scrubbing (same flag), timer rounding (`kBraveRoundTimeStamps` off), `navigator.connection` (off).
- Fonts: 71 of 180 probe fonts visible (stock Chrome 72; `Times` hidden): Brave's font allowlist affects only non-base fonts; on this Mac nothing user-installed was visible to compare.

### 2.2 Farbling can be defeated by majority voting (H, reproduced)
Nguyen & Vadrevu, "Breaking the Shield", WWW '25 (M, PDF read): attacks 9/18 canvas-protection extensions and Brave's farbling with a pixel-recovery/statistical attack; Brave acknowledged and planned to limit read-backs between user activations.
Reproduction here (`canvas2d.voteRecovered*`): draw the same scene on 9 canvases with a different marker strip, majority-vote the pixels. On the Auren build the recovered canvas hash is **identical in all 12 runs (2 sites x 3 sessions x 2 reloads) and equals stock Chrome 155's hash `5127e69d...`**, i.e. canvas noise protects against naive hash trackers only.
Design consequence: any deterministic content-keyed noise can be varied by the attacker; the only mitigations are limiting read-backs or making the underlying value non-unique. On macOS the underlying value is largely shared (same rasteriser), so canvas is a low-entropy surface here (UNVERIFIED across machines: single-machine measurement).

### 2.3 Other vendors
- **Safari 26 AFP** (WebKit blog, M; secondary summaries L): noise on canvas/WebGL/WebAudio read-back, screen/window values tied to the window, per-site and per-session; API gating. Default for all browsing in Safari 26 per secondary sources (L, sources disagree on setting naming).
- **Firefox 145** (release notes, M): new fingerprinting protections claimed to roughly halve the share of uniquely identifiable users, in Private Browsing and ETP Strict. Details beyond that sentence UNVERIFIED (blog claims about canvas/fonts/hardwareConcurrency are L).
- **Tor / Mullvad** (Tor manual, M): letterboxing (content size rounded to 200x100 steps, margins), font allowlist + character fallback, canvas extraction blocking, UA spoofing, first-party isolation. Mullvad = same patches without Tor (L).
- **Brave 1.93 post** (M, dated 2026-08-13): WebGL vendor/renderer replaced with a generic value; extension list randomized per session/eTLD+1/storage area; WebGPU adapter hardware descriptors emptied; WebGPU extension randomisation planned.
- **PrivacyTests.org** (page fetched, M for date only): updated 2026-10-16, lists Brave 1.97, Chrome 155, Firefox 158. Per-test results were images (not read). **Note: Chrome stable is 155 while Auren's engine is 151; a stale version is itself a rare bucket.**

### 2.4 WebGPU
- "What Browsers Do in the Shaders" (arXiv 2606.26412, abstract only, M): persistent pipeline-compilation state is the clearest cross-origin leak; adapter probing dominates real-world use; mitigation pilots partition by key. Quantitative entropy claims in blogs (25-35 bits) are unsourced (L, ignore).
- First-hand: adapter `vendor=apple`, `architecture=metal-3`, 22-23 features and 36 limits are exposed on both Auren and stock Chrome.

### 2.5 Network layer (H, measured)
- TLS: Auren ClientHello is BoringSSL/Chrome's, untouched by Brave: JA4 `t13d1516h2_8daaf6152771_806a8c22fdea` vs Chrome 155 `t13d1517h2_8daaf6152771_cb7bf5808d99` (one extension fewer: version drift, same cipher hash). Same groups (X25519MLKEM768 first), ALPN, GREASE. Chrome randomises extension order, so JA3 is unstable and JA4 (sorted) is what vendors use (M/L: JA4 spec read via secondary sources).
- HTTP/2: SETTINGS (65536/6291456/262144, push off) and pseudo-header order `:method :authority :scheme :path` identical to Chrome. Header order identical except Brave adds `sec-gpc: 1`.
- Not measurable by the harness: TCP/IP stack, WINDOW_UPDATE value and PRIORITY frames (Node does not expose them). UNVERIFIED.

### 2.6 Automation / CDP
- `Runtime.enable` leak (DataDome 2024 post 403'd; crawlex/rebrowser write-ups L): Error `.stack` getter triggers when a CDP client enabled `Runtime`. Reported fixed in V8 (May 2025, ships M137; L single source). Our harness never sends `Runtime.enable`; probe `automation.cdpRuntimeEnableLeak` was false on Auren 151 even though the MCP uses chrome-remote-interface. Other tells (driver globals, `sourceURL` leak) remain possible.
- `navigator.webdriver` stays false with only `--remote-debugging-port` on macOS Chrome/Auren (H). It is true for a Linux Chrome launched through the distro wrapper (H, wrapper flags unknown).

### 2.7 Chrome platform
- UA reduction is complete (frozen `Chrome/N.0.0.0`, `Macintosh; Intel Mac OS X 10_15_7`) (H: observed). Client Hints high-entropy values leak as soon as a server asks (L) - measured: Auren sent `platformVersion 26.6.2`, full Chromium version zeroed by Brave.
- Privacy Sandbox status page lists IP Protection as discontinued (M, table garbled in fetch; UNVERIFIED wording).
- `navigator.deviceMemory` range in this Chromium 151 is 2..32 on desktop (H: source `approximated_device_memory.cc`, crbug 454354290), not the old 0.25..8.
- `performance.memory.jsHeapSizeLimit` is exposed (4395630592 here) and encodes a RAM class (H).

### 2.8 Detection of protections (lie detection)
CreepJS (README/snippets, L): detects prototype tampering, worker-vs-main mismatches, canvas noise anomalies and scores them. FingerprintJS OSS v4: README gives no accuracy figure (M). EFF Cover Your Tracks methodology page does not mention farbling tests (M). Our consistency checks mirror CreepJS-style tests (worker/iframe/sandboxed-iframe parity, native-function checks, header-vs-JS parity).

## 3. Recommended policy (summary; details in policy.md)
1. One profile, one crowd: **frozen current Chrome-on-macOS** (UA, UA-CH incl. brand list, platform, header shape), identical in JS, workers, iframes and headers. Not "Brave", not "Chrome/138".
2. Uniform constants where a real crowd exists and the API has no legitimate need for exactness (hardwareConcurrency, deviceMemory, languages, plugin list, GPU strings, screen = viewport, voices hidden).
3. Keep per-site noise only where uniformity is impossible or too costly (canvas, audio), but fix its inconsistencies and be honest that it is bypassable (2.2).
4. Never produce values that real hardware cannot (random core counts, 31-vs-32 limits, fake plugins).
5. Measure everything (harness), publish what fails.
