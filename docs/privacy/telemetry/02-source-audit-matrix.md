# 02 Source audit matrix

Tree: `~/brave-src/src` (Chromium 151.0.7922.47 + Brave layer). Mechanism legend:
**GN** build arg, **SW** baked command-line switch/feature
(`brave/app/brave_main_delegate.cc`), **PREF** default value, **PATCH** source change,
**FW** network-service firewall (`services/network/url_loader_factory.cc`: browser-process,
non-navigation requests to Brave/Google/.invalid hosts get `ERR_BLOCKED_BY_CLIENT`;
override `--auren-allow-service-requests`).
Status: **OBS** = seen in baseline netlog, **SRC** = from source only (not observed).
"Patched" means committed in the Mac tree and covered by the pending rebuild; see
03 for the verified result.

| # | service | endpoint(s) | evidence | gate | status |
|---|---|---|---|---|---|
| 1 | Brave component updater | go-updater.brave.com/extensions; updates.bravesoftware.com (Omaha) | OBS 13 req/start; `components/update_client/BUILD.gn`, `app/brave_main_delegate.cc` | SW `--disable-component-update`; GN `updater_*_endpoint`, `update_check_url` -> .invalid; PATCH `GetUpdateURLHost()` empty; FW | patched |
| 2 | Variations / field trials | variations.brave.com/seed, griffin.brave.com (PR seeds), clientservices.googleapis.com | OBS; `components/variations/command_line_utils.cc` | PATCH stop appending `--variations-server-url` (Chromium then never fetches: `IsFetchingEnabled`); GN url -> .invalid; FW | patched |
| 3 | Stats updater + referrals | usage-ping.brave.com (`/1/usage/brave-core`, `/promo/initialize/nonua`, `/promo/activity`) | OBS | GN `enable_brave_stats_updater=false`, `brave_stats_updater_url`, `brave_services_*_domain=services.invalid` (referral host is derived from it) | patched |
| 4 | Safe Browsing (via Brave proxy; Google endpoints are redirected to it by `brave/components/constants/network_constants.h`) | safebrowsing.brave.com; safebrowsing.googleapis.com, sb-ssl.google.com | OBS | PREF `safebrowsing.enabled/enhanced=false` default; SW `--disable-background-networking` (v4 config provider); GN `safebrowsing_api_endpoint` .invalid; FW. Not done: `safe_browsing_mode=0` (large rebuild, compile risk) | patched |
| 5 | Omnibox search suggestions | search.brave.com/api/suggest?q=... | OBS (UI scenario) | PATCH `PrepareSearchSuggestionsConfig` / `UpdateDefaultSearchSuggestionsPrefs` never enable; FW | patched |
| 6 | Default search engine = Brave Search | search.brave.com | SRC | PATCH `GetPrepopulatedFallbackSearch` -> DuckDuckGo (new profiles only; existing profile keeps stored choice) | patched |
| 7 | Auren NTP external assets | fonts.googleapis.com, fonts.gstatic.com, unpkg.com | OBS (resource timing) | PATCH `browser/ui/webui/auren_new_tab_ui.cc`: system font stack, inline Lucide SVG paths, CSP `connect-src 'none'`, style/script/font `'self'` | patched |
| 8 | P3A (Brave telemetry) | p3a*.brave.com, star-randsrv.bsg.brave.com, collector.bsg.brave.com | SRC (not seen in 15 min) | PATCH `P3AService::RegisterPrefs` default false | patched |
| 9 | UMA/UKM metrics | Google/Brave metrics servers | SRC: `chromium_src/components/metrics/enabled_state_provider.cc` hard-wires `IsReportingEnabled()=false` | already off upstream-of-us | n/a |
| 10 | Crash upload | cr.brave.com (OFFICIAL_BUILD only), clients2.google.com/cr | SRC; non-official: empty URL, no consent | PATCH upload URL always empty. Crashpad still writes local minidumps | patched |
| 11 | Brave Sync | sync-v2.brave.com | SRC | SW `--disable-sync`; GN `brave_sync_endpoint` .invalid | patched |
| 12 | Brave Rewards / Ads / BAT / Uphold / bitFlyer / Gemini / Zebpay | rewards.brave.com, ads.brave.com, static.ads.brave.com, grant.rewards.brave.com | SRC; idle: none | GN `enable_brave_rewards=false`, `enable_brave_ads=false` | patched |
| 13 | Brave Wallet / Web3 / decentralized DNS | *.wallet.brave.com, ENS/SNS RPC | SRC | GN `enable_brave_wallet=false` | patched |
| 14 | Brave News (Today) | brave-today-cdn.brave.com, pcdn.brave.com | SRC | GN `enable_brave_news=false`; Auren NTP is custom | patched |
| 15 | Brave VPN | account.brave.com, vpn.brave.com, SKUs | SRC | GN `enable_brave_vpn_v1/v2/panel/wireguard=false` | patched |
| 16 | Leo AI chat | account.brave.com, ai-chat endpoints, search.brave.com | SRC | GN `enable_ai_chat=false`, `enable_brave_ai_chat_agent_profile=false` (`enable_local_ai` already false) | patched |
| 17 | Brave Talk | talk.brave.com | SRC | GN `enable_brave_talk=false` | patched |
| 18 | Playlist | local + media fetch | SRC | GN `enable_playlist=false`, `enable_playlist_webui=false` | patched |
| 19 | Wayback Machine | archive.org availability API on 404 | SRC (not triggered on a 404 in baseline: needs infobar action) | GN `enable_brave_wayback_machine=false` | patched |
| 20 | Web Discovery Project | collector.wdp.brave.com, patterns.wdp.brave.com | SRC | GN `enable_web_discovery(_native)=false` | patched |
| 21 | PSST, Email Aliases, Brave Education | brave.com, account.brave.com, browser-education.brave.com | SRC | GN `enable_psst`, `enable_email_aliases`, `enable_brave_education` = false | patched |
| 22 | Adblock lists / Shields resources / HTTPS-upgrade exceptions / debounce / request-otr / URL sanitizer / NTP images | arrive as components through go-updater | OBS (the 13 POSTs) | SW `--disable-component-update`. **Trade-off: no filter lists unless imported by the user** (see 05) | patched |
| 23 | Tor client + pluggable transports | tor.bravesoftware.com via component updater | SRC | updater disabled -> Tor windows cannot fetch the client (see 05); `enable_tor` stays on for the NTP TOR signal | decision |
| 24 | Geolocation (network provider) | location.brave.com/v1/geolocate (Google behind it) | SRC | GN `brave_google_api_endpoint` .invalid; FW; macOS uses CoreLocation anyway | patched |
| 25 | Translate | translate.brave.com / translate.googleapis.com | SRC (no request on a German page) | PREF `translate.enabled=false` default; FW | patched |
| 26 | Autofill crowdsourcing | autofill.googleapis.com, www.gstatic.com/autofill | SRC (no request on github login) | SW `--disable-features=AutofillServerCommunication`; FW | patched |
| 27 | Optimization Guide / model execution | optimizationguide-pa.googleapis.com | SRC | SW feature off; no API key; FW | patched |
| 28 | Network time | clients2.google.com/time | SRC | SW feature `NetworkTimeServiceQuerying` off; FW | patched |
| 29 | Reporting API / NEL / Domain Reliability | endpoints named by visited sites; gvt1/gvt2 beacons | SRC | SW features `Reporting`, `NetworkErrorLogging` off; `--disable-domain-reliability` already baked in by Brave | patched |
| 30 | Captive portal / connectivity | connectivitycheck.gstatic.com/generate_204 | SRC (only on net errors) | FW | patched |
| 31 | GCM / FCM push | mtalk.google.com, fcm.googleapis.com | OBS log "cannot start the GCM Client" | PREF `gcm.channel_status=false` registered by Brave (`browser/gcm_driver/brave_gcm_utils.cc`); socket traffic is not covered by FW | already off |
| 32 | Component extension / CWS updates | clients2.google.com/service/update2/crx, extensionupdater.brave.com | SRC | SW `--disable-background-networking` (extension updater) ; FW | patched |
| 33 | Network prediction / preconnect / DNS prefetch | speculative to unvisited hosts | SRC | PREF `net.network_prediction_options=disabled` set by Brave (`brave_profile_prefs.cc`) | already off |
| 34 | Origin trials | local key check (`kBraveOriginTrialsPublicKey`); OT component via updater | SRC | updater off | n/a |
| 35 | Privacy Sandbox (Topics/Attribution/Protected Audience) | none to vendor | SRC | Brave disables at build/prefs; not re-verified | unverified |
| 36 | WebRTC IP handling | STUN to site-chosen servers | SRC | out of scope (fingerprint agent) | n/a |
| 37 | QUIC, DoH | chrome.cloudflare-dns.com etc. | OBS DoH | DoH is "automatic" (upgrade only to the system resolver's operator): allowlisted as transport. QUIC left on | decision |
| 38 | Spellcheck dictionaries | dict.brave.com (Linux/Win download) | SRC; macOS uses system spellchecker | none needed on macOS | n/a |
| 39 | Media Router (Cast) | local mDNS/SSDP (`_googlecast._tcp`) | SRC (Info.plist, View > Cast...) | PREF `media_router.enable_media_router=false` default | patched |
| 40 | IPFS | ipfs gateways | SRC | `deprecate_ipfs=true` already | n/a |
| 41 | Webcompat reporter ("Report a Broken Site") | webcompat.brave.com | SRC, user-initiated | GN `webcompat_report_api_endpoint` .invalid; menu item remains (deferred) | partial |
| 42 | Brave Account / OPAQUE | account.brave.com | SRC, user-initiated | GN domain -> .invalid; FW | partial |
| 43 | Remote DevTools frontend | devtools.brave.com | SRC | PATCH `chrome/browser/devtools/url_constants.cc` -> devtools.invalid | patched |
| 44 | Search-engine favicons on settings/search | google/bing/ddg/ecosia/qwant/startpage/cdn.search.brave.com | OBS | FW blocks Google/Brave ones; others still fetched when that page is opened (user-initiated, documented) | partial |
| 45 | Sparkle / Keystone updater | updates.bravesoftware.com | SRC | `enable_sparkle=false`, `enable_updater=false` already | n/a |
| 46 | Info.plist | `CrProductDirName=BraveSoftware/Brave-Browser-Development`, `_googlecast._tcp` Bonjour, Keychain item "Brave Safe Storage" | OBS | deferred: changing them would orphan the real profile's data and keychain secret | deferred |
