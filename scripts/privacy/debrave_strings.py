#!/usr/bin/env python3
"""De-brand English UI strings in the Brave layer of the Auren build tree.

Replaces the product word "Brave" with "Auren" in message text of the .grd /
.grdp string tables under brave/ (desktop only; android/ios/origin skipped) and
rewrites Brave-hosted help/marketing URLs inside those tables to the Auren
project page. Idempotent: running it twice changes nothing the second time.
IDs (IDS_*), file names, lower-case hosts and code identifiers are untouched.

usage: debrave_strings.py BRAVE_DIR [--apply]
"""
import os, re, sys

root = sys.argv[1]
apply_ = '--apply' in sys.argv
PROJECT_URL = 'https://github.com/caidensilverstein-svg/Auren'

SKIP_PARTS = ('/android/', '/ios/', 'brave_origin', 'node_modules', '/test/', '/third_party/', '/vendor/')
URL_RE = re.compile(r'https?://(?:[a-z0-9-]+\.)*(?:brave\.com|brave\.app|bravesoftware\.com|brave\.software)(?:/[^\s"\'<>)]*)?', re.I)

def rebrand(text):
    text = re.sub(r'\b([Aa]) Brave\b', lambda m: ('An' if m.group(1) == 'A' else 'an') + ' Auren', text)
    text = re.sub(r'\bBrave\b', 'Auren', text)
    return text

def rewrite_urls(text):
    # Only in character data / attribute values of the string tables.
    return URL_RE.sub(PROJECT_URL, text)

total = {'files': 0, 'brand': 0, 'urls': 0}
for dp, dn, fn in os.walk(root):
    if any(s in dp + '/' for s in SKIP_PARTS):
        dn[:] = []
        continue
    for f in fn:
        if not (f.endswith('.grd') or f.endswith('.grdp')):
            continue
        p = os.path.join(dp, f)
        if any(s in p for s in SKIP_PARTS):
            continue
        t = open(p, encoding='utf-8').read()
        n1 = len(re.findall(r'\bBrave\b', t))
        n2 = len(URL_RE.findall(t))
        if not (n1 or n2):
            continue
        new = rewrite_urls(rebrand(t))
        if new != t:
            total['files'] += 1
            total['brand'] += n1
            total['urls'] += n2
            print('%5d brand %4d url  %s' % (n1, n2, os.path.relpath(p, root)))
            if apply_:
                open(p, 'w', encoding='utf-8').write(new)
print(total, 'APPLIED' if apply_ else 'dry-run')
