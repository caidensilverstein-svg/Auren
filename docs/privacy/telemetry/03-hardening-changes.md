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
* Pushed: all scripts, `patches/privacy/args.gn.privacy`, docs, baseline data.
* **BLOCKER (2026-10-20 ~09:55 EDT): the Mac node went `down` in `get_scos_health`
  (wg=false, cf=false) while the Mac-tree edits were being committed.** Consequences:
  - The edits listed in section D/E/B/C were applied to the working tree (they were
    written and diffed successfully) but the `[Auren]` commits in `brave/` and `src/`
    and the export of `patches/privacy/*.patch` could not be confirmed; the `out/auren/args.gn`
    already contains the privacy block (backup in `~/auren-audit/backup/`), `gn gen` passed.
  - **The rebuild and after-hardening capture have NOT been run.** Nothing in section
    "patched" of 02 is verified at runtime yet.
* Next steps once the Mac is back: (1) `git -C ~/brave-src/src/brave status` and commit the
  listed files (message prefix `[Auren]`), same for `services/network/url_loader_factory.cc`
  in `~/brave-src/src`; (2) `autoninja -C out/auren chrome` (about 463 steps expected);
  (3) `run_capture.sh after-idle 900 --fresh`, `after-ui` with `UI_SCENARIO=1`,
  `after-pages` with SCENARIO_URLS, `WEBUI_SCAN=1`; run `netlog_audit.py` (must exit 0 with
  claude.ai + chosen hosts allowlisted) and `compare_runs.py before=... after=...`;
  (4) confirm CDP on 9224, side panel loads claude.ai, NTP bar renders icons.
