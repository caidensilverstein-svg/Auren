# Open risks and gaps

1. **Nothing built.** All patches are apply-checked only. First step after the next build: `node run.js --browser ...Auren --label post --baseline <chrome-mac raw.json>` and diff against baseline-results.md. Expect: navigator/userAgentData/headers/screen/speech to become `constant`; canvas/audio/webgl hash stay per-site.
2. **Canvas/audio randomization is bypassable** (reproduced: 12/12). Options not done: limit canvas read-backs per user activation (Brave's announced fix), uniform rendering. Honest stance: noise only stops naive hash trackers.
3. **Hardware APIs still exposed** (revised 2026-10-21 after reading the source at brave-core v1.94.97 / Chromium 151.0.7922.47):
   * `getBattery`: **correction.** An earlier version of this note said it "returns real charge state". Brave's
     `chromium_src/.../battery_manager.cc` returns constants (`charging=true`, `level=1.0`, `chargingTime=0`,
     `dischargingTime=Infinity`), the same as a desktop with no battery. The harness only recorded that the function
     *exists* (`hardware.batteryApi`); no stored run shows the values, so the real values were never measured here. To
     close: read `navigator.getBattery()` values on a MacBook battery in the next harness run.
   * WebUSB / WebHID / Serial / Web Bluetooth are present, as in stock Chrome. Removing them is a policy trade-off, so the
     patch is optional: `patches/privacy/fingerprint/optional/0009-...` (README there). MIDI is permission-gated, the
     Generic Sensor classes are exposed unconditionally in Chrome too, and Local Font Access is permission-gated:
     none of these is patched.
   * `performance.memory`: Chromium already buckets and rate-limits `used`/`total`, but `jsHeapSizeLimit` follows RAM
     (V8 uses about a quarter of physical memory, up to 4 GB), which tells an 8 GB Mac from a 16 GB one and disagrees
     with the constant `deviceMemory=8`. `patches/privacy/0002-js-heap-size-limit.patch` reports one value (Chromium
     tree, apply-checked, not compiled).
4. **Wallet globals** (`window.braveEthereum`, `braveSolana`, `window.ethereum` injection) remain a Brave tell: belongs to de-Brave (disable wallet feature/policy); the harness check `nav.no_suspicious_window_keys` will fail until then.
5. **claude.ai panel runs with Shields off**: real hardware values leak to claude.ai and any third party it loads. Needs a dedicated partition/profile instead of a global exemption (also in the backend audit).
6. **Engine is 4 majors behind Chrome stable (151 vs 155)**: version bucket + security. Update cadence is a privacy control.
7. **Constants are guesses**: 8 cores, 8 GB, "Apple M1" renderer are chosen for plausibility, not from population data (UNVERIFIED). A GPU string that disagrees with the real parameter set (M4 limits under an M1 name) can be spotted by a vendor with a lookup table.
8. **Residual high-entropy signals**: viewport size (no letterboxing), devicePixelRatio, HDR/gamut media queries (XDR displays), WebGPU limits/features (36 limits, 22 features), CSS/JS feature set (tracks engine version), codec support, system colors, timezone, storage quota (2 GiB here, 10 GiB stock Chrome), fonts (macOS-version dependent), emoji set.
9. **Measurement limits**: single machine; localhost origins (Shields may treat them specially - farbling was active, so no); `--cdp` mode and OTR contexts untested; entropy numbers are upper bounds; no population data; TCP/IP and HTTP/2 WINDOW_UPDATE not observable; Local Font Access and permission-gated APIs not exercised.
10. **Automation**: MCP uses chrome-remote-interface; if it sends `Runtime.enable` on pages, older bot walls can see it (patched in V8 since M137 per one source). We deliberately do not spoof `navigator.webdriver` or add stealth.
11. **Security bar**: toggles for TOR/DNS in the NTP are cosmetic; ~~NTP loads Lucide icons from a CDN~~ (resolved: icons are inlined SVG, no network request); checklist covers only 4 items and cannot see the compiled-in patches. A true on-demand self-test needs an http(s) origin (data:, file:, chrome(-untrusted): are not farbled), so it is provided as CDP/MCP injection (`--build-selftest`) rather than inside the NTP.
12. **Compat risks to test by hand**: sites using `Accept-Language` for locale, TTS/WebGPU/WebGL2 apps, canvas-as-storage apps, video sites reading screen size, Google/Anthropic login in the panel.
