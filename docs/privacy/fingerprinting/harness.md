# Fingerprint audit harness (`scripts/fingerprint-audit/`)

Zero dependencies, Node >= 22 (global `WebSocket`/`fetch`), `openssl` for the throwaway TLS cert. Works against any Chromium: stock Chrome, Auren (on the Mac), or a
CDP port. 

## Run
```
cd scripts/fingerprint-audit
node run.js --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --label chrome-mac --sessions 3 --repeats 2
node run.js --browser ~/brave-src/src/out/auren/Auren.app/Contents/MacOS/Auren --browser-port 9225 \
            --profile-root ~/auren-audit/fp-profile --label auren --baseline out/chrome-mac-*/raw.json
node run.js --cdp 127.0.0.1:9225 --sessions 2           # attach; one CDP browser context per "session"
node run.js --serve                                      # just serve the page for manual browsing
node run.js --reanalyze out/x/raw.json --policy auren-mac-v1   # re-evaluate saved data, no browser
node run.js --build-selftest dist/selftest.js            # single JS string for CDP/MCP injection into any http(s) tab
node run.js ... --write-profile-report <profile>/Default # feeds the NTP security bar
node --test test/                                        # unit tests (10)
```
Options: `--sessions N` (fresh profile each; = independent farbling seeds), `--repeats R` (fresh tab per repeat), `--origins a,b`
(default `site-a.localhost`, `site-b.localhost` - distinct eTLD+1), `--policy name|path`, `--baseline raw.json` (for `eqBaseline` checks e.g. JA4),
`--fail-on fail|warn|never`, `--headless`, `--no-tls`, `--out dir`. Exit 0 ok, 1 policy FAIL, 2 harness error.
Outputs in `out/<label>-<ts>/`: `raw.json`, `report.json`, `report.md`, `summary.json`.

## What it measures
26 surfaces in `lib/collect.js` (+ `workerContext`): navigator, userAgentData, screen, mediaQueries, intl, canvas2d (incl. noise statistics and the WWW'25
majority-vote attack), webgl/webgl2, webgpu, audio, fonts, geometry (ClientRects/SVG/MathML), emoji, speech, mediaDevices, webrtc, hardware (battery,
sensors, permissions, USB/HID), storage, timing, css, jsEngine (+wasm), codecs, headers (echoed header order, Accept-CH hints, TLS JA4/JA3 + HTTP/2 SETTINGS via a
loopback TLS proxy that parses the ClientHello), automation, blockers, consistency (~50 cross-API/worker/iframe/sandboxed-iframe/native-function checks).
Each surface is hashed (sha256/16 hex) from its stable `data`; `volatile` is reported but not hashed.

Behaviour classes per surface across 2 sites x N sessions x R reloads: `constant`, `per-site`, `per-session`, `per-site-session`, `unstable` (changes on reload = bug or tell), `single-sample`.
Policy (`policy/*.json`) = allowed classes per surface + checks `{path, op, value, severity}` + consistency requirements. Verdicts PASS/WARN/FAIL per surface.
Combined hash = hash of all stable surface hashes.

## Uniqueness estimate (honest)
`lib/entropy.js`: **upper bounds only**. Without a measured population there are no "1 in N" numbers. Mode 1 (`--reference` with `distributions`): bits = -log2 p from your data.
Mode 2 (default, `reference/plausible-sets.json`): bits <= log2(#plausible values) unless the value equals the policy target (0 bits *assuming the crowd adopts it*). Sums ignore correlation.

## Adding a vector
1. In `lib/collect.js` add `V.myThing = async (opts, ctx) => ({ data: {...stable...}, volatile: {...} })` and its name in `ORDER`.
2. Keep unstable numbers (timings, usage, window position) in `volatile`; only add to `data` what must be identical on reload.
3. Add checks to `policy/auren-mac-v1.json` (`path` = `<surface>.<key>...`; ops in `lib/evaluate.cjs`) and, for lie detection, a `consistency` item (`add(id, ok, detail)`).
4. `node --test test/`, run against stock Chrome (should be `constant`), then Auren.

## Mac usage and limits
Needs `node` (v24 on the Mac) and a clone of this branch there (`~/auren-audit/fp/Auren-fp`). Launching Auren opens a window. Only ports 9225/ephemeral are used.
Limits: one machine; cert errors are ignored for the loopback TLS test only (`--ignore-certificate-errors` in the launched test browser); `--cdp` contexts are off-the-record, which may change Shields seeds/defaults (not yet compared);
the in-page self-test has no header/TLS surfaces; WINDOW_UPDATE/PRIORITY frames are not observable from Node's http2.
