# Auren privacy sanctuary: telemetry audit and hardening

Branch: `privacy/telemetry`. Goal: zero requests to anyone except what the user
explicitly navigates to (and the claude.ai side panel they open).

| doc | content |
|---|---|
| [01-baseline-traffic.md](01-baseline-traffic.md) | measured traffic of the unmodified build (netlog), before/after tables |
| [02-source-audit-matrix.md](02-source-audit-matrix.md) | service -> endpoint -> gating mechanism -> status |
| [03-hardening-changes.md](03-hardening-changes.md) | every change made, in layer order, with file paths |
| [04-debrave-checklist.md](04-debrave-checklist.md) | Brave personality removal: done / deferred |
| [05-decisions-and-tradeoffs.md](05-decisions-and-tradeoffs.md) | what breaks, what was chosen and why |
| `data/before`, `data/after` | netlog summaries, timelines, WebUI scan output |

## Re-running the audit

Everything lives in `scripts/telemetry-audit/` (needs Node >= 22 and Python 3):

```
# 1. capture (throwaway profile, CDP 9224 or AUREN_CDP_PORT; never 9223)
scripts/telemetry-audit/run_capture.sh LABEL SECONDS [--fresh] [--scenario]
#    env: SCENARIO_URLS=a,b,c  UI_SCENARIO=1 (omnibox typing + Cmd+B side panel)
#         WEBUI_SCAN=1 (scan chrome:// pages for Brave/Google leftovers)
# 2. gate (exit 1 if any browser-initiated Brave/Google/other host appears)
scripts/telemetry-audit/netlog_audit.py ~/auren-audit/netlog-LABEL.json \
    --allowlist scripts/telemetry-audit/allowlist.txt --allow-host example.org
# 3. tables
scripts/telemetry-audit/compare_runs.py before=a.json after=b.json
```

Classification: `allowlisted` (claude.ai, DoH transport, hosts you pass),
`page-requested` (reachable via initiator chain from an allowlisted host, e.g.
claude.ai's own CDNs or a site's assets), `brave`, `google`, `other`
(browser-initiated, unexpected). Exit code 1 = CI gate fails.
Note: requests cancelled before the network stack starts them leave no
`URL_REQUEST_START_JOB`, so `scenario.js` also prints resource-timing of
internal pages.
