#!/usr/bin/env python3
"""Point Brave help/marketing/doc links in C++ sources at the Auren project page.

Rewrites string literals (including adjacent-literal concatenations) whose URL
host is one of: support.brave.app, community.brave.app, brave.com, www.brave.com,
github.com/brave/... Functional service hosts (search.*, account.*, *.wallet.*,
ads, rewards...) are NOT touched here - those are removed/disabled by build
flags and the network firewall. devtools.brave.com becomes a non-resolvable
.invalid host.

usage: debrave_urls.py SRC_ROOT [--apply]   (SRC_ROOT = .../src ; scans brave/ + chrome/)
"""
import os, re, sys
root = sys.argv[1]
apply_ = '--apply' in sys.argv
PROJECT = 'https://github.com/caidensilverstein-svg/Auren'
HELP = re.compile(r'(u8|u|L)?"https?://(?:support\.brave\.app|community\.brave\.app|www\.brave\.com|brave\.com|github\.com/brave)(?:[/#?][^"]*)?"(?:\s*(?:u8|u|L)?"[^"\n]*")*')
DEV = re.compile(r'"https://devtools\.brave\.com/"')
dirs = ['brave/chromium_src', 'brave/browser', 'brave/components', 'brave/app', 'brave/common', 'brave/renderer', 'brave/utility']
skip = ('/test/', '_test.', 'browsertest', 'unittest', 'node_modules', '/android/', '/ios/', 'brave_wallet', 'brave_rewards', 'brave_ads', 'ai_chat', 'brave_vpn', 'brave_news', 'brave_talk', 'playlist', 'web_discovery', 'brave_origin', 'psst', 'email_aliases')
tot = 0
for d in dirs:
    for dp, dn, fn in os.walk(os.path.join(root, d)):
        dn[:] = [x for x in dn if x != 'node_modules']
        for f in fn:
            if not f.endswith(('.cc', '.h', '.mm')):
                continue
            p = os.path.join(dp, f)
            if any(s in p for s in skip):
                continue
            t = open(p, encoding='utf-8', errors='ignore').read()
            def sub(m):
                return (m.group(1) or '') + '"' + PROJECT + '"'
            new = HELP.sub(sub, t)
            new = DEV.sub('"https://devtools.invalid/"', new)
            if new != t:
                n = len(HELP.findall(t)) + len(DEV.findall(t))
                tot += n
                print('%3d %s' % (n, os.path.relpath(p, root)))
                if apply_:
                    open(p, 'w', encoding='utf-8').write(new)
print('total literals:', tot, 'APPLIED' if apply_ else 'dry-run')
