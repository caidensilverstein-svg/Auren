# Protections that ship inside the app (2026-10-22)

## The problem this solves

The privacy hardening (`patches/privacy`, `docs/privacy/telemetry`) turned the component updater off, so Auren no longer phones Brave's
update server. But Brave delivers most of its *protection data* as components, so the same switch also emptied the protections:
the ad and tracker filter lists, the redirect-tracker (debounce) rules, the URL tracking-parameter rules, the cookie-notice lists.
(`05-decisions-and-tradeoffs.md` item 1 recorded this as a known trade-off; it was never closed.)

Now the data is **pinned in this repo and embedded in the binary**. The browser downloads nothing; updating a list is a reviewed change.

## What is bundled

17 filter lists and 4 data files, 7,986,453 bytes, fetched 2026-10-21 (`patches/privacy/protections/manifest.json`, sha256 per file):

| file | title | kind | bytes | license | sha256 |
|---|---|---|---:|---|---|
| `easylist.txt` | EasyList | list | 2,218,562 | GPL-3.0-or-later OR CC-BY-SA-3.0 | `85da2a3a111e` |
| `easyprivacy.txt` | EasyPrivacy | list | 1,510,806 | GPL-3.0-or-later OR CC-BY-SA-3.0 | `c8e3a8e23e68` |
| `easylist-cookie.txt` | Fanboy Cookie List | list | 902,973 | GPL-3.0-or-later OR CC-BY-3.0 | `a9f0138427d9` |
| `ublock-filters.txt` | uBlock filters | list | 1,934,538 | GPL-3.0-or-later | `76e9848810ae` |
| `ublock-privacy.txt` | uBlock filters - Privacy | list | 139,714 | GPL-3.0-or-later | `da578c3a916e` |
| `ublock-unbreak.txt` | uBlock filters - Unbreak | list | 177,935 | GPL-3.0-or-later | `193eb1e3079a` |
| `ublock-badware.txt` | uBlock filters - Badware risks | list | 167,430 | GPL-3.0-or-later | `99981b410d56` |
| `brave-unbreak.txt` | Brave Unbreak | list | 121,930 | MPL-2.0 | `57c08f868a2a` |
| `peterlowe-hosts.txt` | Peter Lowe's ad server list | list | 70,694 | free use | `9779ab30f298` |
| `brave-specific.txt` | Brave specific | list | 10,831 | MPL-2.0 | `f2fa61e97213` |
| `brave-firstparty.txt` | Brave first-party | list | 220,668 | MPL-2.0 | `5c4b55471c06` |
| `brave-firstparty-cname.txt` | Brave first-party CNAME | list | 428,475 | MPL-2.0 | `62686ce87527` |
| `brave-social.txt` | Brave social | list | 1,272 | MPL-2.0 | `b4a5abdf0388` |
| `brave-sugarcoat.txt` | Brave sugarcoat | list | 385 | MPL-2.0 | `1fa064de6651` |
| `brave-cookie-specific.txt` | Brave cookie specific | list | 24,669 | MPL-2.0 | `bf1c3fa19ed1` |
| `brave-checks.txt` | Brave checks | list | 4,552 | MPL-2.0 | `ee6361b9c995` |
| `brave-pageview.txt` | Brave pageview | list | 4,577 | MPL-2.0 | `52a0b2ad424b` |
| `debounce.json` | Debounce rules (redirect trackers) | data | 12,930 | MPL-2.0 | `fb2396985a78` |
| `clean-urls.json` | Clean URLs (tracking parameters) | data | 30,763 | MPL-2.0 | `c2664e019673` |
| `clean-urls-permissions.json` | Clean URLs permissions | data | 333 | MPL-2.0 | `ae19d4b67e32` |
| `query-filter.json` | Query filter | data | 2,416 | MPL-2.0 | `c16168bb98ea` |

Update: `patches/privacy/protections/fetch_lists.sh update` (re-downloads, rewrites the manifest), review the diff, rebuild.
`fetch_lists.sh verify` checks the files against the manifest and is run by `apply.py` first.

**License note (for you to decide, nothing is distributed yet):** EasyList, EasyPrivacy and the uBlock lists are GPL-3.0-or-later (EasyList and the
Fanboy list are also CC BY-SA / CC BY); Brave's lists are MPL-2.0. Shipping them inside a binary that other people receive brings the
obligations of those licenses (attribution, source offer). Keeping the app private avoids that; a public release needs a license review.

## How it is wired (brave-core v1.94.97)

`patches/privacy/protections/apply.py <brave-tree>` is idempotent, asserts every anchor matches exactly once, and regenerates the resource block on every run.

| piece | change |
|---|---|
| resources | one gzip `BINDATA` include per file in `components/resources/brave_components_resources.grd` (`IDR_AUREN_LIST_*`, `IDR_AUREN_DATA_*`) |
| filter lists | new `AdBlockBundledFiltersProvider` (modelled on Brave's localhost provider) feeds every bundled list to the default adblock engine; registered in `AdBlockService` |
| debounce | `DebounceComponentInstaller` ctor loads `debounce.json` through the same parser the component path uses |
| URL cleaning | `URLSanitizerComponentInstaller` ctor builds the `RawConfig` from `clean-urls.json` + permissions |
| query filter | `QueryFilterData` ctor (the singleton every request consults) loads `query-filter.json`; `RegisterQueryFilterComponent` loads it too |

## Measured in the running browser (same Mac, 2026-10-22)

* Startup log: `AUREN_PROTECTIONS: loaded 17 bundled filter lists`.
* **Blocking** (`scripts/privacy/protections_check.js`, 12 real pages): 75 of 953 requests blocked with the first 9 lists (2 runs, medians), 70 of 848 with all 17 (1 run).
  Stock Chrome on the same list: 0 blocked of 2,062 requests (`scripts/perf/run.js pageload`). Examples: forbes.com 22 of 155, imdb.com 13 of 91, bbc.com/news 13 of 105.
  Live pages change between runs and blocked trackers stop loading what they would have loaded, so the request totals are not a clean A/B; the blocked counts are.
* **Debounce** (`scripts/privacy/url_rules_check.js`): 4 of 4 redirect-tracker links (`t.cfjump.com`, `r.bttn.io`, `trk.pmsrv.co`, `redir.tradedoubler.com`) went straight to their target.
* **Query filter**: see `docs/privacy/STATUS.md` for the final state of the tracking-parameter check.

## Not covered / known limits

* Scriptlet and redirect *resources* (a separate Brave component) are not bundled, so rules that inject scriptlets or substitute resources are inert. Network blocking and element hiding rules work.
* Not bundled: `https-upgrade-exceptions-list`, `request-otr.json`, `webcompat-exceptions.json`, `localhost-permission-allow-list`. HTTPS upgrade still works; its exception list is empty, so a few sites that break under upgrade will not be exempted.
* Lists age. There is no update path by design; refresh them when you refresh the tag.
* More blocking means occasional breakage. Brave Unbreak and uBlock Unbreak are included to limit it; Shields can still be lowered per site.
