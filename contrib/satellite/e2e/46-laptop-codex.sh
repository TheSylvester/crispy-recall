#!/usr/bin/env bash
# 46-laptop-codex.sh — spec §9.3.8: a Codex rollout is mirrored and its rows
# carry the U0 full-UUID message ids.
source "$(dirname "$0")/lib.sh"
set -u
NAME=46-laptop-codex
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_hub_up
lap 'test -f ~/.recall/satellite-token' || fail "$NAME" "the laptop is not installed in satellite mode — run 40-laptop-install.sh first"
HELP=$(lap 'codex exec --help 2>&1 | head -30')
printf '%s\n' "$HELP" | sed 's/^/    /'
USAGE=$(printf '%s\n' "$HELP" | grep -iE '^ *(usage|Usage):' | head -1)
step "relying on this usage line: ${USAGE:-<none found>}"
[ -n "$USAGE" ] || fail "$NAME" "codex exec --help printed no usage line — adjust the invocation below"

N=$(nonce)
step "nonce SAT-CODEX-$N"
lap 'cd ~/dev/crispy && codex exec "Reply with exactly this test phrase and nothing else: SAT-CODEX-'"$N"'"' \
  || fail "$NAME" "codex exec exited nonzero on the laptop"

CDIR=$(mirror_dir "$LAPTOP_HOST" codex)
wait_until 60 "grep -rl 'SAT-CODEX-$N' '$CDIR/sessions' 2>/dev/null | head -1 | grep -q ." \
  || fail "$NAME" "no rollout under $CDIR/sessions carries the nonce within 60 s"
RFILE=$(grep -rl "SAT-CODEX-$N" "$CDIR/sessions" | head -1)
step "mirrored rollout: $RFILE"
[ -f "$RFILE.meta.json" ] || fail "$NAME" "no sidecar $RFILE.meta.json"

SID=$(hub_sql "SELECT session_id FROM messages WHERE message_text LIKE '%SAT-CODEX-$N%' LIMIT 1")
[ -n "$SID" ] || fail "$NAME" "no hub row carries SAT-CODEX-$N"
TOTAL=$(hub_sql "SELECT COUNT(*) FROM messages WHERE session_id='$SID'")
GOOD=$(hub_sql "SELECT COUNT(*) FROM messages WHERE session_id='$SID' AND message_id GLOB 'codex-jsonl-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*'")
step "session $SID: $TOTAL rows, $GOOD with a full-UUID codex message id"
hub_sql "SELECT message_id FROM messages WHERE session_id='$SID' LIMIT 3" | sed 's/^/    /'
[ "$TOTAL" -ge 1 ] || fail "$NAME" "the Codex session has no rows"
[ "$GOOD" = "$TOTAL" ] || fail "$NAME" "$((TOTAL-GOOD)) of $TOTAL rows carry a legacy 8-hex message id"
pass "$NAME"
