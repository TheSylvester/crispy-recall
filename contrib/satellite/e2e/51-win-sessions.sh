#!/usr/bin/env bash
# 51-win-sessions.sh — spec §9.4.2 (a)(b) plus the §9.3.3b vectorisation
# assertions for both Windows sessions.
#
# (a) proves the folded path key for a non-git directory, (b) proves the
# cross-host git key and a hub-only phrase answered without --all.
# The interop command line carries NO double quotes: WSL rewrites an embedded
# `"` as a literal `\"`, which splits a `claude -p` prompt. The nonce therefore
# holds no spaces.
source "$(dirname "$0")/lib.sh"
set -u
NAME=51-win-sessions
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_hub_up
[ -e /mnt/c/Users/silve/.recall/config.json ] || fail "$NAME" "Windows satellite not installed — run 50-win-install.sh first"
CRISPY_KEY=git:d30433f1268b413193c532421b123d58a63ba4b9
PHRASE=${RECALL_E2E_HUB_ONLY_PHRASE:-VACUUM INTO snapshot of the recall database}
N=$(nonce)
MDIR=$(mirror_dir "$WIN_HOST" claude)
label_a='non-git path key'
label_b='cross-host git key' 

vector_gate() { # $1 session id
  local gap vec
  gap="SELECT COUNT(*) FROM messages m WHERE m.session_id='$1' AND m.retrieval_class='hot' AND m.message_text!='' AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id=m.message_id)"
  vec="SELECT COUNT(*) FROM message_vectors v JOIN messages m ON m.message_id=v.message_id WHERE m.session_id='$1'"
  wait_until 90 "[ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"$gap\")\" = 0 ] && [ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"$vec\")\" -ge 2 ]" \
    || fail "$NAME" "session $1: vector gap $(hub_sql "$gap"), vectors $(hub_sql "$vec") after 90 s"
  step "session $1 vectorised: gap 0, vectors $(hub_sql "$vec")"
}

step "(a) non-git path key — nonce SAT-WIN-$N"
OUT_51a=$(win_cmd 51a <<CMD
@echo off
cd /d C:\winDev\starcon-research
call $WIN_CLAUDE_W -p Reply with exactly this test phrase and nothing else: SAT-WIN-$N --model haiku
exit /b %ERRORLEVEL%
CMD
) || fail "$NAME" "the $label_a Windows turn exited nonzero"
printf '%s\n' "$OUT_51a" | tail -15 | sed 's/^/    /'
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
OUT_51b=$(win_cmd 51b <<CMD
@echo off
cd /d C:\winDev\crispy
call $WIN_CLAUDE_W -p Reply with exactly this test phrase and nothing else: SAT-WIN-GIT-$N --model haiku
exit /b %ERRORLEVEL%
CMD
) || fail "$NAME" "the $label_b Windows turn exited nonzero"
printf '%s\n' "$OUT_51b" | tail -15 | sed 's/^/    /'
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
call $WIN_RECALL_W $PHRASE
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

printf 'WIN_NONCE=%s\nWIN_SID_PATH=%s\nWIN_SID_GIT=%s\n' "$N" "$SIDA" "$SIDB" > "$E2E_LOG_DIR/51.vars"
step "wrote $E2E_LOG_DIR/51.vars (WIN_NONCE=$N)"
pass "$NAME"
