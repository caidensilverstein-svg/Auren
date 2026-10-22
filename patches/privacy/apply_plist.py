#!/usr/bin/env python3
"""Drop the Google Cast Bonjour declaration from the app's Info.plist template.

usage: apply_plist.py /path/to/chromium/src      (e.g. ~/brave-src/src)

chrome/app/app-Info.plist declares NSBonjourServices = [_googlecast._tcp] so that Cast device discovery works. Auren keeps
the media router off (media_router.enable_media_router=false, patches/privacy 03-hardening-changes.md), so the declaration only
advertises a Google service in the bundle and can trigger the macOS "local network" permission prompt. Idempotent.
CrProductDirName (the profile directory) is deliberately left alone: renaming it orphans the real profile's data and keychain
secret (docs/privacy/telemetry/05-decisions-and-tradeoffs.md item 7).
"""
import os
import sys

p = os.path.join(sys.argv[1], "chrome/app/app-Info.plist")
s = open(p).read()
block = """\t<key>NSBonjourServices</key>
\t<array>
\t\t<string>_googlecast._tcp</string>
\t</array>
"""
if block not in s:
    print("skip   NSBonjourServices already removed" if "_googlecast._tcp" not in s else "ERROR: plist block changed shape")
    sys.exit(0 if "_googlecast._tcp" not in s else 1)
assert s.count(block) == 1
open(p, "w").write(s.replace(block, ""))
print("edited chrome/app/app-Info.plist: removed NSBonjourServices (_googlecast._tcp)")
