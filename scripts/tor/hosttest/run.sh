#!/usr/bin/env bash
# Compiles the real tor_circuit_tracker.{h,cc} + its unit tests on the host against small
# stand-ins for the //base pieces they use (see shim/), then runs them. Needs g++ (C++20) and gtest.
# This checks the tracker's own logic; it does NOT replace building brave_unit_tests in the browser tree.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
ov="$repo/patches/tor/overlay/components/tor"
out="${TMPDIR:-/tmp}/auren-tor-hosttest"
rm -rf "$out"; mkdir -p "$out/inc"
cp -r "$here/shim/." "$out/inc/"
for f in tor_circuit_tracker.h tor_circuit_tracker.cc tor_circuit_tracker_unittest.cc; do
  ln -s "$ov/$f" "$out/inc/brave/components/tor/$f"
done
g++ -std=c++20 -Wall -Wextra -Wno-unused-parameter -Werror -I"$out/inc" \
  "$out/inc/brave/components/tor/tor_circuit_tracker.cc" \
  "$out/inc/brave/components/tor/tor_circuit_tracker_unittest.cc" \
  "$here/tracker_state_test.cc" -lgtest -lgtest_main -lpthread -o "$out/tracker_test"
"$out/tracker_test" "$@"
