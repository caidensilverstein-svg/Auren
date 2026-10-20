# Privacy patches (Chromium-tree level)

* `args.gn.privacy` - build args appended to `out/auren/args.gn`.
* `0001-network-firewall.patch` - applies in `~/brave-src/src` (the Chromium tree, not `brave/`).
  Reconstructed from the Mac commit; note the 2026-10-20 first build failed with
  `no member named 'host_piece' in 'GURL'`, so this version uses `request.url.host()`.
  The fix existed only in the Mac working tree (uncommitted) when the Mac went offline.
* `fingerprint/` - Blink/Brave-layer patches (apply in `~/brave-src/src/brave`).

Build recipe (needed, otherwise mojom_parser fails with `No module named brave_chromium_utils`):
`cd ~/brave-src/src && PYTHONPATH="$(pwd)/brave/script" autoninja -C out/auren chrome`
