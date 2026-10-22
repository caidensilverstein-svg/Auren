#!/usr/bin/env python3
"""Add an opt-in default-deny mode to the network firewall of patches/privacy/0001-network-firewall.patch.

usage: apply_firewall_strict.py /path/to/chromium/src      (the Chromium tree, e.g. ~/brave-src/src; run after 0001)

With --auren-firewall-strict every browser-process, non-navigation http(s)/ws(s) request except to loopback fails with
ERR_BLOCKED_BY_CLIENT and logs "AUREN_FIREWALL_STRICT: would block <host> (destination N)". It is OFF unless the switch is
given: the default stays the vendor deny-list, because a blanket default-deny is expected to break favicons, extension
installs and some downloads. Run captures with the switch to list exactly which legitimate browser-process fetches exist,
then decide an allow-list (docs/privacy/telemetry/05-decisions-and-tradeoffs.md item 4).
Idempotent; every anchor must match exactly once.
"""
import os
import sys

root = sys.argv[1]
p = os.path.join(root, "services/network/url_loader_factory.cc")
s = open(p).read()


def edit(old, new, marker):
    global s
    if marker in s:
        print("skip  ", marker[:60])
        return
    assert s.count(old) == 1, (old[:60], s.count(old))
    s = s.replace(old, new)
    print("edited", marker[:60])


edit('#include "net/base/net_errors.h"\n',
     '#include "net/base/net_errors.h"\n#include "net/base/url_util.h"\n',
     marker='#include "net/base/url_util.h"')
edit('''  if (allow) {
    return false;
  }
  return IsAurenBlockedServiceHost(request.url.host());
}''',
     '''  if (allow) {
    return false;
  }
  // Strict mode: default-deny for the browser process (loopback excepted). Off unless asked for; see
  // patches/privacy/apply_firewall_strict.py for why it is not the default.
  static const bool strict = base::CommandLine::ForCurrentProcess()->HasSwitch(
      "auren-firewall-strict");
  if (strict && !net::IsLocalhost(request.url)) {
    LOG(WARNING) << "AUREN_FIREWALL_STRICT: would block " << request.url.host()
                 << " (destination " << static_cast<int>(request.destination)
                 << ")";
    return true;
  }
  return IsAurenBlockedServiceHost(request.url.host());
}''',
     marker="AUREN_FIREWALL_STRICT: would block")
open(p, "w").write(s)
