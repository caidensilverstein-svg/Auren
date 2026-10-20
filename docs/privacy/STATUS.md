# Privacy work: status (2026-10-20)

**Merged to main (stable, no C++ compiled):** audit tooling and baselines (`scripts/telemetry-audit`,
`scripts/privacy`, `scripts/fingerprint-audit` with passing unit tests), research/policy/audit docs,
and the patch files in `patches/privacy/` (Mac-tree patches; none built yet).

**Held back on branch `privacy/browser-unbuilt`:** edits to the repo's `browser/` mirror that have never
been compiled - NTP without external fonts/CSP, side-panel UA override removal, honest security-bar
checklist (mojom change). The same edits are committed in the Mac tree (`~/brave-src/src/brave`, commits
`a1ef4cb6b`, `bc2628bb1`). Merge that branch after the Mac rebuild succeeds and
`netlog_audit.py` / the fingerprint harness have been re-run.

**Blocked:** first rebuild failed on `host_piece` (fixed in `patches/privacy/0001-network-firewall.patch`);
build needs `PYTHONPATH="$(pwd)/brave/script"`. See `patches/privacy/README.md`.
