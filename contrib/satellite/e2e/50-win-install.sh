#!/usr/bin/env bash
# 50-win-install.sh — spec §9.4.1: install the Windows-native satellite through
# WSL interop.
#
# The token reaches Windows in a 0600 token.txt under the recall-e2e Temp
# directory, is read by `set /p` inside the .cmd, and is deleted by the trap.
# Right after the Windows global install this script re-checks `which -a recall`
# in THIS WSL shell: the Windows npm prefix ($WIN_HOME/AppData/Roaming/npm) is on
# the PATH, and
# the 2026-08-12 "invalid ELF header" incident was a Windows shim shadowing the
# WSL binary.
source "$(dirname "$0")/lib.sh"
set -u
NAME=50-win-install
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_e2e_env RECALL_E2E_HUB_ADDR RECALL_E2E_WIN_USER
HUB_RECALL_BIN=${RECALL_E2E_HUB_RECALL_BIN:-}
if [ -z "$HUB_RECALL_BIN" ]; then
  require_e2e_env RECALL_E2E_NODE
  HUB_RECALL_BIN=$(dirname "$NODE")/recall
fi
load_tokens win
require_hub_up
[ -n "$TGZ" ] && [ -f "$TGZ" ] || fail "$NAME" "set RECALL_E2E_TGZ to the packed tarball"
mkdir -p "$WIN_DIR"
trap 'rm -f "$WIN_DIR/token.txt"' EXIT

cp "$TGZ" "$WIN_DIR/crispy-recall.tgz" || fail "$NAME" "could not copy the tarball into $WIN_DIR"
A=$(sha256sum "$TGZ" | cut -d' ' -f1); B=$(sha256sum "$WIN_DIR/crispy-recall.tgz" | cut -d' ' -f1)
step "tarball sha256 source=$A windows=$B"
[ "$A" = "$B" ] || fail "$NAME" "the tarball copy does not match"

( umask 077; printf '%s\n' "$RECALL_E2E_TOKEN_WIN" > "$WIN_DIR/token.txt" )
M=$(stat -c %a "$WIN_DIR/token.txt")
[ "$M" = 600 ] || step "NOTE: token.txt is mode $M (DrvFs without metadata ignores umask) — exists only for this step, removed in the trap"
step "token.txt written (not shown)"

OUT=$(win_cmd 50-install <<CMD
@echo off
call "$WIN_NPM_W" install -g "$WIN_DIR_W\crispy-recall.tgz"
if errorlevel 1 exit /b 1
where recall
set /p RECALL_HUB_TOKEN=<"$WIN_DIR_W\token.txt"
call "$WIN_RECALL_W" install --hub $HUB_URL --yes
exit /b %ERRORLEVEL%
CMD
); RC=$?
printf '%s\n' "$OUT" | sed "s/$RECALL_E2E_TOKEN_WIN/<token>/g" | tail -40 | sed 's/^/    /'
[ "$RC" = 0 ] || fail "$NAME" "the Windows install step exited $RC"
printf '%s\n' "$OUT" | grep -qF 'AppData\Roaming\npm\recall.cmd' \
  || fail "$NAME" "where recall did not print $WIN_RECALL_W"
rm -f "$WIN_DIR/token.txt"; trap - EXIT

step "which -a recall in THIS WSL shell:"
which -a recall | sed 's/^/    /'
FIRST=$(which -a recall | head -1)
[ "$FIRST" = "$HUB_RECALL_BIN" ] \
  || fail "$NAME" "the WSL shell now resolves recall to $FIRST, not $HUB_RECALL_BIN — the Windows shim shadows the hub binary"

python3 - "$WIN_HOME/.claude/settings.json" <<'PY' || fail "$NAME" "the Windows settings.json assertions failed"
import json,sys
d=json.load(open(sys.argv[1])); h=d.get('hooks',{}); ok=True
for ev in ('Stop','SubagentStop'):
    cmds=[x.get('command','') for g in h.get(ev,[]) for x in g.get('hooks',[])]
    good=any('stop-hook.js' in c for c in cmds)
    print(f"    {ev}: {'OK' if good else 'MISSING'}")
    ok = ok and good
print('    cleanupPeriodDays:', d.get('cleanupPeriodDays'))
sys.exit(0 if ok and d.get('cleanupPeriodDays')==999 else 1)
PY

[ ! -e "$WIN_HOME/.recall/recall.db" ] || fail "$NAME" "the Windows satellite grew a recall.db"
step "no $WIN_HOME_W\\.recall\\recall.db — satellite mode confirmed"
pass "$NAME"
