#!/bin/bash
# Launch Auren with netlog capture, optionally drive a scenario, then stop it.
# usage: run_capture.sh LABEL SECONDS [--fresh] [--scenario]
# Output: ~/auren-audit/netlog-LABEL.json, run-LABEL.log
# Uses CDP port 9224 and a throwaway profile ~/auren-audit/profile-LABEL (never 9223).
LABEL=$1; SECS=$2; shift 2
FRESH=0; SCEN=0
for a in "$@"; do [ "$a" = --fresh ] && FRESH=1; [ "$a" = --scenario ] && SCEN=1; done
A=$HOME/auren-audit
BIN=${AUREN_BIN:-$HOME/brave-src/src/out/auren/Auren.app/Contents/MacOS/Auren}
P=$A/profile-$LABEL
[ $FRESH = 1 ] && rm -rf "$P"
rm -f "$A/done-$LABEL"
cd "$A"
"$BIN" --user-data-dir="$P" --log-net-log="$A/netlog-$LABEL.json" --net-log-capture-mode=Default \
  --remote-debugging-port=9224 > "$A/run-$LABEL.log" 2>&1 &
PID=$!
echo $PID > "$A/pid-$LABEL"
if [ $SCEN = 1 ]; then
  sleep 20
  node "$(dirname "$0")/scenario.js" 9224 20 > "$A/scenario-$LABEL.log" 2>&1
fi
sleep "$SECS"
# Snapshot sockets of the browser process tree before stopping.
lsof -nP -i -a -p $PID > "$A/lsof-$LABEL.txt" 2>&1
kill $PID; sleep 8; kill -9 $PID 2>/dev/null
date > "$A/done-$LABEL"
