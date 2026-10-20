#!/usr/bin/env python3
"""Render a markdown before/after table from netlog_audit.py --json outputs.

usage: compare_runs.py LABEL=summary.json [LABEL=summary.json ...]
Rows are hosts (non page-requested/allowlisted by default, see --all); cells
are 'url_requests/dns'. Use it to produce docs tables, e.g.
  compare_runs.py before=before/summary-idle15.json after=after/summary-idle15.json
"""
import json, sys
args = [a for a in sys.argv[1:] if not a.startswith('--')]
show_all = '--all' in sys.argv
runs = []
for a in args:
    label, path = a.split('=', 1)
    runs.append((label, json.load(open(path))))
hosts = {}
for label, d in runs:
    for h, v in d.items():
        if not show_all and v['class'] in ('allowlisted', 'page-requested', 'loopback'):
            continue
        hosts.setdefault(h, v['class'])
order = {'brave': 0, 'google': 1, 'browser-initiated': 2, 'other': 3, 'ip-only': 4}
print('| host | class | ' + ' | '.join(l for l, _ in runs) + ' |')
print('|---|---|' + '---|' * len(runs))
for h, c in sorted(hosts.items(), key=lambda kv: (order.get(kv[1], 9), kv[0])):
    cells = []
    for _, d in runs:
        v = d.get(h)
        cells.append('%d/%d' % (v['url_requests'], v['dns']) if v else '-')
    print('| %s | %s | %s |' % (h, c, ' | '.join(cells)))
if not hosts:
    print('| (none) | | ' + ' | '.join('-' for _ in runs) + ' |')
