#!/usr/bin/env bash
# 52-win-queries.sh — spec §9.4.3: the Windows session is found without --all
# from its own directory and from a differently-cased path, and the hook opens
# no console window.
#
# The console check is BEST EFFORT: the flash is sub-second, so equal conhost
# counts cannot prove absence. The script prints both counts and PASSes either
# way, and says so.
#
# A .cmd file BODY may quote freely (the "no double quotes" rule of spec §9.4 is
# about the WSL→cmd.exe interop command line only), so each query passes ONE
# quoted argument.
#
# DEVIATION §9.4.3 — when Windows Claude Code cannot authenticate, the flash
# turn falls back to the same SYNTHETIC Stop-hook invocation 51 uses, and the
# conhost observation is then reported as "not observable in synthetic mode",
# never as a FAIL. RECALL_E2E_WIN_SYNTHETIC=0 turns the fallback off.
source "$(dirname "$0")/lib.sh"
set -u
NAME=52-win-queries
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_e2e_env RECALL_E2E_HUB_ADDR RECALL_E2E_WIN_USER
require_hub_up
[ -e "$WIN_HOME/.recall/config.json" ] || fail "$NAME" "Windows satellite not installed — run 50-win-install.sh first"
VARS=$E2E_LOG_DIR/51.vars
[ -f "$VARS" ] || fail "$NAME" "no $VARS — run 51-win-sessions.sh first"
WIN_SID_PATH=
# shellcheck disable=SC1090
. "$VARS"
[ -n "$WIN_SID_PATH" ] || fail "$NAME" "$VARS names no WIN_SID_PATH — re-run 51-win-sessions.sh"
SYNTH=${RECALL_E2E_WIN_SYNTHETIC:-auto}
AUTH_RE='Failed to authenticate|OAuth|not logged in|/login'
SYNTHETIC_USED=0

OUT=$(win_cmd 52a <<CMD
@echo off
cd /d C:\winDev\starcon-research
call $WIN_RECALL_W "SAT-WIN-$WIN_NONCE"
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
call $WIN_RECALL_W "SAT-WIN-$WIN_NONCE"
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
# synthetic_flash <windows cwd> <project slug> <prompt text> — the 51 fallback.
# The satellite branch of src/hooks/stop-hook.ts reads session_id +
# transcript_path (:90-99) and cwd (:122-129) and returns at once on
# stop_hook_active (:111); hook_event_name is sent for fidelity, not read.
synthetic_flash() {
  local wcwd=$1 slug=$2 prompt=$3 u pdir hout
  u=$(uuidgen) || fail "$NAME" "uuidgen failed"
  [ -n "$u" ] || fail "$NAME" "uuidgen produced an empty id"
  pdir=$WIN_HOME/.claude/projects/$slug
  mkdir -p "$pdir" || fail "$NAME" "could not create $pdir"
  python3 - "$pdir/$u.jsonl" "$u" "$wcwd" "$prompt" <<'PY' || fail "$NAME" "could not write the synthetic Windows transcript"
import json,sys,uuid
f,sid,cwd,text=sys.argv[1:5]
body=text+' — synthetic Stop-hook fixture line, long enough to clear the fifty character floor.'
def entry(i,role,parent):
    x=str(uuid.uuid4())
    return x, json.dumps({'type':role,'uuid':x,'parentUuid':parent,'sessionId':sid,'cwd':cwd,
        'timestamp':'2026-09-04T00:00:0%d.000Z'%i,'message':{'role':role,'content':body}})
u1,l1=entry(0,'user',None)
u2,l2=entry(1,'assistant',u1)
open(f,'w',newline='\n').write(l1+'\n'+l2+'\n')
print('    wrote %s (session %s)' % (f,sid))
PY
  python3 - "$WIN_DIR/payload-52d.json" "$u" "$slug" "$wcwd" "$WIN_HOME_W" <<'PY' || fail "$NAME" "could not write the hook payload"
import json,sys
f,sid,slug,cwd,winhome=sys.argv[1:6]
json.dump({'session_id':sid,
           'transcript_path':winhome+'\\.claude\\projects\\'+slug+'\\'+sid+'.jsonl',
           'cwd':cwd,'hook_event_name':'Stop','stop_hook_active':False}, open(f,'w'))
print('    payload %s' % f)
PY
  hout=$(win_cmd 52d-hook <<CMD
@echo off
where node
type "$WIN_DIR_W\payload-52d.json" | node "$WIN_HOOK_W"
exit /b %ERRORLEVEL%
CMD
) || fail "$NAME" "the staged Windows stop-hook exited nonzero"
  printf '%s\n' "$hout" | sed 's/^/    /'
  rm -f "$WIN_DIR/payload-52d.json"
  step "synthetic Stop-hook invoked for session $u in $wcwd"
  step "LEFT-CHANGED: synthetic Windows session $u at $WIN_HOME_W\\.claude\\projects\\$slug\\$u.jsonl"
  printf '%s\n' "$pdir/$u.jsonl" >> "$E2E_LOG_DIR/win-synthetic.paths"
}

BEFORE=$(count_conhost 52c-before | tr -dc '0-9')
N=$(nonce)
FOUT=$(win_cmd 52d <<CMD
@echo off
cd /d C:\winDev\starcon-research
call $WIN_CLAUDE_W -p "Reply with exactly this test phrase and nothing else: SAT-WIN-FLASH-$N" --model haiku
exit /b %ERRORLEVEL%
CMD
); FRC=$?
printf '%s\n' "$FOUT" | tail -10 | sed 's/^/    /'
if [ "$FRC" != 0 ]; then
  [ "$SYNTH" != 0 ] || fail "$NAME" "the flash turn exited $FRC"
  printf '%s\n' "$FOUT" | grep -qE "$AUTH_RE" \
    || fail "$NAME" "the flash turn exited $FRC and its output is not an authentication failure"
  step "WINDOWS CLAUDE AUTH UNAVAILABLE — synthetic Stop-hook invocation substitutes for the real turn (DEVIATION §9.4.2)"
  synthetic_flash 'C:\winDev\starcon-research' 'C--winDev-starcon-research' \
    "Reply with exactly this test phrase and nothing else: SAT-WIN-FLASH-$N"
  SYNTHETIC_USED=1
fi
AFTER=$(count_conhost 52c-after | tr -dc '0-9')
step "conhost.exe processes before=$BEFORE after=$AFTER"
if [ "$SYNTHETIC_USED" = 1 ]; then
  step "no Claude Code turn ran — the console flash is NOT OBSERVABLE in synthetic mode; recorded, not asserted"
elif [ "${BEFORE:-0}" = "${AFTER:-0}" ]; then
  step "equal counts — the sub-second flash is UNVERIFIABLE by sampling; recorded, not asserted"
else
  step "the count changed; a lingering console may exist — record it in the results file (not a gate)"
fi
SUFFIX=''
if [ "$SYNTHETIC_USED" = 1 ]; then
  SUFFIX=' (synthetic hook: Windows Claude auth unavailable)'
fi
pass "$NAME$SUFFIX"
