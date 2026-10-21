#!/bin/bash
# Ship patches/tor to the Mac (which has no GitHub access) via Oracle and apply it.
# usage: push_to_mac.sh   (run from anywhere; needs ssh to Oracle + command dispatch on the Mac)
set -e
R="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d)
tar czf "$T/tor.tgz" -C "$R" patches/tor scripts/tor
scp -q -i ~/.ssh/id_ed25519 "$T/tor.tgz" ubuntu@10.8.0.1:/tmp/auren-tor-patch.tgz
echo "uploaded to Oracle; now run on the Mac:"
echo "  scp -i ~/oci_instance_key.pem ubuntu@10.8.0.1:/tmp/auren-tor-patch.tgz /tmp/ && rm -rf ~/auren-repo/patches/tor && mkdir -p ~/auren-repo/patches && tar xzf /tmp/auren-tor-patch.tgz -C ~/auren-repo/patches && python3 ~/auren-repo/patches/tor/apply.py ~/brave-src/src/brave"
