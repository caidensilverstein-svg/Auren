#!/usr/bin/env python3
"""Count vendor (Brave / Google / BAT) service hosts that are still present as literal strings in a built app.

usage: zero_brave.py PATH [PATH ...] [--json out.json] [--baseline before.json] [--top 40]
       (a PATH is the .app, a directory, or files such as out/auren/*.dylib: a component build keeps its code outside the .app)

A host string in a binary is not proof the browser can reach it (that is what the network firewall in
patches/privacy/0001-network-firewall.patch and the netlog audit in scripts/telemetry-audit decide); this scanner
answers a different question: how much vendor surface is still compiled in. Run it before and after a change and
diff with --baseline; the goal is for the number to go down and for what remains to be explained.

Scans every regular file under the app (executables, dylibs, .pak, WebUI bundles, plists), never follows symlinks.
Hosts that end in .invalid are reported separately: they are the compiled-to-unresolvable replacements.
"""
import argparse
import json
import mmap
import os
import re
import sys
from collections import defaultdict

VENDOR = (
    r"brave\.com", r"bravesoftware\.com", r"brave\.software", r"basicattentiontoken\.org", r"bsg\.brave\.com",
    r"google\.com", r"googleapis\.com", r"gstatic\.com", r"gvt1\.com", r"gvt2\.com", r"googleusercontent\.com",
    r"google-analytics\.com", r"googletagmanager\.com", r"doubleclick\.net", r"googlesyndication\.com",
    r"googleadservices\.com", r"cloudfront\.net", r"cloudflare-dns\.com",
)
HOST_RE = re.compile(rb"(?<![A-Za-z0-9.-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){0,6}(?:%s))(?![A-Za-z0-9-])"
                     % b"|".join(v.encode() for v in VENDOR))
INVALID_RE = re.compile(rb"(?<![A-Za-z0-9.-])((?:[A-Za-z0-9-]{1,63}\.){1,5}invalid)(?![A-Za-z0-9-])")


def scan_file(path, vendor, invalid):
    try:
        if os.path.getsize(path) == 0:
            return
        with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as m:
            for hit in HOST_RE.finditer(m):
                vendor[hit.group(1).decode("ascii", "replace").lower()][path] += 1
            for hit in INVALID_RE.finditer(m):
                invalid[hit.group(1).decode("ascii", "replace").lower()][path] += 1
    except (OSError, ValueError):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--baseline")
    ap.add_argument("--top", type=int, default=40)
    a = ap.parse_args()

    vendor, invalid = defaultdict(lambda: defaultdict(int)), defaultdict(lambda: defaultdict(int))
    nfiles = 0
    for root in a.paths:
        if os.path.isfile(root) and not os.path.islink(root):
            nfiles += 1
            scan_file(root, vendor, invalid)
            continue
        for d, _dirs, files in os.walk(root, followlinks=False):
            for n in files:
                p = os.path.join(d, n)
                if os.path.islink(p) or not os.path.isfile(p):
                    continue
                nfiles += 1
                scan_file(p, vendor, invalid)

    def total(h):
        return sum(h.values())
    by_family = defaultdict(int)
    for host, files in vendor.items():
        fam = next(v.replace("\\", "") for v in VENDOR if re.search(v + "$", host))
        by_family[fam] += 1
    report = {
        "paths": a.paths, "files_scanned": nfiles,
        "vendor_hosts": {h: {"occurrences": total(f), "files": len(f)} for h, f in sorted(vendor.items())},
        "invalid_hosts": {h: {"occurrences": total(f), "files": len(f)} for h, f in sorted(invalid.items())},
        "distinct_vendor_hosts": len(vendor), "distinct_invalid_hosts": len(invalid),
        "vendor_hosts_by_family": dict(sorted(by_family.items(), key=lambda kv: -kv[1])),
    }
    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=1, sort_keys=True)

    print(f"scanned {nfiles} files in {len(a.paths)} path(s)")
    print(f"distinct vendor host strings: {len(vendor)}   (compiled-to-.invalid hosts: {len(invalid)})")
    for fam, n in report["vendor_hosts_by_family"].items():
        print(f"  {fam:28s} {n}")
    print(f"top {a.top} by occurrences:")
    for h, v in sorted(report["vendor_hosts"].items(), key=lambda kv: -kv[1]["occurrences"])[: a.top]:
        print(f"  {v['occurrences']:6d} in {v['files']:3d} files  {h}")
    if a.baseline:
        with open(a.baseline) as f:
            base = json.load(f)
        gone = sorted(set(base["vendor_hosts"]) - set(report["vendor_hosts"]))
        new = sorted(set(report["vendor_hosts"]) - set(base["vendor_hosts"]))
        print(f"vs baseline: {base['distinct_vendor_hosts']} -> {report['distinct_vendor_hosts']} distinct hosts; "
              f"{len(gone)} gone, {len(new)} new")
        for h in new[:20]:
            print("  NEW ", h)
    return 0


if __name__ == "__main__":
    sys.exit(main())
