#!/usr/bin/env bash
# 32-hub-rekey.sh — spec §9.2.3: the two attended migrations on the hub.
#
# The orchestrator may already have run `repair --rekey-codex` in the rule-9
# bring-up order, so an already-complete / no-op answer is a PASS.
source "$(dirname "$0")/lib.sh"
set -u
NAME=32-hub-rekey
exec > >(tee -a "$(log_file "$NAME")") 2>&1

command -v "$RECALL_BIN" >/dev/null || fail "$NAME" "recall not on PATH — hub upgrade not done"

GAP_SQL="SELECT COUNT(*) FROM messages m WHERE m.retrieval_class='hot' AND m.message_text!='' AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id=m.message_id)"
FLOOR_SQL="SELECT COUNT(*) FROM messages m WHERE m.retrieval_class='hot' AND m.message_text!='' AND LENGTH(m.message_text) < 50 AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id=m.message_id)"

OUT=$("$RECALL_BIN" repair --rekey-codex --yes 2>&1) || fail "$NAME" "repair --rekey-codex exited nonzero"
printf '%s\n' "$OUT" | sed 's/^/    /'
# `repair --rekey-codex` prints ONE of two CLI lines (recall.ts:1312-1315):
#   performed → `Codex message ids re-keyed (N/M sessions re-ingested).`
#   no-op     → `Codex message ids are already re-keyed — nothing to do.`
# Both contain "re-keyed", so the no-op line is excluded explicitly; the
# migration additionally logs `vectors dropped: N`
# (installer/codex-rekey-migration.ts:186) only when it does work.
if printf '%s\n' "$OUT" | grep -q 'already re-keyed'; then
  step "already re-keyed — no drain needed"
elif printf '%s\n' "$OUT" | grep -qE 'vectors dropped|Codex message ids re-keyed \('; then
  step "the migration re-keyed sessions — waiting for the embed drain"
  FLOOR=$(hub_sql "$FLOOR_SQL")
  step "sub-50-char floor (never embedded by design, MIN_EMBED_CHARS): $FLOOR"
  LAST=$(hub_sql "$GAP_SQL"); STALL=0; I=0
  while [ "$I" -lt 600 ]; do
    sleep 10; I=$((I+10))
    NOW=$(hub_sql "$GAP_SQL")
    if [ "$NOW" -le "$FLOOR" ]; then step "gap $NOW reached the floor $FLOOR after ${I}s"; break; fi
    if [ "$NOW" -ge "$LAST" ]; then STALL=$((STALL+10)); else STALL=0; fi
    LAST=$NOW
    if [ "$STALL" -ge 120 ]; then step "gap stopped shrinking at $NOW after ${I}s"; break; fi
  done
  step "vector gap now: $(hub_sql "$GAP_SQL")"
else
  step "no re-key line recognised in the output — no drain needed"
fi

RP=$("$RECALL_BIN" repair --rekey-projects 2>&1) || fail "$NAME" "repair --rekey-projects exited nonzero"
printf '%s\n' "$RP" | sed 's/^/    /'
NULLKEY=$(hub_sql "SELECT COUNT(*) FROM messages WHERE project_key IS NULL AND project_id IS NOT NULL")
step "rows with project_id and no project_key: $NULLKEY"
[ "$NULLKEY" = 0 ] || fail "$NAME" "$NULLKEY rows still carry a project_id with a NULL project_key"

"$RECALL_BIN" doctor 2>&1 | grep -iE 'vector|embed' | sed 's/^/    doctor: /' || true
pass "$NAME"
