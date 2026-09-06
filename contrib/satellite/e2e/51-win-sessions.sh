#!/usr/bin/env bash
# 51-win-sessions.sh — spec §9.4.2 (a)(b) plus the §9.3.3b vectorisation
# assertions for both Windows sessions.
#
# (a) proves the folded path key for a non-git directory, (b) proves the
# cross-host git key and a hub-only phrase answered without --all.
# The "no double quotes" rule of spec §9.4 applies to the WSL→cmd.exe INTEROP
# command line only (lib.sh win_cmd); a .cmd file BODY may quote freely, so the
# prompt and the search phrase are each ONE quoted argument. Nonces stay
# space-free.
#
# DEVIATION §9.4.2 — when Windows Claude Code cannot authenticate (the owner is
# AFK and the OAuth session cannot be refreshed), the turn falls back to a
# SYNTHETIC Stop-hook invocation: this script writes a two-entry transcript into
# the real Claude Code project directory and pipes the payload Claude Code would
# send into the STAGED stop-hook.js under the Windows user's .recall. Every hub-side
# assertion below is unchanged. What that proves and does not prove is written
# up in README.md. RECALL_E2E_WIN_SYNTHETIC=0 turns the fallback off.
source "$(dirname "$0")/lib.sh"
set -u
NAME=51-win-sessions
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_e2e_env RECALL_E2E_HUB_ADDR RECALL_E2E_WIN_HOST RECALL_E2E_WIN_USER
require_hub_up
[ -e "$WIN_HOME/.recall/config.json" ] || fail "$NAME" "Windows satellite not installed — run 50-win-install.sh first"
# The git project_key of RECALL_E2E_LAPTOP_REPO / the Windows checkout of the
# same repo. Override it when the fixture repo is not crispy.
CRISPY_KEY=${RECALL_E2E_REPO_GIT_KEY:-git:d30433f1268b413193c532421b123d58a63ba4b9}
PHRASE=${RECALL_E2E_HUB_ONLY_PHRASE:-VACUUM INTO snapshot of the recall database}
N=$(nonce)
MDIR=$(mirror_dir "$WIN_HOST" claude)
SYNTH=${RECALL_E2E_WIN_SYNTHETIC:-auto}
AUTH_RE='Failed to authenticate|OAuth|not logged in|/login'
SYNTHETIC_USED=0

vector_gate() { # $1 session id
  local gap vec
  gap="SELECT COUNT(*) FROM messages m WHERE m.session_id='$1' AND m.retrieval_class='hot' AND m.message_text!='' AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id=m.message_id)"
  vec="SELECT COUNT(*) FROM message_vectors v JOIN messages m ON m.message_id=v.message_id WHERE m.session_id='$1'"
  wait_until 90 "[ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"$gap\")\" = 0 ] && [ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"$vec\")\" -ge 2 ]" \
    || fail "$NAME" "session $1: vector gap $(hub_sql "$gap"), vectors $(hub_sql "$vec") after 90 s"
  step "session $1 vectorised: gap 0, vectors $(hub_sql "$vec")"
}

# synthetic_turn <tag> <windows cwd> <project slug> <prompt text>
# Writes a two-entry transcript where Claude Code would have written one, then
# invokes the STAGED hook with the payload Claude Code sends. The satellite
# branch of src/hooks/stop-hook.ts reads session_id + transcript_path (:90-99)
# and cwd (:122-129), and returns at once on stop_hook_active (:111);
# hook_event_name is sent for fidelity and is not read.
synthetic_turn() {
  local tag=$1 wcwd=$2 slug=$3 prompt=$4 u pdir
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
  python3 - "$WIN_DIR/payload-$tag.json" "$u" "$slug" "$wcwd" "$WIN_HOME_W" <<'PY' || fail "$NAME" "could not write the hook payload"
import json,sys
f,sid,slug,cwd,winhome=sys.argv[1:6]
json.dump({'session_id':sid,
           'transcript_path':winhome+'\\.claude\\projects\\'+slug+'\\'+sid+'.jsonl',
           'cwd':cwd,'hook_event_name':'Stop','stop_hook_active':False}, open(f,'w'))
print('    payload %s' % f)
PY
  local hout
  hout=$(win_cmd "$tag-hook" <<CMD
@echo off
where node
type "$WIN_DIR_W\payload-$tag.json" | node "$WIN_HOOK_W"
exit /b %ERRORLEVEL%
CMD
) || fail "$NAME" "the staged Windows stop-hook exited nonzero"
  printf '%s\n' "$hout" | sed 's/^/    /'
  rm -f "$WIN_DIR/payload-$tag.json"
  step "synthetic Stop-hook invoked for session $u in $wcwd"
  step "LEFT-CHANGED: synthetic Windows session $u at $WIN_HOME_W\\.claude\\projects\\$slug\\$u.jsonl"
  printf '%s\n' "$pdir/$u.jsonl" >> "$E2E_LOG_DIR/win-synthetic.paths"
}

# win_claude_turn <tag> <windows cwd> <project slug> <prompt text>
win_claude_turn() {
  local tag=$1 wcwd=$2 slug=$3 prompt=$4 out rc
  out=$(win_cmd "$tag" <<CMD
@echo off
cd /d $wcwd
call $WIN_CLAUDE_W -p "$prompt" --model haiku
exit /b %ERRORLEVEL%
CMD
); rc=$?
  printf '%s\n' "$out" | tail -15 | sed 's/^/    /'
  [ "$rc" = 0 ] && return 0
  [ "$SYNTH" != 0 ] || fail "$NAME" "the Windows turn ($tag) exited $rc"
  printf '%s\n' "$out" | grep -qE "$AUTH_RE" \
    || fail "$NAME" "the Windows turn ($tag) exited $rc and its output is not an authentication failure"
  step "WINDOWS CLAUDE AUTH UNAVAILABLE — synthetic Stop-hook invocation substitutes for the real turn (DEVIATION §9.4.2)"
  synthetic_turn "$tag" "$wcwd" "$slug" "$prompt"
  SYNTHETIC_USED=1
}

step "(a) non-git path key — nonce SAT-WIN-$N"
win_claude_turn 51a 'C:\winDev\starcon-research' 'C--winDev-starcon-research' \
  "Reply with exactly this test phrase and nothing else: SAT-WIN-$N"
wait_until 60 "grep -rl 'SAT-WIN-$N' '$MDIR/projects' 2>/dev/null | head -1 | grep -q ." \
  || fail "$NAME" "no mirror file under $MDIR/projects carries SAT-WIN-$N within 60 s"
FA=$(grep -rl "SAT-WIN-$N" "$MDIR/projects" | head -1)
step "mirror file: $FA"
printf '%s' "$FA" | grep -q '/projects/C--winDev-starcon-research/' \
  || fail "$NAME" "the mirror path is not under projects/C--winDev-starcon-research/"
[ -f "$FA.meta.json" ] || fail "$NAME" "no sidecar beside $FA"

SIDA=$(hub_sql "SELECT session_id FROM messages WHERE message_text LIKE '%SAT-WIN-$N%' LIMIT 1")
KEYA=$(hub_sql "SELECT DISTINCT project_key FROM messages WHERE session_id='$SIDA'")
PIDA=$(hub_sql "SELECT DISTINCT project_id FROM messages WHERE session_id='$SIDA'")
step "sid=$SIDA project_id=$PIDA project_key=$KEYA"
[ "$PIDA" = 'c:/winDev/starcon-research' ] || fail "$NAME" "project_id is '$PIDA', expected c:/winDev/starcon-research"
[ "$KEYA" = 'path:c:/windev/starcon-research' ] || fail "$NAME" "project_key is '$KEYA', expected path:c:/windev/starcon-research"

step "(b) cross-host git key — nonce SAT-WIN-GIT-$N"
win_claude_turn 51b 'C:\winDev\crispy' 'C--winDev-crispy' \
  "Reply with exactly this test phrase and nothing else: SAT-WIN-GIT-$N"
wait_until 60 "[ -n \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"SELECT session_id FROM messages WHERE message_text LIKE '%SAT-WIN-GIT-$N%' LIMIT 1\")\" ]" \
  || fail "$NAME" "no hub row carries SAT-WIN-GIT-$N within 60 s"
SIDB=$(hub_sql "SELECT session_id FROM messages WHERE message_text LIKE '%SAT-WIN-GIT-$N%' LIMIT 1")
KEYB=$(hub_sql "SELECT DISTINCT project_key FROM messages WHERE session_id='$SIDB'")
step "sid=$SIDB project_key=$KEYB"
[ "$KEYB" = "$CRISPY_KEY" ] || fail "$NAME" "project_key is '$KEYB', expected $CRISPY_KEY"

step "(b) a hub-only phrase answered from C:\\winDev\\crispy without --all"
OUTC=$(win_cmd 51c <<CMD
@echo off
cd /d C:\winDev\crispy
call $WIN_RECALL_W "$PHRASE"
exit /b %ERRORLEVEL%
CMD
) || fail "$NAME" "the Windows forwarded query exited nonzero"
printf '%s\n' "$OUTC" | head -12 | sed 's/^/    /'
HITS=$(printf '%s\n' "$OUTC" | rows)
step "hub-authored crispy sessions visible from Windows without --all: $HITS"
[ "$HITS" -ge 1 ] || fail "$NAME" "the cross-host git key returned no hub sessions for '$PHRASE'"

vector_gate "$SIDA"
vector_gate "$SIDB"

HOSTROW=$("$RECALL_BIN" doctor 2>&1 | grep "^Host $WIN_HOST:")
step "doctor → ${HOSTROW:-<no host row>}"
printf '%s' "$HOSTROW" | grep -q 'daemon alive yes' || fail "$NAME" "doctor prints no live host row for $WIN_HOST"

printf 'WIN_NONCE=%s\nWIN_SID_PATH=%s\nWIN_SID_GIT=%s\nWIN_SYNTHETIC=%s\nWIN_SYNTHETIC_PATHS=%s\n' \
  "$N" "$SIDA" "$SIDB" "$SYNTHETIC_USED" "$E2E_LOG_DIR/win-synthetic.paths" > "$E2E_LOG_DIR/51.vars"
step "wrote $E2E_LOG_DIR/51.vars (WIN_NONCE=$N, WIN_SYNTHETIC=$SYNTHETIC_USED)"
SUFFIX=''
if [ "$SYNTHETIC_USED" = 1 ]; then
  SUFFIX=' (synthetic hook: Windows Claude auth unavailable)'
fi
pass "$NAME$SUFFIX"
