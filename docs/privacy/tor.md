# Tor in Auren

Auren ships the Tor Project's own `tor` client and shows the user where their Tor traffic goes:
guard, middle and exit relays, their IPs and countries, and every time the exit changes.

## What the user sees

* **NTP security bar → Tor.** Click opens a Tor window when Tor is off, or the circuit page when Tor is connected.
  The label shows the exit country when a circuit is carrying traffic. Off is neutral grey, not a fault.
* **`chrome://tor-circuit`.** For each circuit carrying traffic:
  `You → Guard → Middle → Exit → Website`, each relay with nickname, IP:port, country and a short fingerprint,
  and the destinations currently on that circuit. Below it, **IP jumps this session**: one row each time the
  (guard, exit) pair carrying traffic changes. Buttons: *Open Tor window*, *New circuits* (`SIGNAL NEWNYM`).

## Where the data comes from (all local)

| Shown | Source |
|-------|--------|
| Circuit paths | `GETINFO circuit-status`, refreshed on `CIRC` / `STREAM` / `GUARD` events |
| Which site is on which circuit | `GETINFO stream-status` |
| Relay IP and port | `GETINFO ns/id/<fingerprint>` (the consensus the client already has) |
| Country | `GETINFO ip-to-country/<ip>` (tor's bundled `geoip` file) |

Nothing is looked up on a server. The page has `connect-src 'none'`, `img-src 'none'` and no fonts; data arrives
only through `chrome.send`. Relay nicknames are chosen by relay operators, so the page writes them with
`textContent` only. The history lives in memory and is gone when Auren quits.

Only circuits that can carry browser traffic are listed (built, `GENERAL` / `CONFLUX_LINKED`, not internal or
one-hop directory tunnels). Modern tor builds many other circuits (vanguards, conflux legs, directory); showing
all of them would bury the one the user cares about. With conflux, a stream can use two legs that share an exit;
both are shown.

## Where the Tor binary comes from

Not from Brave's component server. `scripts/tor/make_bundle.sh` assembles the Tor Project's
`tor-expert-bundle` and `scripts/tor/install_into_app.sh` puts it in
`Auren.app/Contents/Resources/tor-bundle`. The browser runs `tor` **in place** from there
(`GetBundledTorDir()`); the component updater is only the fallback when no bundle is present.
For development, `AUREN_TOR_BUNDLE=<dir>` overrides the location (an environment variable, because the
utility process that launches tor does not see the browser's command-line switches).

Verifying a bundle (done on 2026-10-20 for 15.0.25 / tor 0.4.9.14):

1. `sha256sum tor-expert-bundle-macos-aarch64-<ver>.tar.gz` equals the line in `sha256sums-signed-build.txt`.
2. `gpg --verify sha256sums-signed-build.txt.asc sha256sums-signed-build.txt` is a good signature by
   *Tor Browser Developers (signing key)*, primary fingerprint
   `EF6E 286D DA85 EA2A 4BA7  DE68 4E2C 6E87 9329 8290` (fetched via WKD for `torbrowser@torproject.org`).

The bundle's binaries are unsigned and macOS arm64 kills unsigned binaries, so the script ad-hoc signs them.
For distribution they must be signed with Auren's identity as part of app signing.

### Why in place, not copied

The first design copied the bundle into the profile (where Brave keeps its component). On a non-notarized
dev build that **hangs**: files written by Auren carry `com.apple.quarantine` / `com.apple.provenance`, and
Gatekeeper silently holds the launch of the executable (process alive, 0 CPU, no output, no dialog).
Clearing the quarantine flag did not help (the provenance tag comes back), while a byte-identical copy made
from a shell ran instantly. Running from the app bundle avoids writing any executable at runtime.

## Verified end to end (2026-10-20, Auren dev build, macOS arm64)

* Bundled tor starts from the app, bootstraps, `IsTor: true` on `check.torproject.org`.
* The exit the page showed equalled the IP the website saw, twice:
  `194.32.107.172` (NO) then, after *New circuits*, `192.42.116.100` (NL). The history listed both.
* Guard stayed the same across *New circuits*, as tor intends.

## Code

New: `components/tor/tor_circuit_tracker.{h,cc}` (+ unit tests on real tor output),
`browser/ui/webui/auren/auren_tor_ui.{h,cc}`.
Changed: `tor_control.{h,cc}` (data-reply support, generic `RunCommand`), `tor_launcher_factory.{h,cc}`,
`brave_tor_client_updater.{h,cc}`, the NTP and its security handler.
All of it is applied to a brave-core tree by `patches/tor/apply.py`.

**Brave's control-port client could not read `GETINFO circuit-status`.** Multi-line ("`250+`") replies were
ignored and their body lines would have been treated as malformed, closing the control connection. The client
now supports them.

## Bridges (obfs4, meek, webtunnel, snowflake)

Brave already ships the bridge feature: Settings > Tor has a bridges dialog (built-in obfs4 or snowflake, a
requested set from the Tor Project, or your own bridge lines), applied through `TorControl::SetupBridges`. What
was missing for Auren is where the transport programs come from: Brave downloads them as a second component from
**Brave's component server**, so turning bridges on would have sent a request to Brave. `patches/tor/apply_bridges.py`
(run after `apply.py`) makes the transport updater use the `lyrebird` that is already in the bundle
(`pluggable_transports/lyrebird`), exactly like Tor Browser. With a bundle present no component is fetched; without
one it falls back to Brave's component as before.

* `constants.{h,cc}`: `ResolvePluggableTransportPath()` (a path under the bundled sentinel is relative to tor's
  working directory, i.e. the bundle; anything else keeps the old `../../<component path>`).
* `brave_tor_pluggable_transport_updater.{h,cc}`: `Register()` looks for the bundled `lyrebird` first and reports
  ready with that path for both snowflake and obfs4.
* `tor_control.cc`: for the bundled case `SETCONF ClientTransportPlugin` uses lyrebird for
  `meek_lite,obfs2,obfs3,obfs4,scramblesuit,webtunnel` and for `snowflake`, **without** the `-url/-front/-ice`
  flags that the standalone snowflake-client needs (lyrebird takes those from the bridge line, which the built-in
  snowflake lines carry as `url=`, `fronts=`, `ice=`).
* `tor_profile_service_impl.cc`: its debug-only existence check uses the same path rule.

Network note: picking *built-in* bridges makes Brave's code ask `bridges.torproject.org` (moat) for a fresh list;
that is a request to the Tor Project, only when the user chose built-in bridges.

Verified 2026-10-21 (Linux x86_64 bundle, tor 0.4.9.14): tor started with the network disabled, then received
exactly the `SETCONF` strings the patch produces (bundled form, relative `exec pluggable_transports/lyrebird`,
`Bridge="..."` lines + `UseBridges=1`, as `SetupBridges` formats them). Result: `Bootstrapped 100%`,
`check.torproject.org` reported `IsTor: true`, and the guards on the built circuits were bridge fingerprints from
the default obfs4 list. Snowflake (the built-in snowflake line with its `url=`/`fronts=`/`ice=` arguments, `snowflake exec pluggable_transports/lyrebird`
with no flags): `Bootstrapped 100%` in 93 s, `IsTor: true`, and the only guard on the circuits was the snowflake bridge
(`8838024498816A039FCBBAB14E6F40A0843051FA`). **Not verified:** the C++ (never compiled; the anchors
of every edit were checked to match brave-core v1.94.97, the Mac tree's base, and the script is idempotent), the
settings dialog end to end, and any platform other than Linux.

## Not done yet / known limits

* The Tor-window new-tab page does not embed the circuit view; open `chrome://tor-circuit`.
* The build does not yet install the bundle into `Auren.app` automatically; run `install_into_app.sh`
  (or set `AUREN_TOR_BUNDLE`).
* Tor traffic itself was not captured through the telemetry audit yet; only the page's data was verified.
* `brave_unit_tests` has not been built with the tracker's gtest yet. As a stand-in, `scripts/tor/hosttest/run.sh`
  compiles the real tracker sources on a plain Linux toolchain (small stand-ins for the //base pieces, see
  `shim/`) and runs the parser tests plus 8 state-machine tests against a scripted fake control port: spare
  circuits collapsed, internal/one-hop hidden, IP-jump history, last-used circuit retained, retry of unresolved
  relays, Stop, bounded history, late replies after destruction. 14/14 pass; breaking the spare rule makes
  a test fail. This found one real defect (missing copy-assignment on `ParsedCircuit`, now fixed). It does not
  replace compiling in the browser tree.
* Linux and Windows: `scripts/tor/fetch_bundle.sh <ver> <platform-arch> <dir>` downloads an expert bundle and
  verifies it (signed checksum list by the Tor Browser signing key EF6E...8290, then the tarball sha256);
  `make_bundle.sh` now assembles macOS, Linux and Windows bundles (platform detected from the bundle).
  Verified 2026-10-21 for 15.0.25 / tor 0.4.9.14 on Linux x86_64: tor starts from the assembled bundle with
  no `LD_LIBRARY_PATH` (libevent/openssl resolve from the bundle via `RPATH=$ORIGIN`, set with patchelf because
  the shipped `tor` has no RPATH), bootstraps to 100% and `check.torproject.org` reports `IsTor: true`; the
  control port returns the `250+circuit-status` reply. **Not verified:** the browser side on Linux/Windows
  (the launcher finding `tor-<ver>-<arch>-auren-1[.exe]`, the in-app install location), a Windows run, and
  Authenticode/notarization signing. The macOS x86_64 and Windows bundles were assembled but not run.
* `NEWNYM` is rate-limited by tor (about every 10 s) and affects all sites, unlike Brave's per-site
  "New Tor circuit for this site".
