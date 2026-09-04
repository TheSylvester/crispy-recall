#!/usr/bin/env bash
# 43-laptop-idempotency.sh — spec §9.3.5: a full push mirrors every transcript
# once, and the second run appends nothing.
source "$(dirname "$0")/lib.sh"
set -u
NAME=43-laptop-idempotency
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_hub_up
lap 'test -f ~/.recall/satellite-token' || fail "$NAME" "the laptop is not installed in satellite mode — run 40-laptop-install.sh first"
# `recall push --full` has a 30-minute budget on the satellite.
SSH_TIMEOUT=${RECALL_E2E_PUSH_TIMEOUT:-1900}
P='export PATH="$HOME/.local/bin:$PATH"; '
MROOT=$HOME/.recall/remote/$LAPTOP_HOST
mirror_count() { find "$MROOT" -name '*.jsonl' ! -name '*.superseded-*' 2>/dev/null | wc -l; }

LOCAL=$(lap "find ~/.claude/projects ~/.codex/sessions -name '*.jsonl' 2>/dev/null | wc -l")
LOG0=$(lap "wc -l < ~/.recall/logs/push.log 2>/dev/null || echo 0")
step "laptop transcripts: $LOCAL   push.log lines before run 1: $LOG0"

step "run 1: recall push --full"
lap "$P"'recall push --full' || fail "$NAME" "recall push --full exited nonzero (run 1)"
LOG1=$(lap "wc -l < ~/.recall/logs/push.log")
GAIN1=$((LOG1-LOG0))
MIRROR1=$(mirror_count)
ROWS1=$(hub_sql "SELECT COUNT(*) FROM messages")
WM1=$(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '$MROOT/%'")
step "run 1: push.log +$GAIN1 lines, hub mirror files $MIRROR1, hub rows $ROWS1, watermarks $WM1"
[ "$GAIN1" -ge "$LOCAL" ] || fail "$NAME" "push.log gained $GAIN1 lines for $LOCAL transcripts"
[ "$MIRROR1" = "$LOCAL" ] || fail "$NAME" "the hub mirrors $MIRROR1 files, the laptop holds $LOCAL"

step "run 2: recall push --full"
lap "$P"'recall push --full' || fail "$NAME" "recall push --full exited nonzero (run 2)"
LOG2=$(lap "wc -l < ~/.recall/logs/push.log")
GAIN2=$((LOG2-LOG1))
NEW=$(lap "tail -n $GAIN2 ~/.recall/logs/push.log")
BAD=$(printf '%s\n' "$NEW" | grep -v 'offset==size' | grep -c . || true)
step "run 2: push.log +$GAIN2 lines, of which not 'unchanged … offset==size': $BAD"
printf '%s\n' "$NEW" | head -5 | sed 's/^/    /'
[ "$GAIN2" -ge 1 ] || fail "$NAME" "run 2 logged nothing"
[ "$BAD" = 0 ] || fail "$NAME" "$BAD of run 2's $GAIN2 lines report work; every file must be unchanged"

MIRROR2=$(mirror_count)
ROWS2=$(hub_sql "SELECT COUNT(*) FROM messages")
WM2=$(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '$MROOT/%'")
step "after run 2: hub mirror files $MIRROR2, hub rows $ROWS2, watermarks $WM2"
[ "$ROWS1" = "$ROWS2" ] || fail "$NAME" "the hub row count moved ($ROWS1 → $ROWS2) on an idempotent push"
[ "$WM1" = "$WM2" ] || fail "$NAME" "the watermark count moved ($WM1 → $WM2) on an idempotent push"
[ "$MIRROR1" = "$MIRROR2" ] || fail "$NAME" "the mirror file count moved ($MIRROR1 → $MIRROR2)"
pass "$NAME"
