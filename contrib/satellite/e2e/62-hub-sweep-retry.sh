#!/usr/bin/env bash
# 62-hub-sweep-retry.sh — spec §9.5.4: the SIGUSR1 mirror sweep ingests a file
# that arrived without a PUT and without a sidecar (the NULL-key path).
#
# The entry shape is the one used in 45-laptop-torn-tail.sh, copied from
# `claudeEntry()` in test/integration/helpers/hub-harness.ts:280-291.
source "$(dirname "$0")/lib.sh"
set -u
NAME=62-hub-sweep-retry
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_e2e_env RECALL_E2E_HUB_ADDR RECALL_E2E_LAPTOP_HOST

require_hub_up
PID=$(systemctl --user show -p MainPID --value recall-hub)
[ -n "$PID" ] && [ "$PID" != 0 ] || fail "$NAME" "recall-hub has no MainPID — run 31-hub-service.sh first"

U=$(uuidgen)
D=$(mirror_dir "$LAPTOP_HOST" claude)/projects/-tmp-sweep
F=$D/$U.jsonl
mkdir -p "$D"
python3 - "$F" "$U" <<'PY' || fail "$NAME" "could not write the synthetic mirror transcript"
import json,sys,uuid
f,sid=sys.argv[1],sys.argv[2]
def entry(i,role,parent):
    u=str(uuid.uuid4())
    text='SWEEP-%s — a synthetic sweep fixture line long enough to clear the fifty character floor.' % sid[:8]
    return u, json.dumps({'type':role,'uuid':u,'parentUuid':parent,'sessionId':sid,
        'cwd':'/tmp/recall-sweep','timestamp':'2026-09-04T00:00:0%d.000Z'%i,
        'message':{'role':role,'content':text}})
u1,l1=entry(0,'user',None)
u2,l2=entry(1,'assistant',u1)
open(f,'w').write(l1+'\n'+l2+'\n')
print('    wrote',f)
PY
step "no sidecar written — this exercises the NULL-key path"

kill -USR1 "$PID" || fail "$NAME" "could not signal the daemon (pid $PID)"
step "SIGUSR1 sent to pid $PID"
wait_until 30 "[ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"SELECT COUNT(*) FROM messages WHERE session_id='$U'\")\" -ge 1 ] && [ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path='$F'\")\" = 1 ]" \
  || fail "$NAME" "the sweep did not ingest $F within 30 s (rows $(hub_sql "SELECT COUNT(*) FROM messages WHERE session_id='$U'"), watermarks $(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path='$F'"))"
step "rows for $U: $(hub_sql "SELECT COUNT(*) FROM messages WHERE session_id='$U'"), watermark rows: 1"
step "project_key of the sidecar-less rows: $(hub_sql "SELECT DISTINCT COALESCE(project_key,'NULL') FROM messages WHERE session_id='$U'")"

rm -rf "$D"
step "LEFT-CHANGED: synthetic sweep session $U (rows stay in the hub DB; rule 5 forbids DELETE FROM messages)"
SL=$("$RECALL_BIN" hub status | grep -A1 "^Host $LAPTOP_HOST:" | grep 'sidecar-less')
step "hub status → ${SL:-<no host block>}"
printf '%s' "$SL" | grep -q 'sidecar-less 0' || fail "$NAME" "hub status still reports sidecar-less files for $LAPTOP_HOST"
pass "$NAME"
