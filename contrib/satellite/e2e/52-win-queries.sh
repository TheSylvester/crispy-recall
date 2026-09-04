#!/usr/bin/env bash
# 52-win-queries.sh — spec §9.4.3: the Windows session is found without --all
# from its own directory and from a differently-cased path, and the hook opens
# no console window.
#
# The console check is BEST EFFORT: the flash is sub-second, so equal conhost
# counts cannot prove absence. The script prints both counts and PASSes either
# way, and says so.
source "$(dirname "$0")/lib.sh"
set -u
NAME=52-win-queries
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_hub_up
[ -e /mnt/c/Users/silve/.recall/config.json ] || fail "$NAME" "Windows satellite not installed — run 50-win-install.sh first"
VARS=$E2E_LOG_DIR/51.vars
[ -f "$VARS" ] || fail "$NAME" "no $VARS — run 51-win-sessions.sh first"
WIN_SID_PATH=
# shellcheck disable=SC1090
. "$VARS"
[ -n "$WIN_SID_PATH" ] || fail "$NAME" "$VARS names no WIN_SID_PATH — re-run 51-win-sessions.sh"

OUT=$(win_cmd 52a <<CMD
@echo off
cd /d C:\winDev\starcon-research
call $WIN_RECALL_W SAT-WIN-$WIN_NONCE
exit /b %ERRORLEVEL%
CMD
) || fail "$NAME" "the query from C:\\winDev\\starcon-research exited nonzero"
printf '%s\n' "$OUT" | head -12 | sed 's/^/    /'
# `recall` echoes the query first (recall.ts:967), so a nonce grep would pass
# whatever came back: match the session id 51 recorded and the Results: count.
N1=$(printf '%s\n' "$OUT" | rows)
step "52a unique sessions: $N1"
printf '%s\n' "$OUT" | grep -q "$WIN_SID_PATH" \
  || fail "$NAME" "session $WIN_SID_PATH is not found from its own directory without --all"
[ "$N1" -ge 1 ] || fail "$NAME" "52a returned no sessions"

OUT2=$(win_cmd 52b <<CMD
@echo off
cd /d c:\WINDEV\starcon-research
call $WIN_RECALL_W SAT-WIN-$WIN_NONCE
exit /b %ERRORLEVEL%
CMD
) || fail "$NAME" "the query from the differently-cased path exited nonzero"
printf '%s\n' "$OUT2" | head -12 | sed 's/^/    /'
N2=$(printf '%s\n' "$OUT2" | rows)
step "52b unique sessions: $N2"
printf '%s\n' "$OUT2" | grep -q "$WIN_SID_PATH" \
  || fail "$NAME" "the folded key half does not match from c:\\WINDEV\\starcon-research"
[ "$N2" -ge 1 ] || fail "$NAME" "52b returned no sessions"

count_conhost() {
  win_cmd "$1" <<'CMD'
@echo off
tasklist /fi "imagename eq conhost.exe" | find /c "conhost"
exit /b %ERRORLEVEL%
CMD
}
BEFORE=$(count_conhost 52c-before | tr -dc '0-9')
N=$(nonce)
win_cmd 52d <<CMD | sed 's/^/    /'
@echo off
cd /d C:\winDev\starcon-research
call $WIN_CLAUDE_W -p Reply with exactly this test phrase and nothing else: SAT-WIN-FLASH-$N --model haiku
exit /b %ERRORLEVEL%
CMD
AFTER=$(count_conhost 52c-after | tr -dc '0-9')
step "conhost.exe processes before=$BEFORE after=$AFTER"
if [ "${BEFORE:-0}" = "${AFTER:-0}" ]; then
  step "equal counts — the sub-second flash is UNVERIFIABLE by sampling; recorded, not asserted"
else
  step "the count changed; a lingering console may exist — record it in the results file (not a gate)"
fi
pass "$NAME"
