# Privacy work: status (2026-10-20)

**Merged to main (stable, no C++ compiled):** audit tooling and baselines (`scripts/telemetry-audit`,
`scripts/privacy`, `scripts/fingerprint-audit` with passing unit tests), research/policy/audit docs,
and the patch files in `patches/privacy/` (Mac-tree patches; none built yet).

**Merged 2026-10-21 (PR #19):** the `browser/` mirror (NTP without external fonts/CSP, gold accent, honest
security bar, Tor button, side-panel UA override removal). The Mac rebuild succeeded and the result was
launch-tested (bar: Tor Off, DNS On, JS On, Fingerprint 4/4, HTTPS Upgrade, Cookies Isolated).

**Still to run (needs the Mac idle, no one using it):** a hands-off `run_capture.sh` + `netlog_audit.py`
(exit 0) + `compare_runs.py` against the baseline, the fingerprint harness post-run, and a capture with Tor
on. Until then no privacy result beyond the launch test is claimed.

**Resolved:** the first rebuild failed on `host_piece` (fixed in `patches/privacy/0001-network-firewall.patch`);
build needs `PYTHONPATH="$(pwd)/brave/script"`. See `patches/privacy/README.md`.

**2026-10-21 (Mac offline, no compiles):** Oracle MCP deployed to `main` (backup `~/backups/auren-mcp-20261021-115335`
on Oracle; 25/25 e2e pass locally, health ok; live-browser smoke test pending the Mac). Added, all source-only:
Tor bridges through the bundled lyrebird (`patches/tor/apply_bridges.py`; transport commands verified end to end on
Linux for obfs4 and snowflake), Linux/Windows Tor bundles, a host-side test harness for the circuit tracker (14/14),
`patches/privacy/0002-js-heap-size-limit.patch`, and optional `fingerprint/optional/0009-...`. None of the C++ has been
compiled. The Mac-side queue (apply, build, hands-off netlog audit, fingerprint post-run, Tor capture) is Gitea
issue #18. `open-risks.md` item 3 was corrected: the battery API returns constants in Brave's source.
