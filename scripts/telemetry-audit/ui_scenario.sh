#!/bin/bash
# Drive the native UI of a running Auren (by pid) with System Events: type in
# the omnibox (search-suggestion / prediction leak test), open a site, toggle
# the sidebar (Cmd+B -> claude.ai side panel). Needs Accessibility permission
# for the calling process. usage: ui_scenario.sh PID CDP_PORT
PID=$1; PORT=${2:-9224}
tell() { osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID) to $1"; }
osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $PID) to true"
sleep 2
echo "[ui] omnibox typing"
tell 'keystroke "l" using command down'; sleep 1
tell 'keystroke "how to bake sourdough bread at home"'; sleep 8
tell 'key code 53'; sleep 1; tell 'key code 53'; sleep 1
echo "[ui] navigate example.org via omnibox"
tell 'keystroke "t" using command down'; sleep 1
tell 'keystroke "example.org"'; sleep 3; tell 'key code 36'; sleep 10
echo "[ui] toggle sidebar (Cmd+B)"
tell 'keystroke "b" using command down'; sleep 20
curl -s http://127.0.0.1:$PORT/json/list | python3 -c "import sys,json; [print('[target]',t['type'],t['url'][:90]) for t in json.load(sys.stdin)]"
echo "[ui] done"
