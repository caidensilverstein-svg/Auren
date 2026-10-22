# 03 Hardening changes (layer order, least invasive first)

Mac tree commits (local, prefix `[Auren]`): brave layer `~/brave-src/src/brave`, chromium
`~/brave-src/src`. Status of the rebuild is at the bottom.

## A. Build args (`patches/privacy/args.gn.privacy`, appended to `out/auren/args.gn`)
Original saved at `~/auren-audit/backup/args.gn.orig`. `gn gen` passes (33182 targets);
`siso -n` predicts only ~463 steps for the rebuild.
* Compiled out: stats updater, ads, rewards, wallet, news, talk, VPN (all 4 flags),
  Wayback, playlist (+webui), PSST, web discovery (+native), email aliases, Leo (+agent profile),
  brave education.
* Compiled-in endpoints pointed at `.invalid` (RFC 2606, can never resolve): stats, variations,
  sync, updater (dev/prod), Omaha `update_check_url`, safebrowsing, geolocation, webcompat and the
  three `brave_services_*_domain` (every derived `prefix.brave.com` service URL).
* Kept on purpose: `enable_tor` (NTP TOR signal), `enable_speedreader` (local), shields.

## B. Baked switches and features (`brave/app/brave_main_delegate.cc`)
`AppendAurenPrivacyOptions()` runs in `BasicStartupComplete`, so it cannot be forgotten:
`--disable-background-networking --disable-component-update --no-pings
--disable-default-apps --no-default-browser-check --disable-sync` and
`--disable-features=` (merged with any caller value) `OptimizationHints,
OptimizationGuideModelExecution, NetworkTimeServiceQuerying, AutofillServerCommunication,
InterestFeedV2, Reporting, NetworkErrorLogging`. Also removed
`variations::AppendBraveCommandLineOptions` and the component-updater `url-source`.

## C. Pref defaults (`brave/browser/brave_profile_prefs.cc`, `components/p3a/p3a_service.cc`)
`safebrowsing.enabled/enhanced=false`, `translate.enabled=false`,
`media_router.enable_media_router=false`, `brave.p3a.enabled=false`. These are *defaults*:
profiles that explicitly stored a value keep it.

## D. Source patches
| file | change |
|---|---|
| `browser/search_engines/search_engine_provider_util.cc` | suggestions never default-on (fixes keystroke leak to search.brave.com) |
| `chromium_src/components/search_engines/template_url_prepopulate_data.cc` | default engine DuckDuckGo |
| `browser/ui/startup/brave_startup_tab_provider_impl.cc` | no Brave welcome tab on first run |
| `chromium_src/components/crash/core/app/crash_reporter_client.cc` | upload URL always empty |
| `browser/ui/webui/auren_new_tab_ui.cc` (also in repo `browser/`) | no Google Fonts / unpkg; inline icons; strict CSP |
| `components/constants/url_constants.h`, 20 more files via `scripts/privacy/debrave_urls.py` | Brave help/doc links -> Auren project page; devtools.brave.com -> .invalid |
| `scripts/privacy/debrave_strings.py` | "Brave" -> "Auren" in 106 grd/grdp (4690 replacements) |

## E. Network firewall (`services/network/url_loader_factory.cc`, chromium tree)
Last line of defence for anything missed: browser-process (`process_id.is_browser()`),
non-navigation requests to `*.brave.com, bravesoftware.com, brave.software,
basicattentiontoken.org, google.com, googleapis.com, gstatic.com, gvt1/2.com,
google-analytics.com, googletagmanager.com, doubleclick.net, googlesyndication.com,
googleadservices.com, *.invalid` fail with `ERR_BLOCKED_BY_CLIENT` and log
`AUREN_FIREWALL: blocked ...`. Renderer traffic and navigations are untouched, so the user can
visit google.com/brave.com and claude.ai works. Escape hatch: `--auren-allow-service-requests`.
Caveat: `dcheck_always_on=true` in this build; the firewall completes the loader normally
(no DCHECK paths), and Chromium callers already handle `ERR_BLOCKED_BY_CLIENT`.

## Status

* **2026-10-22: built and measured on the Mac** (dev build, `out/auren`). The earlier blocker (Mac offline) is gone.
  * Clean idle capture, fresh profile, one browser: `netlog_audit.py` exits 0; the only host contacted is `chrome.cloudflare-dns.com`
    (DNS-over-HTTPS, allow-listed). The unhardened 15-minute capture contacted `go-updater.brave.com` (13 requests),
    `safebrowsing.brave.com`, `usage-ping.brave.com` and `variations.brave.com`.
  * **A blocked request never reaches the netlog**, so a clean netlog is the source-level gating plus the firewall together. The firewall
    log (`AUREN_FIREWALL: blocked browser-process request to ...`) is the other half: opening the search-engine settings page and a fresh
    profile's startup produced three attempts, all blocked: `www.google.com`, `cdn.search.brave.com` and `update.googleapis.com`
    (the source of the last one is not identified; the log now carries the request path and Google update app id to find it).
  * The firewall's documented escape hatch (`--auren-allow-service-requests`) never worked from the command line: the network service is a
    separate process and does not receive custom switches. `patches/privacy/apply_firewall_strict.py` makes it (and a new opt-in strict
    mode) also read `AUREN_ALLOW_SERVICE_REQUESTS` / `AUREN_FIREWALL_STRICT` from the environment, which child processes inherit.
  * The protection data the hardening had silently removed (filter lists, debounce, URL cleaning) is restored from inside the app: see `docs/privacy/protections.md`.
  * Compiled-in vendor surface is not removed: `scripts/privacy/zero_brave.py` still finds hundreds of vendor host strings in the build
    (mostly in disabled features and help links); they are unreachable at run time (compiled to `.invalid`, firewalled), not deleted.
* Still open: UI-scenario and page-scenario captures (`after-ui`, `after-pages`), `WEBUI_SCAN`, side-panel claude.ai check.
