#!/bin/bash
# Put an assembled Tor bundle (see make_bundle.sh) inside the app, where the
# browser finds it: Auren.app/Contents/Resources/tor-bundle.
#   install_into_app.sh <bundle-dir> <path/to/Auren.app>
# For a release build, do this before signing the app so the tor binary is
# covered by the app's signature and notarization.
set -euo pipefail
B=$1; APP=$2
[ -f "$B/tor-torrc" ] || { echo "not a bundle: $B"; exit 1; }
DEST="$APP/Contents/Resources/tor-bundle"
rm -rf "$DEST"; mkdir -p "$APP/Contents/Resources"
cp -R "$B" "$DEST"
echo "installed to $DEST"
