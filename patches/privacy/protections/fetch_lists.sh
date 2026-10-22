#!/bin/bash
# Fetch the filter lists that are bundled into Auren (the browser never downloads them) and pin them.
#   fetch_lists.sh update   re-download everything and rewrite manifest.json (a deliberate, reviewed act)
#   fetch_lists.sh verify   check lists/ against manifest.json (apply.py runs this first)
set -euo pipefail
cd "$(dirname "$0")"
B=https://ublockorigin.github.io/uAssetsCDN/filters
SRC="easylist.txt|https://easylist.to/easylist/easylist.txt|EasyList|GPL-3.0-or-later OR CC-BY-SA-3.0
easyprivacy.txt|https://easylist.to/easylist/easyprivacy.txt|EasyPrivacy|GPL-3.0-or-later OR CC-BY-SA-3.0
easylist-cookie.txt|https://secure.fanboy.co.nz/fanboy-cookiemonster.txt|Fanboy Cookie List|GPL-3.0-or-later OR CC-BY-3.0
ublock-filters.txt|$B/filters.min.txt|uBlock filters|GPL-3.0-or-later
ublock-privacy.txt|$B/privacy.min.txt|uBlock filters - Privacy|GPL-3.0-or-later
ublock-unbreak.txt|$B/unbreak.min.txt|uBlock filters - Unbreak|GPL-3.0-or-later
ublock-badware.txt|$B/badware.min.txt|uBlock filters - Badware risks|GPL-3.0-or-later
brave-unbreak.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt|Brave Unbreak|MPL-2.0
peterlowe-hosts.txt|https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext|Peter Lowe's ad server list|free use
brave-specific.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt|Brave specific|MPL-2.0
brave-firstparty.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt|Brave first-party|MPL-2.0
brave-firstparty-cname.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty-cname.txt|Brave first-party CNAME|MPL-2.0
brave-social.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-social.txt|Brave social|MPL-2.0
brave-sugarcoat.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-sugarcoat.txt|Brave sugarcoat|MPL-2.0
brave-cookie-specific.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-cookie-specific.txt|Brave cookie specific|MPL-2.0
brave-checks.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-checks.txt|Brave checks|MPL-2.0
brave-pageview.txt|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-pageview.txt|Brave pageview|MPL-2.0
debounce.json|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/debounce.json|Debounce rules (redirect trackers)|MPL-2.0
clean-urls.json|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/clean-urls.json|Clean URLs (tracking parameters)|MPL-2.0
clean-urls-permissions.json|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/clean-urls-permissions.json|Clean URLs permissions|MPL-2.0
query-filter.json|https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/query-filter.json|Query filter|MPL-2.0"
case "${1:-verify}" in
update)
  mkdir -p lists
  python3 - "$SRC" <<'PY'
import hashlib, json, subprocess, sys, datetime
out = []
for line in sys.argv[1].splitlines():
    f, url, title, lic = line.split("|")
    subprocess.run(["curl", "-sfL", "-m", "180", "-o", "lists/" + f, url], check=True)
    data = open("lists/" + f, "rb").read()
    out.append({"file": f, "kind": "data" if f.endswith(".json") else "list", "url": url, "title": title, "license": lic, "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest()})
json.dump({"fetched": datetime.date.today().isoformat(), "lists": out}, open("manifest.json", "w"), indent=1)
print("pinned", len(out), "lists,", sum(o["bytes"] for o in out), "bytes")
PY
  ;;
verify)
  python3 - <<'PY'
import hashlib, json, sys
m = json.load(open("manifest.json"))
bad = [o["file"] for o in m["lists"] if hashlib.sha256(open("lists/" + o["file"], "rb").read()).hexdigest() != o["sha256"]]
if bad:
    sys.exit("hash mismatch: " + ", ".join(bad))
print("ok:", len(m["lists"]), "lists match manifest.json (fetched", m["fetched"] + ")")
PY
  ;;
*) echo "usage: $0 update|verify" >&2; exit 2;;
esac
