#!/usr/bin/env python3
"""Parse a Chromium netlog (--log-net-log) and report every destination.

Outputs, per unique destination host: URL request count, DNS lookups,
socket/session events, source types, sample URLs/initiators and a
classification (google / brave / allowlisted / loopback / other).
Exits 1 when any host is neither allowlisted nor loopback, so it can be
used as a CI gate.  Exit 2 on unreadable input.

Usage:
  netlog_audit.py NETLOG [NETLOG...] [--allowlist FILE] [--allow-host H ...]
                  [--json OUT] [--markdown OUT] [--baseline OLD.json]
"""
import argparse, collections, fnmatch, json, re, sys
from urllib.parse import urlsplit

GOOGLE = ("google.com", "googleapis.com", "gstatic.com", "googleusercontent.com",
          "gvt1.com", "gvt2.com", "ggpht.com", "youtube.com", "doubleclick.net",
          "googlesyndication.com", "google-analytics.com", "googletagmanager.com",
          "chromium.org", "chrome.com", "withgoogle.com", "googleadservices.com",
          "1e100.net")
BRAVE = ("brave.com", "bravesoftware.com", "brave.software", "bravesoftware.net",
         "bravesync.com", "basicattentiontoken.org", "bsg.brave.com", "bat.brave.com")

def load(path):
    raw = open(path, "rb").read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Netlog written by a killed browser is truncated: salvage events.
        i = raw.rfind("},\n")
        if i < 0:
            i = raw.rfind("}")
            if i < 0:
                raise
            return json.loads(raw[:i + 1] + "]}")
        return json.loads(raw[:i + 1] + "]}")

def host_of(url):
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""

def split_hostport(s):
    s = s.strip()
    if "://" in s:
        s = s.split("://", 1)[1]
    s = s.split("/", 1)[0]
    if s.startswith("["):
        return s[1:s.find("]")].lower()
    if s.count(":") == 1:
        return s.rsplit(":", 1)[0].lower()
    return s.lower()

def is_ip(h):
    return bool(re.fullmatch(r"[0-9.]+|[0-9a-f:]+", h)) and (h.count(".") == 3 or ":" in h)

def is_loopback(h):
    return h in ("localhost", "") or h.startswith("127.") or h in ("::1",) or h.endswith(".localhost") or h.endswith(".local")

def suffix_match(h, suffixes):
    return any(h == s or h.endswith("." + s) for s in suffixes)

def load_allowlist(path, extra):
    pats = list(extra)
    if path:
        for line in open(path):
            line = line.split("#", 1)[0].strip()
            if line:
                pats.append(line.lower())
    return pats

def allowed(h, pats):
    return any(fnmatch.fnmatch(h, p) or h == p for p in pats)

def classify(h, pats):
    if is_loopback(h):
        return "loopback"
    if allowed(h, pats):
        return "allowlisted"
    if suffix_match(h, BRAVE):
        return "brave"
    if suffix_match(h, GOOGLE):
        return "google"
    if is_ip(h):
        return "ip-only"
    return "other"

def timeline(path):
    """Yield (seconds since first event, method, url) for each URL request."""
    d = load(path)
    et = {v: k for k, v in d.get("constants", {}).get("logEventTypes", {}).items()}
    evs = d.get("events", [])
    if not evs:
        return
    t0 = int(evs[0]["time"])
    for e in evs:
        if et.get(e.get("type")) == "URL_REQUEST_START_JOB" and "url" in (e.get("params") or {}):
            p = e["params"]
            yield (int(e["time"]) - t0) / 1000.0, p.get("method", "?"), p["url"].split("?")[0]

def analyze(path, pats):
    d = load(path)
    c = d.get("constants", {})
    et = {v: k for k, v in c.get("logEventTypes", {}).items()}
    st = {v: k for k, v in c.get("logSourceType", {}).items()}
    hosts = collections.defaultdict(lambda: {
        "url_requests": 0, "dns": 0, "sessions": 0, "source_types": collections.Counter(),
        "urls": collections.Counter(), "initiators": collections.Counter(),
        "init_hosts": collections.Counter()})
    srcinfo = {}
    for e in d.get("events", []):
        t = et.get(e.get("type"), "")
        p = e.get("params") or {}
        stype = st.get(e.get("source", {}).get("type"), "?")
        if t == "URL_REQUEST_START_JOB" and "url" in p:
            h = host_of(p["url"])
            if not h:
                continue
            r = hosts[h]
            r["url_requests"] += 1
            r["source_types"][stype] += 1
            u = p["url"].split("?")[0][:160]
            r["urls"][u] += 1
            r["initiators"][p.get("initiator", "-")] += 1
            ih = host_of(p.get("initiator", ""))
            r["init_hosts"][ih or "<browser>"] += 1
        elif t in ("HOST_RESOLVER_MANAGER_REQUEST", "HOST_RESOLVER_MANAGER_JOB") \
                and e.get("phase") == 1 and "host" in p:
            h = split_hostport(p["host"]) if isinstance(p["host"], str) else ""
            if h:
                hosts[h]["dns"] += 1
                hosts[h]["source_types"][stype] += 1
        elif t == "DNS_TRANSACTION" and e.get("phase") == 1 and isinstance(p.get("hostname"), str):
            hosts[split_hostport(p["hostname"])]["dns"] += 1
        elif t in ("HTTP2_SESSION", "QUIC_SESSION", "SSL_CONNECT") and e.get("phase") == 1:
            h = split_hostport(p.get("host", "")) if isinstance(p.get("host"), str) else ""
            if h:
                hosts[h]["sessions"] += 1
        elif t in ("TCP_CONNECT",) and e.get("phase") == 1 and "address" in p:
            h = split_hostport(p["address"])
            hosts[h]["sessions"] += 1
            hosts[h]["source_types"]["TCP_CONNECT(ip)"] += 1
    out = {}
    for h, r in hosts.items():
        out[h] = {
            "class": classify(h, pats),
            "url_requests": r["url_requests"], "dns": r["dns"], "sessions": r["sessions"],
            "source_types": dict(r["source_types"]),
            "sample_urls": [u for u, _ in r["urls"].most_common(5)],
            "initiators": dict(r["initiators"].most_common(3)),
            "init_hosts": dict(r["init_hosts"]),
        }
    return out

def merge(results):
    m = {}
    for r in results:
        for h, v in r.items():
            if h not in m:
                m[h] = json.loads(json.dumps(v))
            else:
                for k in ("url_requests", "dns", "sessions"):
                    m[h][k] += v[k]
                for ih, n in v.get("init_hosts", {}).items():
                    m[h].setdefault("init_hosts", {})
                    m[h]["init_hosts"][ih] = m[h]["init_hosts"].get(ih, 0) + n
    return m

def mark_page_requested(res, pats):
    """A host is 'page-requested' when every URL request to it was initiated by
    an allowlisted host (e.g. claude.ai side panel, a page the user opened) or
    by another page-requested host (iframes, CDNs). Browser-initiated requests
    ('<browser>') never qualify unless the host itself is allowlisted."""
    good = {h for h, v in res.items() if v["class"] in ("allowlisted", "loopback")}
    changed = True
    while changed:
        changed = False
        for h, v in res.items():
            if h in good:
                continue
            ih = v.get("init_hosts") or {}
            if v["url_requests"] and ih and all(i in good for i in ih):
                v["class"] = "page-requested"
                good.add(h)
                changed = True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("netlogs", nargs="+")
    ap.add_argument("--allowlist")
    ap.add_argument("--allow-host", action="append", default=[], help="user-navigated host (fnmatch)")
    ap.add_argument("--json")
    ap.add_argument("--markdown")
    ap.add_argument("--baseline", help="previous --json output to diff against")
    ap.add_argument("--timeline", action="store_true", help="print every URL request with its time offset")
    ap.add_argument("--ignore-ip-only", action="store_true",
                    help="do not fail on bare-IP TCP connects (name unknown)")
    a = ap.parse_args()
    pats = load_allowlist(a.allowlist, [x.lower() for x in a.allow_host])
    a.pats = pats
    try:
        res = merge([analyze(p, pats) for p in a.netlogs])
    except Exception as ex:
        print("cannot read netlog: %s" % ex, file=sys.stderr)
        return 2
    if a.timeline:
        for p in a.netlogs:
            print("== timeline", p)
            for t, m, u in timeline(p):
                print("%8.1fs %-5s %s" % (t, m, u))
    mark_page_requested(res, pats)
    rows = sorted(res.items(), key=lambda kv: (kv[1]["class"], -kv[1]["url_requests"], kv[0]))
    lines = ["| host | class | url_req | dns | sess | sample URL |", "|---|---|---|---|---|---|"]
    for h, v in rows:
        lines.append("| %s | %s | %d | %d | %d | %s |" % (
            h, v["class"], v["url_requests"], v["dns"], v["sessions"],
            (v["sample_urls"] or ["-"])[0]))
    table = "\n".join(lines)
    print(table)
    bad = [h for h, v in res.items() if v["class"] in ("google", "brave", "other", "browser-initiated")
           or (v["class"] == "ip-only" and not a.ignore_ip_only)]
    if a.baseline:
        old = json.load(open(a.baseline))
        gone = sorted(set(old) - set(res)); new = sorted(set(res) - set(old))
        print("\nvs baseline: removed=%d new=%d" % (len(gone), len(new)))
        for h in gone: print("  - %s (was %s, %d req)" % (h, old[h]["class"], old[h]["url_requests"]))
        for h in new: print("  + %s (%s)" % (h, res[h]["class"]))
    if a.json: json.dump(res, open(a.json, "w"), indent=1, sort_keys=True)
    if a.markdown: open(a.markdown, "w").write(table + "\n")
    print("\nUNEXPECTED hosts: %d" % len(bad))
    for h in sorted(bad): print("  !", res[h]["class"], h, res[h]["url_requests"])
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
