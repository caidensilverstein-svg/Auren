#!/bin/bash
# Assemble the Tor bundle that ships inside Auren.app/Contents/Resources/tor-bundle.
#
#   make_bundle.sh <expert-bundle-dir> <out-dir> <bundle-version>
#
# <expert-bundle-dir> is the extracted Tor Project "tor-expert-bundle" (it has
# tor/ and data/). Verify the tarball first: sha256 against the signed
# sha256sums-signed-build.txt, and that file's .asc against the Tor Browser
# Developers key EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290 (see
# docs/privacy/tor.md).
#
# The Tor binary is renamed tor-<ver>-<arch>-auren-1, which is the name the
# updater (BraveTorClientUpdater) looks for. macOS arm64 kills unsigned
# binaries, so everything is ad-hoc signed.
set -euo pipefail
SRC=$1; OUT=$2; VER=$3
rm -rf "$OUT"; mkdir -p "$OUT/pluggable_transports"
cp "$SRC/tor/libevent-2.1.7.dylib" "$OUT/"
cp "$SRC/data/geoip" "$SRC/data/geoip6" "$OUT/"
cp "$SRC/tor/pluggable_transports/lyrebird" "$OUT/pluggable_transports/"
cp "$SRC/tor/pluggable_transports/pt_config.json" "$OUT/pluggable_transports/"
cp "$SRC/tor/tor" "$OUT/tor.tmp"
codesign -s - --force "$OUT/tor.tmp" "$OUT/libevent-2.1.7.dylib" "$OUT/pluggable_transports/lyrebird" >/dev/null 2>&1
TORVER=$("$OUT/tor.tmp" --version | sed -n 's/^Tor version \([0-9][0-9.]*[0-9]\).*/\1/p')
ARCH=$(uname -m); [ "$ARCH" = arm64 ] && ARCH=aarch64
mv "$OUT/tor.tmp" "$OUT/tor-$TORVER-$ARCH-auren-1"
chmod 755 "$OUT/tor-$TORVER-$ARCH-auren-1" "$OUT/pluggable_transports/lyrebird"
echo "$VER" > "$OUT/VERSION"
# The launcher passes this file as both -f and --defaults-torrc and starts tor
# with its working directory set to this folder, hence the relative paths.
cat > "$OUT/tor-torrc" <<'TORRC'
ClientOnly 1
AvoidDiskWrites 1
DormantCanceledByStartup 1
SafeLogging 1
SocksPort auto IPv6Traffic PreferIPv6 KeepAliveIsolateSOCKSAuth
ControlPort auto
CookieAuthentication 1
GeoIPFile geoip
GeoIPv6File geoip6
TORRC
echo "bundle ready: $OUT (tor $TORVER, bundle $VER)"
