#!/usr/bin/env python3
"""Scan a source tree for hardcoded endpoint hosts (source audit helper).

usage: scan_hosts.py ROOT 'brave\\.com|bravesoftware\\.com' [max-files-shown]
Skips tests, node_modules, out/, .git.  third_party is skipped unless the
path is under a brave/ tree.
"""
import os, re, sys, collections
root, suf = sys.argv[1], sys.argv[2]
mx = int(sys.argv[3]) if len(sys.argv) > 3 else 3
rx = re.compile(r'((?:[a-z0-9-]+\.)+(?:%s))\b' % suf, re.I)
exts = ('.cc', '.h', '.mm', '.gn', '.gni', '.py', '.ts', '.tsx', '.js', '.json', '.grd', '.grdp', '.plist', '.m', '.mojom', '.html', '.xtb')
skip = ('/test', 'unittest', 'browsertest', '_test.', 'test_', '/tools/', '/docs/', '/testing/', '/web_tests/')
hosts = collections.defaultdict(set)
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in ('node_modules', '.git', 'out', 'build', 'v8', 'ios', 'android')]
    for f in fn:
        if not f.endswith(exts):
            continue
        p = os.path.join(dp, f)
        if any(s in p for s in skip):
            continue
        try:
            t = open(p, errors='ignore').read()
        except Exception:
            continue
        for m in rx.finditer(t):
            hosts[m.group(1).lower()].add(os.path.relpath(p, root))
for h, fs in sorted(hosts.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    fl = sorted(fs)
    print('%s (%d): %s' % (h, len(fl), ', '.join(fl[:mx])))
