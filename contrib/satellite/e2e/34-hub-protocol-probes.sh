#!/usr/bin/env bash
# 34-hub-protocol-probes.sh — spec §9.2.5: live wire probes from the laptop
# with curl and the real tokens.
#
# The tokens are read into the REMOTE shell from stdin (`read -r`); they never
# appear in this script, in its log, or on a local command line. Every probe
# carries `X-Recall-Wire: 1` (server.ts:360 answers 426 BEFORE auth) and every
# append carries the MANDATORY `X-Recall-Meta` header as UNPADDED base64url
# (protocol.ts:152-162). Probe bodies are two `{"type":"probe"}` lines, not
# transcript entries, so the ingester finds zero records and no row lands.
#
# Run this BEFORE 50-win-install.sh: it re-issues the silverera2 token.
source "$(dirname "$0")/lib.sh"
set -u
NAME=34-hub-protocol-probes
exec > >(tee -a "$(log_file "$NAME")") 2>&1

load_tokens both
require_hub_up
LAP_MIRROR=$(mirror_dir "$LAPTOP_HOST" claude)
WIN_MIRROR=$(mirror_dir "$WIN_HOST" claude)

remote_probes=$(cat <<REMOTE
read -r T
read -r TW
set -u
U1=\$(uuidgen); U2=\$(uuidgen)
P1=projects/-tmp-proto/\$U1.jsonl
P2=projects/-tmp-proto/\$U2.jsonl
B=/tmp/recall-proto-body.jsonl
printf '{"type":"probe"}\n{"type":"probe"}\n' > \$B
BIG=/tmp/recall-proto-big.bin
head -c \$((8*1024*1024+1)) /dev/zero > \$BIG
META=\$(printf '%s' '{"cwd":"/tmp/recall-proto"}' | base64 -w0 | tr '+/' '-_' | tr -d '=')
RESET=\$(printf '%s' '{"cwd":"/tmp/recall-proto","reset":true}' | base64 -w0 | tr '+/' '-_' | tr -d '=')
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "\$1"; }
E1=\$(enc "\$P1"); E2=\$(enc "\$P2")
A=$HUB_URL/v1/push/append
say() { printf '%s=%s body=%s\n' "\$1" "\$2" "\$(head -c 200 /tmp/pbody | tr -d '\n')"; }
code() { curl -s -o /tmp/pbody -w '%{http_code}' -H 'Expect:' -H 'X-Recall-Wire: 1' "\$@"; }

C=\$(code -X PUT "\$A?vendor=claude&offset=0&path=\$E1" -H "Authorization: Bearer \$T" -H "X-Recall-Meta: \$META" --data-binary @\$B); say p1_append200 "\$C"
C=\$(code -X PUT "\$A?vendor=claude&offset=0&path=\$E1" -H "Authorization: Bearer \$T" -H "X-Recall-Meta: \$META" --data-binary @\$B); say p2_repeat409 "\$C"
C=\$(code -X PUT "\$A?vendor=claude&offset=0&path=\$E1" -H "Authorization: Bearer \$T" -H "X-Recall-Meta: \$RESET" --data-binary @\$B); say p3_reset200 "\$C"
C=\$(code -X PUT "\$A?vendor=claude&offset=0&path=\$E1" -H "Authorization: Bearer \$T" -H "X-Recall-Meta: \$META" --data-binary @\$BIG); say p4_toolarge413 "\$C"
C=\$(code -X PUT "\$A?vendor=claude&offset=0&path=\$(enc '../x.jsonl')" -H "Authorization: Bearer \$T" -H "X-Recall-Meta: \$META" --data-binary @\$B); say p5_traversal400 "\$C"
C=\$(code -X PUT "\$A?vendor=claude&offset=0&path=\$E1" -H 'Authorization: Bearer bad' -H "X-Recall-Meta: \$META" --data-binary @\$B); say p6_badtoken401 "\$C"
C=\$(code -X POST $HUB_URL/v1/query -H "Authorization: Bearer \$T" -H 'Content-Type: application/json' --data-binary '{"argv":["install"],"cwd":"/tmp"}'); say p7_installargv400 "\$C"
C=\$(curl -s -o /tmp/pbody -w '%{http_code}' -H 'Expect:' -H 'X-Recall-Wire: 99' -X PUT "\$A?vendor=claude&offset=0&path=\$E1" -H "Authorization: Bearer \$T" -H "X-Recall-Meta: \$META" --data-binary @\$B); say p8_wire99_426 "\$C"
C=\$(code -X PUT "\$A?vendor=claude&offset=0&path=\$E2" -H "Authorization: Bearer \$TW" -H "X-Recall-Meta: \$META" --data-binary @\$B); say p9_win200 "\$C"
printf 'winpath=%s\n' "\$P2"
rm -f \$B \$BIG /tmp/pbody
REMOTE
)

OUT=$(printf '%s\n%s\n' "$RECALL_E2E_TOKEN" "$RECALL_E2E_TOKEN_WIN" | lap_stdin "$remote_probes") \
  || fail "$NAME" "the remote probe batch failed"
printf '%s\n' "$OUT" | sed 's/^/    /'

expect() { # $1 label, $2 wanted code
  local got
  got=$(printf '%s\n' "$OUT" | grep "^$1=" | head -1 | sed -E "s/^$1=([0-9]+).*/\1/")
  [ "$got" = "$2" ] || fail "$NAME" "$1: expected HTTP $2, observed ${got:-<none>}"
}
expect p1_append200 200
expect p2_repeat409 409
expect p3_reset200 200
expect p4_toolarge413 413
expect p5_traversal400 400
expect p6_badtoken401 401
expect p7_installargv400 400
expect p8_wire99_426 426
expect p9_win200 200
printf '%s\n' "$OUT" | grep '^p1_append200=' | grep -q '"size"' || fail "$NAME" "the 200 append body carries no size"
printf '%s\n' "$OUT" | grep '^p2_repeat409=' | grep -q '"size"' || fail "$NAME" "the 409 body carries no size"
printf '%s\n' "$OUT" | grep '^p5_traversal400=' | grep -q 'path' || fail "$NAME" "the traversal 400 body does not blame the path"

SUP=$(find "$LAP_MIRROR/projects/-tmp-proto" -name '*.superseded-*' 2>/dev/null | head -3)
step "superseded siblings: ${SUP:-<none>}"
[ -n "$SUP" ] || fail "$NAME" "the reset probe left no .superseded- sibling under $LAP_MIRROR/projects/-tmp-proto"

WINPATH=$(printf '%s\n' "$OUT" | grep '^winpath=' | cut -d= -f2)
PID_BEFORE=$(systemctl --user show -p MainPID --value recall-hub)
step "daemon MainPID before the revoke: $PID_BEFORE"
REV=$("$RECALL_BIN" hub token --revoke "$WIN_HOST") || fail "$NAME" "hub token --revoke $WIN_HOST failed"
printf '%s\n' "$REV" | sed 's/^/    /' 

remote_after=$(cat <<REMOTE2
read -r TW
set -u
B=/tmp/recall-proto-body.jsonl
printf '{"type":"probe"}\n{"type":"probe"}\n' > \$B
META=\$(printf '%s' '{"cwd":"/tmp/recall-proto"}' | base64 -w0 | tr '+/' '-_' | tr -d '=')
E=\$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' '$WINPATH')
C=\$(curl -s -o /dev/null -w '%{http_code}' -H 'Expect:' -H 'X-Recall-Wire: 1' -X PUT "$HUB_URL/v1/push/append?vendor=claude&offset=0&path=\$E" -H "Authorization: Bearer \$TW" -H "X-Recall-Meta: \$META" --data-binary @\$B)
printf 'p10_revoked401=%s\n' "\$C"
rm -f \$B
REMOTE2
)
OUT2=$(printf '%s\n' "$RECALL_E2E_TOKEN_WIN" | lap_stdin "$remote_after") || fail "$NAME" "the post-revoke probe failed"
printf '%s\n' "$OUT2" | sed 's/^/    /'
printf '%s\n' "$OUT2" | grep -q '^p10_revoked401=401' || fail "$NAME" "the revoked token was not answered with 401"
PID_AFTER=$(systemctl --user show -p MainPID --value recall-hub)
step "daemon MainPID after the revoke: $PID_AFTER"
[ "$PID_BEFORE" = "$PID_AFTER" ] || fail "$NAME" "the daemon restarted ($PID_BEFORE → $PID_AFTER); the revoke must need no restart"

OUT3=$("$RECALL_BIN" hub token --host "$WIN_HOST") || fail "$NAME" "re-issuing the $WIN_HOST token failed"
NEWTOK=$(printf '%s\n' "$OUT3" | grep -E '^[0-9a-f]{64}$' | head -1)
[ -n "$NEWTOK" ] || fail "$NAME" "could not parse the re-issued token"
write_token_file "$RECALL_E2E_TOKEN" "$NEWTOK"
unset NEWTOK OUT3

rm -rf "$LAP_MIRROR/projects/-tmp-proto" "$WIN_MIRROR/projects/-tmp-proto"
rmdir --ignore-fail-on-non-empty "$WIN_MIRROR/projects" "$WIN_MIRROR" "$HOME/.recall/remote/$WIN_HOST" 2>/dev/null || true
step "probe mirrors removed; $WIN_HOST mirror root present: $([ -e "$HOME/.recall/remote/$WIN_HOST" ] && echo yes || echo no)"
[ ! -e "$HOME/.recall/remote/$WIN_HOST" ] || fail "$NAME" "a $WIN_HOST mirror directory survived the cleanup"
# DEVIATION: §9.2.5 — hub status lists a host from run/hub-hosts.json even after its mirror directory is removed (cli.ts:204); asserted mirror-root absence and 'files 0' instead of the absence of the Host block.
BLOCK=$("$RECALL_BIN" hub status | grep -A1 "^Host $WIN_HOST:" || true)
if [ -n "$BLOCK" ]; then
  printf '%s\n' "$BLOCK" | sed 's/^/    /'
  printf '%s\n' "$BLOCK" | grep -q 'files 0,' \
    || fail "$NAME" "the $WIN_HOST mirror is not empty before script 50"
  step "hub status keeps a Host $WIN_HOST block from run/hub-hosts.json; it reports files 0"
else
  step "hub status prints no Host $WIN_HOST block"
fi
pass "$NAME"
