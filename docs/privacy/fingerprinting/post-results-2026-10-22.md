# Fingerprint harness, after the patches (2026-10-22)

The first run of `scripts/fingerprint-audit` against a build that contains patches 0001-0008 and `patches/privacy/0002-js-heap-size-limit.patch`.
Same Mac, same harness and policy (`auren-mac-v1`), same shape of run as the baseline (3 sessions x 2 origins x 2 reloads), headful, fresh profiles.
The patches had been apply-checked but never compiled or run before this build; they compile and the effects below are measured, not assumed.

| | baseline 2026-10-20 (before any fingerprint patch) | now (`auren-post-2026-10-22T04-16-33`) |
|---|---:|---:|
| FAIL | 30 | **3** |
| WARN | 12 | 11 |
| PASS | 122 | **150** |
| Surfaces that differ per site+session | navigator, screen, canvas2d, webgl, audio, emoji, speech, headers, workerContext | canvas2d, webgl, audio, emoji, workerContext |
| Stock Chrome 155 on the same Mac (for scale) | 13 FAIL, 12 WARN, 139 PASS | not rerun |

The four surfaces that still differ per site and session (canvas2d, webgl, audio, emoji) are the deliberate farbling; the policy accepts them.
`navigator`, `userAgentData`, `screen`, `speech` and `headers` are now constant across sites and sessions (uniformity), which is what the
patches were for. Confirmed by a separate probe (`scripts/privacy/api_surface.js`): `hardwareConcurrency` 8 (this Mac has 10), `deviceMemory` 8 (16),
client-hint brands `Not=A?Brand, Google Chrome, Chromium` (no "Brave"), `Sec-GPC: 1` sent, `navigator.brave` absent.

## What is still failing or warning

| result | check | what it means | decision |
|---|---|---|---|
| FAIL | `hw.no_battery_api` | `navigator.getBattery` exists | policy decision (below) |
| FAIL | `class.mediaDevices` | `enumerateDevices` result changes on reload within a session | not investigated; likely device-list timing, needs a look |
| FAIL | `class.workerContext` | worker-context values vary per site+session (farbling reaches workers) | the policy wants a constant; either accept farbling in workers or normalise it |
| WARN x6 | `hw.no_webusb/hid/serial/bluetooth/midi`, `hw.no_sensor_constructors` | those APIs exist | policy decision (below) |
| WARN | `timing.no_performance_memory` | `jsHeapSizeLimit` is a constant `4294705152`; the policy lists `4294967296` | both are constants; the allowed list should include Chrome's usual `4294705152`. Not changed here: editing the criterion to match my patch should be your call |
| WARN x3 | `consistency.canvas_*`, `audio_getChannelData_exact` | farbling noise is detectable by round-tripping | inherent to noise-based farbling |
| WARN | `tls.ja4_equals_baseline` | JA4 differs from stock Chrome (`t13d1518h2_...` vs `t13d1517h2_...`), as in the baseline | not touched |

## The decision waiting for you

Eight of the 14 remaining checks are one question: should WebUSB, WebHID, Web Serial, Web Bluetooth (and optionally MIDI, battery, sensors) be off by default?
Off is what Tor Browser does and removes both a fingerprinting surface and a permission-prompt attack surface. The cost is real: hardware wallets, Arduino/ESP web
flashers, some Chromebook-style tools and a few device-pairing pages stop working. `patches/privacy/fingerprint/optional/0009-disable-usb-hid-serial-bluetooth.patch`
does the first four and is apply-checked; it is not applied. Battery, MIDI and sensors would need the same `--disable-blink-features` mechanism extended. If you say
"off", the three hardware FAILs/WARNs go away; I have not built that variant.

## Reproduce

`cd scripts/fingerprint-audit && node run.js --browser <Auren binary> --browser-port 9225 --profile-root <dir> --label auren-post --baseline <stock-chrome raw.json> --sessions 3 --repeats 2`
(see `docs/privacy/fingerprinting/harness.md`). The full report is `report.md` in the run directory on the Mac (`~/auren-audit/fp-out-post/`).
