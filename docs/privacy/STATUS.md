# Privacy work: status (2026-10-22)

Everything below was measured on the Mac on 2026-10-22 against a **dev build** (`out/auren`: component build, DCHECKs on). Files named in
brackets are the evidence. Anything not measured is listed at the end.

## Verified

| area | result | evidence |
|---|---|---|
| Network at idle | 15-minute idle capture, fresh profile: **0 unexpected hosts** (only DNS-over-HTTPS). The unhardened 15-minute capture contacted 4 Brave hosts (`go-updater` 13 requests, `safebrowsing`, `usage-ping`, `variations`). | `audit-0-idle.json`, `audit-N2-idle15.json` |
| Firewall | Blocked requests never reach the netlog, so this is gating plus firewall. Startup and the search-engine settings page produced 3 browser-process attempts, all blocked: `www.google.com`, `cdn.search.brave.com`, `update.googleapis.com` (source not yet identified). | `strict/strict-test-hosts.txt` |
| Bundled protections | 17 filter lists + debounce, URL-cleaning and query-filter data load from inside the binary. | run log `AUREN_PROTECTIONS: loaded 17 bundled filter lists` |
| Blocking | 75 of 953 requests blocked on 12 real pages (9 lists, 2 runs); 70 of 848 with all 17 (1 run). Stock Chrome, same pages: 0 of 2,062. | `prot/auren-prot-{1,2}.json`, `perf/out/chrome-stock-pageload.json` |
| Redirect trackers / tracking parameters | 6 of 6 cases: four tracker links debounce straight to the target, `fbclid`/`gclid`/`mc_eid` are stripped, an ordinary URL is untouched. | `urlrules/v3.json` |
| Fingerprint harness | **30 FAIL -> 3 FAIL**, 122 -> 150 PASS (same harness and policy). | `docs/privacy/fingerprinting/post-results-2026-10-22.md` |
| Web API surface | 11 of 55 probed surfaces differ from stock Chrome: Topics, Protected Audience, Fenced Frames, Attribution Reporting, Private State Tokens and the Network Information API are absent; `Sec-GPC: 1` is sent; `hardwareConcurrency` 8 and `deviceMemory` 8; no "Brave" in client-hint brands. | `surface/{auren,chrome}.json` |
| Compiles | Tor bridges patch, `0002-js-heap-size-limit`, bundled protections, strict firewall (after one fix), plist change all compile against the real tree. | build logs |

## Found and fixed tonight

* The component updater being off had emptied every protection Brave ships as data. Now bundled (`docs/privacy/protections.md`).
* `apply.py` skipped its resource edit when a marker already existed, so a changed manifest was never applied; it now regenerates the block on every run.
* The firewall's escape hatch `--auren-allow-service-requests` never worked: the network service is a separate process and does not receive custom switches. It now also reads the environment (`AUREN_ALLOW_SERVICE_REQUESTS`, `AUREN_FIREWALL_STRICT`).
* The fingerprint baseline's `jsHeapSizeLimit` check lists `4294967296`; the patch sets Chrome's usual `4294705152`. Both are constants; the criterion was not edited.

## Not verified

* Tor on this Mac build (smoke test queued behind the rebuild), Tor unit tests on the real toolchain, the bridge settings UI.
* The release-flavour build (non-component, DCHECKs off, PGO profile): compiling; speed numbers for the dev build are not representative.
* Battery values on a laptop; Linux/Windows browser-side behaviour; Windows and macOS x86_64 Tor bundles were never run.
* A blanket default-deny firewall: strict mode exists but was not evaluated for breakage.
* Scriptlet/redirect resources are not bundled; rules that need them are inert.

## Decisions waiting for you

1. WebUSB/HID/Serial/Bluetooth (and MIDI, battery, sensors) off by default: `docs/privacy/fingerprinting/post-results-2026-10-22.md`.
2. Licenses of the bundled lists before any distribution: `docs/privacy/protections.md`.
3. Merging PR #20 / #21 (and then the Oracle deploy).
