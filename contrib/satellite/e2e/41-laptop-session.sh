#!/usr/bin/env bash
# 41-laptop-session.sh — spec §9.3.2, §9.3.3 and §9.3.3b: one real laptop turn
# arrives, is keyed by repo, is vectorised, and answers a semantic query.
#
# §9.3.3b needs quiesce: no hub-local Claude or Codex turn during the window,
# because embed-pending's sweep is cross-session.
source "$(dirname "$0")/lib.sh"
set -u
NAME=41-laptop-session
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_hub_up
CRISPY_KEY=git:d30433f1268b413193c532421b123d58a63ba4b9
N=$(nonce)
step "nonce SAT-LAPTOP-$N"
lap 'cd ~/dev/crispy && claude -p "Reply with exactly this test phrase and nothing else: SAT-LAPTOP-'"$N"'" --model haiku' \
  || fail "$NAME" "claude -p exited nonzero on the laptop"

MDIR=$(mirror_dir "$LAPTOP_HOST" claude)
wait_until 30 "grep -rl 'SAT-LAPTOP-$N' '$MDIR/projects' 2>/dev/null | head -1 | grep -q ." \
  || fail "$NAME" "no mirror file under $MDIR/projects carries SAT-LAPTOP-$N within 30 s"
MFILE=$(grep -rl "SAT-LAPTOP-$N" "$MDIR/projects" | head -1)
step "mirror file: $MFILE"
[ -f "$MFILE.meta.json" ] || fail "$NAME" "no sidecar $MFILE.meta.json"
step "sidecar: $(cat "$MFILE.meta.json")"

ROWS=$(hub_sql "SELECT COUNT(*) FROM messages WHERE message_text LIKE '%SAT-LAPTOP-$N%'")
step "rows carrying the nonce: $ROWS"
[ "${ROWS:-0}" -ge 1 ] || fail "$NAME" "the turn did not reach the hub database"
SID=$(hub_sql "SELECT session_id FROM messages WHERE message_text LIKE '%SAT-LAPTOP-$N%' LIMIT 1")
KEY=$(hub_sql "SELECT DISTINCT project_key FROM messages WHERE session_id='$SID'")
PID=$(hub_sql "SELECT DISTINCT project_id FROM messages WHERE session_id='$SID'")
step "sid=$SID project_key=$KEY project_id=$PID"
[ "$KEY" = "$CRISPY_KEY" ] || fail "$NAME" "project_key is '$KEY', expected $CRISPY_KEY"
[ "$PID" = /home/sylvester/dev/crispy ] || fail "$NAME" "project_id is '$PID', expected /home/sylvester/dev/crispy"

WM=$(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path='$MFILE'")
step "ingest_watermark rows for the mirror path: $WM"
[ "$WM" = 1 ] || fail "$NAME" "expected exactly one watermark row, observed $WM"

"$RECALL_BIN" "SAT-LAPTOP-$N" --all --no-catchup | head -20 | sed 's/^/    /'
"$RECALL_BIN" "SAT-LAPTOP-$N" --all --no-catchup | grep -q "$SID" \
  || fail "$NAME" "a hub-side --all query does not find the session"

GAP="SELECT COUNT(*) FROM messages m WHERE m.session_id='$SID' AND m.retrieval_class='hot' AND m.message_text!='' AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id=m.message_id)"
VEC="SELECT COUNT(*) FROM message_vectors v JOIN messages m ON m.message_id=v.message_id WHERE m.session_id='$SID'"
wait_until 90 "[ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"$GAP\")\" = 0 ] && [ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"$VEC\")\" -ge 2 ]" \
  || fail "$NAME" "vector gap $(hub_sql "$GAP") / vectors $(hub_sql "$VEC") after 90 s"
step "vector gap 0, vectors for the session: $(hub_sql "$VEC")"

RAW=$(lap 'cd ~/dev/crispy && export PATH="$HOME/.local/bin:$PATH"; recall "SAT-LAPTOP-'"$N"'" --raw') \
  || fail "$NAME" "the forwarded --raw query failed"
TAG=$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["sessions"][0]["tag"] if d.get("sessions") else "<none>")')
step "top hit tag: $TAG"
printf '%s' "$TAG" | grep -q SEMANTIC || fail "$NAME" "the top hit tag is '$TAG'; no semantic path"

HOSTROW=$("$RECALL_BIN" doctor 2>&1 | grep "^Host $LAPTOP_HOST:")
step "doctor → ${HOSTROW:-<no host row>}"
printf '%s' "$HOSTROW" | grep -q 'daemon alive yes' || fail "$NAME" "doctor prints no live host row for $LAPTOP_HOST"
FILES=$(printf '%s' "$HOSTROW" | sed -E 's/.*files ([0-9]+).*/\1/')
[ "${FILES:-0}" -ge 1 ] || fail "$NAME" "doctor reports $FILES mirror files for $LAPTOP_HOST"

printf 'SID=%s\nNONCE=%s\nMFILE=%s\n' "$SID" "$N" "$MFILE" > "$E2E_LOG_DIR/41.vars"
step "wrote $E2E_LOG_DIR/41.vars (sid=$SID nonce=$N)"
pass "$NAME"
