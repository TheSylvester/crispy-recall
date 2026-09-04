#!/usr/bin/env bash
# 33-hub-hardening.sh — spec §9.2.4: a tokenless non-loopback bind is refused,
# and the unit restarts after SIGKILL.
#
# The probe is the spec's own FLAG-LESS `hub serve`: bind and port come from
# config.json. NEVER pass --bind/--port here — cli.ts:82-90 persists them into
# the live config BEFORE any check, and the systemd unit would then bind the
# wrong port.
source "$(dirname "$0")/lib.sh"
set -u
NAME=33-hub-hardening
exec > >(tee -a "$(log_file "$NAME")") 2>&1

TOK=$HOME/.recall/hub-tokens.json
STASH=/tmp/ht-33-$$
[ -f "$TOK" ] || fail "$NAME" "no $TOK — run 30-hub-tokens-serve.sh first"
require_hub_up

restore() { [ -f "$STASH" ] && mv -f "$STASH" "$TOK"; }
trap restore EXIT

mv "$TOK" "$STASH" || fail "$NAME" "could not move the token store aside"
step 'token store moved aside; probing a flag-less hub serve'
PROBE=$(timeout 3 "$NODE" "$HOME/.recall/bin/recall.js" hub serve 2>&1); RC=$?
printf '%s\n' "$PROBE" | sed 's/^/    /'
step "probe rc=$RC"
[ "$RC" != 0 ] || fail "$NAME" 'a tokenless non-loopback hub serve exited 0'
[ "$RC" != 124 ] || fail "$NAME" "the tokenless probe did not exit within 3 s"
printf '%s\n' "$PROBE" | grep -q 'recall hub token' || fail "$NAME" 'the refusal does not name recall hub token'
restore; trap - EXIT
step "token store restored"

python3 - "$HOME/.recall/config.json" "$HUB_ADDR" "$HUB_PORT" <<'PY' || fail "$NAME" "config.json hub.bind/port no longer name $HUB_ADDR:$HUB_PORT"
import json,sys
c=json.load(open(sys.argv[1])).get('hub') or {}
print(f"    config.json hub.bind={c.get('bind')} hub.port={c.get('port')}")
sys.exit(0 if c.get('bind')==sys.argv[2] and str(c.get('port'))==sys.argv[3] else 1)
PY
step "config.json still names $HUB_ADDR:$HUB_PORT"

PID=$(systemctl --user show -p MainPID --value recall-hub)
[ -n "$PID" ] && [ "$PID" != 0 ] || fail "$NAME" "recall-hub has no MainPID — run 31-hub-service.sh first"
step "killing MainPID $PID with SIGKILL"
kill -9 "$PID" || fail "$NAME" "kill -9 $PID failed"
sleep 8
ACTIVE=$(systemctl --user is-active recall-hub)
NEWPID=$(systemctl --user show -p MainPID --value recall-hub)
step "after 8 s: is-active=$ACTIVE MainPID=$NEWPID"
[ "$ACTIVE" = active ] || fail "$NAME" "recall-hub is $ACTIVE after SIGKILL"
hub_health | grep -q '"ok":true' || fail "$NAME" "/v1/health does not answer after the restart"
step "health: $(hub_health)"
pass "$NAME"
