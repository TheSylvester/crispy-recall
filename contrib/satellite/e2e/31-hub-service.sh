#!/usr/bin/env bash
# 31-hub-service.sh — spec §9.2.2: hand the daemon over to systemd and prove it
# from the laptop.
#
# DEVIATION: §9.2.2 — the §9.2.1 --detach daemon is stopped before
# install-service (run/hub.json is single-owner: HubRuntime.acquire,
# runtime.ts:118-142, refuses a second daemon while the recorded pid is alive,
# and the unit's ExecStart is a bare `hub serve`, service.ts:31).
# DEVIATION: §9.2.2 — doctor's per-host rows come from mirrorHosts()
# (directories under ~/.recall/remote/), not from the token store, so before the
# first push doctor lists NO hosts. Here we assert the token NAMES via
# `hub status` and `Daemon: alive`; the host rows are asserted in 41 and 51.
source "$(dirname "$0")/lib.sh"
set -u
NAME=31-hub-service
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_e2e_env RECALL_E2E_HUB_ADDR RECALL_E2E_LAPTOP RECALL_E2E_LAPTOP_HOST RECALL_E2E_WIN_HOST

UNIT_PID=$(systemctl --user show -p MainPID --value recall-hub 2>/dev/null || echo 0)
DETACHED=$(python3 - "$HOME/.recall/run/hub.json" <<'PY'
import json,os,sys
try: print(json.load(open(sys.argv[1])).get('pid',''))
except Exception: print('')
PY
)
step "run/hub.json pid=${DETACHED:-none} systemd MainPID=${UNIT_PID:-0}"
if [ -n "$DETACHED" ] && [ "$DETACHED" != "${UNIT_PID:-0}" ] && kill -0 "$DETACHED" 2>/dev/null; then
  kill -TERM "$DETACHED" || fail "$NAME" "could not signal the detached hub pid $DETACHED"
  wait_until 15 "! hub_health | grep -q '\"ok\":true'" || fail "$NAME" "the detached hub pid $DETACHED still answers after SIGTERM"
  step "stopped detached hub pid $DETACHED to hand ownership to systemd"
fi

if [ "$(systemctl --user is-active recall-hub 2>/dev/null)" = active ]; then
  step "recall-hub is already active — skipping install-service"
else
  "$RECALL_BIN" hub install-service || fail "$NAME" "hub install-service exited nonzero"
fi
wait_until 20 '[ "$(systemctl --user is-active recall-hub 2>/dev/null)" = active ]' \
  || fail "$NAME" "recall-hub did not become active within 20 s"
wait_until 15 "hub_health | grep -q '\"ok\":true'" || fail "$NAME" "the unit is active but /v1/health does not answer"
step "systemd MainPID now $(systemctl --user show -p MainPID --value recall-hub)"

H=$(lap "curl -s -m 5 $HUB_URL/v1/health") || fail "$NAME" "curl from the laptop failed"
step "laptop sees: $H"
for f in '"ok":true' '"wire":1' '"binary":true' '"model":true'; do
  printf '%s' "$H" | grep -q -- "$f" || fail "$NAME" "the laptop's /v1/health body lacks $f"
done

S=$("$RECALL_BIN" hub status) || fail "$NAME" "hub status exited nonzero"
TOKENS=$(printf '%s\n' "$S" | grep '^Tokens:')
step "$TOKENS"
printf '%s' "$TOKENS" | grep -q "$LAPTOP_HOST" || fail "$NAME" "hub status Tokens: does not name $LAPTOP_HOST"
printf '%s' "$TOKENS" | grep -q "$WIN_HOST" || fail "$NAME" "hub status Tokens: does not name $WIN_HOST"

D=$("$RECALL_BIN" doctor 2>&1) || true
printf '%s\n' "$D" | grep -q 'Hub (satellite mode)' || fail "$NAME" "doctor prints no 'Hub (satellite mode)' section"
DAEMON=$(printf '%s\n' "$D" | grep '^Daemon:')
step "doctor → $DAEMON"
printf '%s' "$DAEMON" | grep -q 'alive (pid' || fail "$NAME" "doctor does not report the hub daemon as alive"
pass "$NAME"
