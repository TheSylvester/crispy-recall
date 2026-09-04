#!/usr/bin/env bash
# 42-laptop-queries.sh — spec §9.3.4: forwarded queries, project scoping,
# read-by-id footers, pagination and a nonzero exit for a bogus read.
#
# DEVIATION: §9.3.4 — pagination continuation is asserted by message-seq
# markers, not by a "First: seq N" footer. `recall <sid>` (runReadSession,
# recall.ts:645, footers :639-641) never prints "First: seq"; only
# `recall <sid> <mid>` (runReadTurn, footers :771-773) does.
#
# DEVIATION §9.3.4 — "--project /tmp returns zero rows" is asserted as "the
# laptop session is out of scope and every listed session is a hub session under
# /tmp": the live hub holds hundreds of hub-local sessions run from /tmp and
# semantic retrieval returns in-scope neighbours for any query.
source "$(dirname "$0")/lib.sh"
set -u
NAME=42-laptop-queries
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_hub_up
VARS=$E2E_LOG_DIR/41.vars
[ -f "$VARS" ] || fail "$NAME" "no $VARS — run 41-laptop-session.sh first"
# shellcheck disable=SC1090
. "$VARS"
PHRASE=${RECALL_E2E_HUB_ONLY_PHRASE:-VACUUM INTO snapshot of the recall database}
P='export PATH="$HOME/.local/bin:$PATH"; '

R=$(lap "cd ~/dev/crispy && $P"'recall "SAT-LAPTOP-'"$NONCE"'"') || fail "$NAME" "the scoped query failed"
printf '%s\n' "$R" | head -10 | sed 's/^/    /'
printf '%s\n' "$R" | grep -q "$SID" || fail "$NAME" "the laptop session is not found from ~/dev/crispy without --all"

H=$(lap "cd ~/dev/crispy && $P"'recall "'"$PHRASE"'"') || fail "$NAME" "the hub-only phrase query failed"
HITS=$(printf '%s\n' "$H" | rows)
step "hub-authored crispy sessions visible from the laptop without --all: $HITS"
[ "$HITS" -ge 1 ] || fail "$NAME" "the cross-host git key returned no hub sessions for '$PHRASE'"

R2=$(lap "cd ~ && $P"'recall "SAT-LAPTOP-'"$NONCE"'" --project ~/dev/crispy') || fail "$NAME" "--project query failed"
printf '%s\n' "$R2" | grep -q "$SID" || fail "$NAME" "--project ~/dev/crispy does not find the session from ~"
R3=$(lap "cd ~ && $P"'recall "SAT-LAPTOP-'"$NONCE"'" --project /tmp'); RC3=$?
step "--project /tmp exit code: $RC3"
# A row count only means something when the query actually ran: an empty output
# would score 0 as well.
printf '%s\n' "$R3" | grep -q '^Results: ' \
  || fail "$NAME" "the --project /tmp query produced no Results: line"
N3=$(printf '%s\n' "$R3" | rows)
step "--project /tmp unique sessions: $N3"
printf '%s\n' "$R3" | grep -q "$SID" \
  && fail "$NAME" "--project /tmp returned the laptop session $SID; the scope filter leaked"
# The table row is `rank  session_id  message_id  date  tag  hits  snippet`
# (recall.ts:998-1006); ids are opaque — UUID, agent-<7hex> or
# codex-jsonl-<uuid>-<n>. Anything else on a row is not an id we can check.
IDS=$(printf '%s\n' "$R3" | awk '$1 ~ /^[0-9]+$/ && NF >= 2 { print $2 }' | sort -u)
CHECKED=0
for sid in $IDS; do
  case "$sid" in
    [0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*|agent-[0-9a-f]*|codex-jsonl-*) ;;
    *) step "skipping unrecognised table token '$sid'"; continue;;
  esac
  C=$(hub_sql "SELECT COUNT(*) FROM messages WHERE session_id='$sid' AND (project_id = '/tmp' OR project_id LIKE '/tmp/%')")
  [ "${C:-0}" -ge 1 ] || fail "$NAME" "--project /tmp listed session $sid, which has no row under /tmp"
  CHECKED=$((CHECKED+1))
done
[ "$CHECKED" -ge 1 ] || [ "$N3" = 0 ] || fail "$NAME" "--project /tmp reported $N3 sessions but no id could be parsed from the table"
step "--project /tmp: $CHECKED sessions, all under /tmp, laptop session absent"

MID=$(hub_sql "SELECT message_id FROM messages WHERE session_id='$SID' ORDER BY message_seq LIMIT 1")
step "first message id of $SID: $MID"
RT=$(lap "$P"'recall '"$SID $MID") || fail "$NAME" "recall <sid> <mid> failed"
FOOT=$(printf '%s\n' "$RT" | grep -E '^--- .* ---$' | tail -1)
step "read-turn footer: $FOOT"
printf '%s' "$FOOT" | grep -qE '^--- [0-9]+ messages, [0-9]+ chars\. First: seq [0-9]+\. End of session\. ---$' \
  || fail "$NAME" "the read-turn footer does not match the §9.3.4 form"

LSID=$(hub_sql "SELECT session_id FROM messages GROUP BY session_id HAVING COUNT(*) > 100 ORDER BY COUNT(*) DESC LIMIT 1")
step "long session for pagination: $LSID"
P1=$(lap "$P"'recall '"$LSID") || fail "$NAME" "the first page failed"
F1=$(printf '%s\n' "$P1" | grep -E '^--- .* ---$' | tail -1)
step "page 1 footer: $F1"
OFF=$(printf '%s' "$F1" | sed -E 's/^--- [0-9]+ messages, [0-9]+ chars\. Use( --reverse)? --offset ([0-9]+) to see more \([0-9]+ remaining\) ---$/\2/')
printf '%s' "$OFF" | grep -qE '^[0-9]+$' || fail "$NAME" "could not parse an --offset out of '$F1'"
LAST1=$(printf '%s\n' "$P1" | grep -oE '^\[[0-9]+\]' | tr -d '[]' | tail -1)
P2=$(lap "$P"'recall '"$LSID --offset $OFF") || fail "$NAME" "the second page failed"
FIRST2=$(printf '%s\n' "$P2" | grep -oE '^\[[0-9]+\]' | tr -d '[]' | head -1)
F2=$(printf '%s\n' "$P2" | grep -E '^--- .* ---$' | tail -1)
step "page 1 last seq=$LAST1  page 2 first seq=$FIRST2  page 2 footer: $F2"
[ -n "$LAST1" ] && [ -n "$FIRST2" ] || fail "$NAME" "could not read the [seq] markers of both pages"
[ "$FIRST2" -gt "$LAST1" ] || fail "$NAME" "page 2 starts at seq $FIRST2, not after page 1's last seq $LAST1"
printf '%s' "$F2" | grep -qE '^--- [0-9]+ messages, [0-9]+ chars\. (Use( --reverse)? --offset [0-9]+ to see more \([0-9]+ remaining\)|End of session\.) ---$' \
  || fail "$NAME" "the page 2 footer is not a runReadSession form"

RC=$(lap "$P"'recall read bogus >/dev/null 2>&1; echo $?')
step "recall read bogus exit code: $RC"
[ "$RC" != 0 ] || fail "$NAME" "recall read bogus exited 0 (DEVIATION §9.3.4 if the merged CLI answers 0 by design)"
pass "$NAME"
