#!/usr/bin/env bash
# 30-hub-tokens-serve.sh — spec §9.2.1: issue both host tokens, start the
# detached daemon, assert the persisted bind/port.
#
# This is the ONLY script that passes --bind/--port to `hub serve` (cli.ts:82-90
# persists them into ~/.recall/config.json BEFORE any check) and the ONLY writer
# of the token file. issueHubToken (tokens.ts:64-74) REVOKES the host's previous
# token, so re-issuing needs both satellites re-installed: guard it behind
# RECALL_E2E_REISSUE.
source "$(dirname "$0")/lib.sh"
set -u
NAME=30-hub-tokens-serve
exec > >(tee -a "$(log_file "$NAME")") 2>&1

assert_hub_config() {
  python3 - "$HOME/.recall/config.json" "$HUB_ADDR" "$HUB_PORT" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])).get('hub')
if not c: print('config.json has no hub record'); sys.exit(1)
ok = c.get('bind')==sys.argv[2] and str(c.get('port'))==sys.argv[3]
print(f"config.json hub.bind={c.get('bind')} hub.port={c.get('port')}")
sys.exit(0 if ok else 1)
PY
}

if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("hub") else 1)' "$HOME/.recall/config.json" 2>/dev/null; then
  assert_hub_config || fail "$NAME" "the existing config.json hub record does not name $HUB_ADDR:$HUB_PORT"
fi

TOKENS_LINE=$("$RECALL_BIN" hub status 2>/dev/null | grep '^Tokens:' || true)
step "hub status → ${TOKENS_LINE:-<no daemon config yet>}"
SKIP_ISSUE=0
if [ -f "$TOKEN_FILE" ] \
   && printf '%s' "$TOKENS_LINE" | grep -q "$LAPTOP_HOST" \
   && printf '%s' "$TOKENS_LINE" | grep -q "$WIN_HOST" \
   && [ -z "${RECALL_E2E_REISSUE:-}" ]; then
  SKIP_ISSUE=1
fi

if [ "$SKIP_ISSUE" = 1 ]; then
  step "tokens already issued (not shown); re-run with RECALL_E2E_REISSUE=1 and re-install BOTH satellites to rotate"
else
  umask 077
  OUT1=$("$RECALL_BIN" hub token --host "$LAPTOP_HOST") || fail "$NAME" "hub token --host $LAPTOP_HOST failed"
  OUT2=$("$RECALL_BIN" hub token --host "$WIN_HOST") || fail "$NAME" "hub token --host $WIN_HOST failed"
  TOK1=$(printf '%s\n' "$OUT1" | grep -E '^[0-9a-f]{64}$' | head -1)
  TOK2=$(printf '%s\n' "$OUT2" | grep -E '^[0-9a-f]{64}$' | head -1)
  [ -n "$TOK1" ] && [ -n "$TOK2" ] || fail "$NAME" "could not parse a token line out of the hub token output"
  write_token_file "$TOK1" "$TOK2"
  unset TOK1 TOK2 OUT1 OUT2
fi

if hub_health | grep -q '"ok":true'; then
  step "hub already answers /v1/health — not re-serving (idempotent)"
else
  step "starting the detached daemon on $HUB_ADDR:$HUB_PORT"
  "$RECALL_BIN" hub serve --bind "$HUB_ADDR" --port "$HUB_PORT" --detach \
    || fail "$NAME" "hub serve --detach exited nonzero"
  wait_until 15 'hub_health | grep -q ok' || fail "$NAME" "the daemon did not answer /v1/health within 15 s"
fi
step "health: $(hub_health)"
assert_hub_config || fail "$NAME" "config.json hub.bind/port were not persisted as $HUB_ADDR:$HUB_PORT"
pass "$NAME"
