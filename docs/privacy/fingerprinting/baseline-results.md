# Baseline results (2026-10-20, before any fingerprint patch)

Machine: MacBook with Apple M4 (10 cores, 16 GB), macOS 26.6.2, display scaled to 1470x956. Harness commit `7ccf95a`, policy `auren-mac-v1`,
3 sessions x 2 sites x 2 reloads, localhost origins `site-a.localhost` / `site-b.localhost`. Full reports live on the Mac in
`~/auren-audit/fp/out/` (`auren-baseline-2026-10-20T03-56-09`, `chrome-mac-stock-2026-10-20T03-57-21`); regenerate with `docs/.../harness.md`.

| | Auren (Brave 151 engine, `out/auren`) | Stock Google Chrome 155.0.8059.85 (same Mac) |
|---|---|---|
| Checks | **30 FAIL**, 12 WARN, 122 PASS | 13 FAIL, 12 WARN, 139 PASS |
| Surfaces that change per site+session | navigator, screen, canvas2d, webgl, audio, emoji, speech, headers, workerContext | none (speech unstable on reload: voices list 19 vs 199) |
| Upper-bound identifying bits (11 attributes, see harness.md caveat) | 20.3 | 16.8 |
| Combined stable hash | `b077a1b28d893b2c` (varies by site/session) | `e44f4b9d28e36241` |
| UA | `...Chrome/151.0.0.0 Safari/537.36` (Mac frozen) | `...Chrome/155.0.0.0...` |
| Sec-CH-UA | `"Not=A?Brand";v="99", "Brave";v="151", "Chromium";v="151"` | `"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"` |
| navigator.brave / braveEthereum / braveSolana | present | absent |
| hardwareConcurrency | random 3, 9, ... (real 10) | 10 |
| deviceMemory | random 8/16 (real 16) | 16 |
| languages / Accept-Language | `["en-US"]` / `en-US,en;q=0.5-0.9` (random) | `["en-US","en"]` / `en-US,en;q=0.9` |
| plugins | 7 incl. random names, shuffled | 5 standard |
| screen / device-width | 1280x800 bucket / viewport+0..8 (mismatch) | 1470x956 / same |
| outer-inner, screenX/Y | random 0..8 | real window geometry (outer height +87) |
| canvas uniform fill | 273/4096 pixels altered (+-1) | 0 |
| canvas majority-vote (N=9) | recovers stock-Chrome canvas hash `5127e69d...` in 12/12 runs | n/a (no noise) |
| WebGL2 limits | `MAX_UNIFORM_BUFFER_BINDINGS` 31/32, `MAX_FRAGMENT_UNIFORM_BLOCKS` 15/16 varying per site | 32 / 16 |
| WebGL unmasked renderer | real `Apple M4` | real `Apple M4` |
| WebGPU adapter | vendor `apple`, arch `metal-3` | same |
| Voices | 181 | 19-199 |
| battery API, WebUSB/HID/Serial/Bluetooth/MIDI | present | present |
| performance.memory jsHeapSizeLimit | 4395630592 | 4395630592 |
| storage quota | 2 GiB | 10 GiB |
| fonts visible (of 180 probes) | 71 | 72 |
| TLS JA4 | `t13d1516h2_8daaf6152771_806a8c22fdea` | `t13d1517h2_8daaf6152771_cb7bf5808d99` |
| H2 SETTINGS / pseudo order | 65536/6291456/262144, `m,a,s,p` | identical |
| Header order | Chrome's + `sec-gpc` | Chrome's |
| WebRTC raw IPs | 0 (mDNS only) | 0 |
| CDP `Runtime.enable` leak / webdriver | false / false | false / false |

Auren consistency failures (11): `brands_no_brave_or_auren`, `fullVersionList_no_brave_or_auren`, `no_navigator_brave`, `worker_no_navigator_brave`,
`accept_language_matches_navigator_languages`, `plugins_are_chrome_standard_five`, `plugins_no_random_names`, `screen_matches_media_query`, and (warn)
`canvas_png_matches_getImageData` (~790 bytes), `canvas_put_get_roundtrip_exact` (~230 bytes), `audio_getChannelData_exact`. Stock Chrome: none.

Reading: today Auren is *more* unique than stock Chrome in the metrics that matter for detection (impossible values, brand, fake plugins), while
its randomized surfaces are defeatable (canvas vote attack). The patches in `patches/privacy/fingerprint/brave/` target exactly the FAIL rows; expected
post-patch result is documented in patch-notes.md and **has not been measured because nothing was built**.

Also run, but not documented as a baseline: stock Chrome 155 on Linux (this dev box, headless and headful) to develop the harness; its FAILs are the Linux/Windows-vs-Mac policy.
Not run: `--cdp` attach mode against a live Auren (code path exercised only through `--browser`); Auren with the Shields-off claude.ai panel; Firefox/Safari.
