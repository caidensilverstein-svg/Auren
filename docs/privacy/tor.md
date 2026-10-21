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

## Not done yet / known limits

* Bridges (obfs4 / snowflake) are not wired up; `lyrebird` is bundled but unused.
* The Tor-window new-tab page does not embed the circuit view; open `chrome://tor-circuit`.
* The build does not yet install the bundle into `Auren.app` automatically; run `install_into_app.sh`
  (or set `AUREN_TOR_BUNDLE`).
* Tor traffic itself was not captured through the telemetry audit yet; only the page's data was verified.
* Linux / Windows bundles are not produced.
* `NEWNYM` is rate-limited by tor (about every 10 s) and affects all sites, unlike Brave's per-site
  "New Tor circuit for this site".
