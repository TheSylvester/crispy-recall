#!/usr/bin/env bash
# 20-hub-precondition.sh — spec §9.0 (also re-run as §9.5.1 after the build).
# Proves that `claude -p` fires the Stop hook on this build of the hub: a nonce
# spoken to Haiku must land in the live database WITHOUT anyone running
# `recall` (a bare `recall <q>` would run the T1 catch-up itself).
source "$(dirname "$0")/lib.sh"
set -u
NAME=20-hub-precondition
exec > >(tee -a "$(log_file "$NAME")") 2>&1

step "node:   $("$NODE" -e 'console.log(process.version)')"
step "recall: $("$RECALL_BIN" --version 2>&1 | head -1)"

N=$(nonce)
step "nonce HUB-$N"
claude -p "Reply with exactly: HUB-$N" --model haiku || fail "$NAME" "claude -p exited nonzero"
step "claude -p returned 0; waiting 10 s for the Stop hook"
sleep 10

C=$(hub_sql "SELECT COUNT(*) FROM messages WHERE message_text LIKE '%HUB-$N%'")
step "rows matching HUB-$N: $C"
[ "${C:-0}" -ge 1 ] || fail "$NAME" "no row carries HUB-$N — the Stop hook did not ingest the turn"
pass "$NAME"
