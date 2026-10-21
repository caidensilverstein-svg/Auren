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
