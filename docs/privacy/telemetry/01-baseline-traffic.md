# 01 Baseline traffic (build before hardening)

Binary: `out/auren/Auren.app` as of 2026-10-19 (Chromium 151.0.7922.47, Brave layer,
`is_official_build=false`). Capture: `--log-net-log --net-log-capture-mode=Default`,
throwaway profiles under `~/auren-audit/`. Raw summaries: `data/before/`.

## Idle, clean profile (first run), 15 min, no user action

| t | request | notes |
|---|---|---|
| 0.0 s | GET `variations.brave.com/seed?osname=mac&milestone=151` | A/B seed fetch |
| 0.0-3.7 s | 12x POST `go-updater.brave.com/extensions` | component update check (adblock, https-upgrade, etc.) |
| 2.9 s | GET `usage-ping.brave.com/1/usage/brave-core?platform=osxarm64-bc&channel=developer&version=0.7922.47&daily=true&weekly=true&monthly=true&first=true&woi=2026-10-19&dtoi=2026-10-19&ref=BRV001&braveSearch=0&googleSearch=0&otherSearch=0&staleSearch=0` | stats/referral ping: platform, channel, version, first-run flag, install date, referral code |
| 59.9 s | POST go-updater again | |
| ~230-260 s | GET `safebrowsing.brave.com/v4/threatListUpdates:fetch?$req=...` | Safe Browsing list update (on by default) |
| throughout | POST `chrome.cloudflare-dns.com/dns-query` | DoH transport: system resolver is Cloudflare, Chromium upgrades |

No request to any Google host. Same result on a second fresh-profile run (7 min) and
on a restart of an existing profile (variations + go-updater at start, go-updater
again at +15 min, SB at +4 min, usage-ping absent because the daily ping was done).

## User-action scenarios (same build)

| scenario | extra traffic found |
|---|---|
| Open `chrome://newtab` | Auren NTP *requests* `fonts.googleapis.com`, `fonts.gstatic.com`, `unpkg.com/lucide@latest` (seen in resource timing; no `URL_REQUEST_START_JOB`, so it is stopped before the network stack; the icons never rendered: 0 svg, 6 unrendered `<i>`) |
| **Type in the omnibox** (UI scenario) | **`GET search.brave.com/api/suggest?q=h`, `q=how+to+bake+sourdough+bread+`, ... one per keystroke batch.** Brave enables search suggestions by default in US and 11 other countries (`PrepareSearchSuggestionsConfig`). Privacy leak of typed text. |
| Visit `chrome://settings/search` | browser-process favicon fetches for every prepopulated engine: google.com, bing.com, duckduckgo.com, ecosia, qwant, startpage, `cdn.search.brave.com` |
| Cmd+B (side panel) | claude.ai (+ `assets-proxy.anthropic.com` 188, `s-cdn.anthropic.com`, `accounts.google.com/gsi`, hcaptcha: all initiated by claude.ai itself, expected) |
| 404 page, github.com/login, German Wikipedia (translate), google.com, news.ycombinator.com | no archive.org (Wayback), no translate, no autofill-server traffic; only the 3 startup Brave pings |
| 32 internal WebUI pages (`webui_scan.js`) | no external requests beyond the settings/search favicons; many Brave strings/links (see 04) |

## Before: unexpected destinations (browser-initiated)

| host | requests | purpose |
|---|---|---|
| go-updater.brave.com | 13 per start, +13 per 15 min cycle | Brave component updater |
| variations.brave.com | 1 per start | Brave variations seed |
| usage-ping.brave.com | 1 per day | stats / referral ping |
| safebrowsing.brave.com | 1 per ~4 min after start (then periodic) | Safe Browsing |
| search.brave.com | per keystroke | omnibox suggestions |
| (renderer) fonts.googleapis.com, fonts.gstatic.com, unpkg.com | per NTP | Auren NTP external assets |

Raw data: `data/before/summary-*.json`, `*-timeline.txt`, `webui-scan.jsonl`.

## After

See the section appended at the bottom by the verification run (pending until the
rebuild is verified).
