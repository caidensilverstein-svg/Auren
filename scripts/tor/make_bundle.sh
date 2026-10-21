#!/bin/bash
# Assemble the Tor bundle that ships inside the app (macOS: Auren.app/Contents/Resources/tor-bundle).
#
#   make_bundle.sh <expert-bundle-dir> <out-dir> <bundle-version> [arch]
#
# <expert-bundle-dir> is the extracted Tor Project "tor-expert-bundle" for the target platform (it has
# tor/ and data/). The platform is detected from its contents (macOS, Linux or Windows), so the same
# script assembles all three; run it on any host. [arch] is aarch64, x86_64 or i686; it defaults to the
# host's, so pass it (and TOR_VERSION) when assembling for another machine.
#
# Verify the tarball first: sha256 against the signed sha256sums-signed-build.txt, and that file's .asc
# against the Tor Browser Developers key EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290
# (see docs/privacy/tor.md). scripts/tor/fetch_bundle.sh does both.
#
# The Tor binary is renamed tor-<ver>-<arch>-auren-1 (+ .exe on Windows), which is the name the updater
# (BraveTorClientUpdater) looks for.
#   macOS:   arm64 kills unsigned binaries, so everything is ad-hoc signed here.
#   Linux:   tor has no RPATH, so its libevent/openssl would be looked up on the system. RPATH is set to
#            $ORIGIN (needs patchelf) so the bundled libraries are used wherever the app is installed.
#   Windows: nothing to fix up here; Authenticode-sign the .exe files with the app at release time.
set -euo pipefail
SRC=$1; OUT=$2; VER=$3; ARCH=${4:-}

if [ -f "$SRC/tor/tor.exe" ]; then PLATFORM=windows
elif [ -f "$SRC/tor/libevent-2.1.7.dylib" ]; then PLATFORM=macos
elif [ -f "$SRC/tor/libevent-2.1.so.7" ]; then PLATFORM=linux
else echo "not a tor expert bundle (no tor.exe / libevent found in $SRC/tor)" >&2; exit 1; fi

if [ -z "$ARCH" ]; then ARCH=$(uname -m); [ "$ARCH" = arm64 ] && ARCH=aarch64; fi
EXE=""; [ "$PLATFORM" = windows ] && EXE=".exe"

rm -rf "$OUT"; mkdir -p "$OUT/pluggable_transports"
cp "$SRC/data/geoip" "$SRC/data/geoip6" "$OUT/"
cp "$SRC/tor/pluggable_transports/lyrebird$EXE" "$OUT/pluggable_transports/"
cp "$SRC/tor/pluggable_transports/pt_config.json" "$OUT/pluggable_transports/"
cp "$SRC/tor/tor$EXE" "$OUT/tor.tmp"

case "$PLATFORM" in
  macos)
    cp "$SRC/tor/libevent-2.1.7.dylib" "$OUT/"
    if command -v codesign >/dev/null; then
      codesign -s - --force "$OUT/tor.tmp" "$OUT/libevent-2.1.7.dylib" "$OUT/pluggable_transports/lyrebird" >/dev/null 2>&1
    else
      echo "warning: no codesign on this host; sign the macOS binaries on a Mac before they are run" >&2
    fi
    ;;
  linux)
    command -v patchelf >/dev/null || { echo "patchelf is required for the Linux bundle (pip install patchelf)" >&2; exit 1; }
    for lib in libevent-2.1.so.7 libssl.so.3 libcrypto.so.3; do cp "$SRC/tor/$lib" "$OUT/"; done
    patchelf --set-rpath '$ORIGIN' "$OUT/tor.tmp" "$OUT/libssl.so.3" "$OUT/libevent-2.1.so.7"
    ;;
esac

# Tor's version: read from the binary when the bundle is for this machine. For another platform it must be
# given (TOR_VERSION=0.4.9.14): scanning a foreign binary for a version string is not reliable.
TORVER=${TOR_VERSION:-}
HOST_ARCH=$(uname -m); [ "$HOST_ARCH" = arm64 ] && HOST_ARCH=aarch64
HOST_OS=$(uname -s | tr 'A-Z' 'a-z'); [ "$HOST_OS" = darwin ] && HOST_OS=macos
if [ -z "$TORVER" ] && [ "$PLATFORM" = "$HOST_OS" ] && [ "$ARCH" = "$HOST_ARCH" ]; then
  chmod 755 "$OUT/tor.tmp"
  TORVER=$("$OUT/tor.tmp" --version | sed -n 's/^Tor version \([0-9][0-9.]*[0-9]\).*/\1/p')
fi
[ -n "$TORVER" ] || { echo "cannot run a $PLATFORM/$ARCH tor on this host: set TOR_VERSION (e.g. TOR_VERSION=0.4.9.14)" >&2; exit 1; }

NAME="tor-$TORVER-$ARCH-auren-1$EXE"
mv "$OUT/tor.tmp" "$OUT/$NAME"
chmod 755 "$OUT/$NAME" "$OUT/pluggable_transports/lyrebird$EXE"
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
echo "bundle ready: $OUT ($PLATFORM $ARCH, tor $TORVER, bundle $VER)"
