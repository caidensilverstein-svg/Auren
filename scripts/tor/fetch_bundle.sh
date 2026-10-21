#!/bin/bash
# Download a Tor Project expert bundle and verify it before anything is built from it.
#
#   fetch_bundle.sh <tor-browser-version> <platform-arch> <out-dir>
#   e.g. fetch_bundle.sh 15.0.25 linux-x86_64 ./bundles
#
# platform-arch is one of macos-aarch64, macos-x86_64, linux-x86_64, linux-i686, windows-x86_64, windows-i686.
# Checks (any failure aborts, nothing is extracted):
#   1. sha256sums-signed-build.txt carries a good signature by the Tor Browser Developers signing key,
#      primary fingerprint EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290 (fetched via WKD).
#   2. the tarball's sha256 matches the line in that file.
# On success <out-dir>/<platform-arch>/ holds the extracted bundle; pass it to make_bundle.sh.
set -euo pipefail
V=$1; PA=$2; OUT=$3
EXPECTED="EF6E286DDA85EA2A4BA7DE684E2C6E8793298290"
BASE="https://dist.torproject.org/torbrowser/$V"
TARBALL="tor-expert-bundle-$PA-$V.tar.gz"

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
export GNUPGHOME="$W/gnupg"; mkdir -m 700 "$GNUPGHOME"
get() { curl -sfL -m "$3" -o "$1" "$2" || { echo "download failed: $2" >&2; exit 1; }; }
get "$W/sums" "$BASE/sha256sums-signed-build.txt" 300
get "$W/sums.asc" "$BASE/sha256sums-signed-build.txt.asc" 60
get "$W/$TARBALL" "$BASE/$TARBALL" 600

gpg --quiet --auto-key-locate clear,nodefault,wkd --locate-keys torbrowser@torproject.org >/dev/null 2>&1 \
  || { echo "could not fetch the Tor Browser signing key" >&2; exit 1; }
STATUS=$(gpg --status-fd 1 --verify "$W/sums.asc" "$W/sums" 2>/dev/null) \
  || { echo "BAD signature on the checksum list" >&2; exit 1; }
echo "$STATUS" | grep -q '^\[GNUPG:\] GOODSIG' || { echo "no good signature" >&2; exit 1; }
PRIMARY=$(echo "$STATUS" | awk '/^\[GNUPG:\] VALIDSIG/ {print $NF}')
[ "$PRIMARY" = "$EXPECTED" ] || { echo "signed by an unexpected key: $PRIMARY" >&2; exit 1; }

LINE=$(grep -E "  $TARBALL\$" "$W/sums" || true)
[ -n "$LINE" ] || { echo "$TARBALL is not in the signed checksum list" >&2; exit 1; }
(cd "$W" && echo "$LINE" | sha256sum -c - >/dev/null) || { echo "sha256 mismatch for $TARBALL" >&2; exit 1; }

mkdir -p "$OUT/$PA"
tar -xzf "$W/$TARBALL" -C "$OUT/$PA"
echo "verified and extracted: $OUT/$PA  (sha256 $(echo "$LINE" | cut -d' ' -f1), key $PRIMARY)"
