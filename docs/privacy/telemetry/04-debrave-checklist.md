# 04 De-brave checklist

Evidence: `data/before/webui-scan.jsonl` (32 internal pages), macOS menu dump, Info.plist.

| area | status | notes |
|---|---|---|
| App name / bundle id / icons / BRANDING | done (earlier work) | `io.auren.Auren`, `CFBundleName=Auren` |
| English UI strings (grd/grdp, 106 files) | done in tree, build pending | `scripts/privacy/debrave_strings.py`, idempotent |
| Help / learn-more / download links in C++ (177 literals) | done in tree, build pending | `scripts/privacy/debrave_urls.py` -> github.com/caidensilverstein-svg/Auren |
| First-run Welcome page (title "Welcome to Brave", P3A notice) | first-run tab removed; page still reachable (`chrome://welcome`, menu entries "Welcome to Brave" in Tab/Window menu) | deferred: page strings now say Auren after string pass; remove page registration later |
| Default search engine Brave Search | done (DuckDuckGo) | new profiles |
| NTP | done (Auren NTP, no external assets) | |
| Rewards, Wallet, News, VPN, Leo, Talk, Playlist, Wayback, WDP toolbar/menu/settings | compiled out | verify in UI after build |
| Help menu "Auren Help" URL, "Report a Broken Site" | partial | help URL -> project page; webcompat menu item remains, endpoint .invalid |
| "New Private Window with Tor" | kept | Tor client unavailable without updater (05) |
| `brave://` display of internal URLs | deferred | see 05 item 6 |
| Settings: "Brave Sync", "Shields" (named `braveSync`, `shields` routes), "Brave Account" | partial | text rebranded by strings pass; route names stay |
| `chrome://about`, `chrome://flags` list `brave://` flags (207 mentions) | deferred | |
| User agent / `sec-ch-ua` brand | not touched | fingerprint agent owns it |
| Profile dir `BraveSoftware/Brave-Browser-Development`, Keychain "Brave Safe Storage", crashpad dir | deferred | data-loss risk, recipe in 05 |
| `CFBundleURLTypes`, Bonjour `_googlecast._tcp` | deferred | Cast pref off |
| Copyright "Brave Authors" in source headers | not changed | licence requirement (MPL) |
| Non-English locales | deferred | |
