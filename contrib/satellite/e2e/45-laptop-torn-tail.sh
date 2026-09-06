#!/usr/bin/env bash
# 45-laptop-torn-tail.sh — spec §9.3.7: a half-written last line is not
# ingested, and the completed line is picked up by the next push.
#
# The transcript is SYNTHETIC with FRESH uuids: a copy of an already-pushed file
# would insert zero rows, because message_id is the entry uuid and a global PK
# under INSERT OR IGNORE. The entry shape (type, uuid, parentUuid, sessionId,
# cwd, timestamp, message:{role,content}) is copied from `claudeEntry()` in
# test/integration/helpers/hub-harness.ts:280-291 — the repo has no
# test/fixtures directory.
source "$(dirname "$0")/lib.sh"
set -u
NAME=45-laptop-torn-tail
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_e2e_env RECALL_E2E_HUB_ADDR RECALL_E2E_LAPTOP RECALL_E2E_LAPTOP_HOST

require_hub_up
lap 'test -f ~/.recall/satellite-token' || fail "$NAME" "the laptop is not installed in satellite mode — run 40-laptop-install.sh first"
P="export PATH=\"$LAPTOP_PATH_PREFIX:\$PATH\"; "
N=$(nonce)
U=$(lap 'uuidgen') || fail "$NAME" "uuidgen failed on the laptop"
U=$(printf '%s' "$U" | tr -d '[:space:]')
step "synthetic session $U, nonce TORN-$N"

lap "python3 - <<'PY'
import json,os,uuid
sid='$U'; d=os.path.expanduser('~/.claude/projects/-tmp-recall-torn')
os.makedirs(d,exist_ok=True); f=os.path.join(d,sid+'.jsonl')
def entry(i,role,text,parent):
    u=str(uuid.uuid4())
    return u, json.dumps({'type':role,'uuid':u,'parentUuid':parent,'sessionId':sid,
        'cwd':'/tmp/recall-torn','timestamp':'2026-09-04T00:00:0%d.000Z'%i,
        'message':{'role':role,'content':text}})
t='TORN-$N — a synthetic torn-tail fixture line long enough to clear the fifty character floor.'
u1,l1=entry(0,'user',t,None)
u2,l2=entry(1,'assistant',t,u1)
open(f,'w').write(l1+'\n'+l2+'\n')
u3,l3=entry(2,'user',t,u2)
open(f,'a').write(l3[:len(l3)//2])
open(os.path.expanduser('~/.recall/torn.state'),'w').write(l3)
print('file', f, 'size', os.path.getsize(f))
PY" | sed 's/^/    /' || fail "$NAME" "could not write the synthetic transcript"

lap "$P"'recall push' || fail "$NAME" "recall push failed (torn state)"
wait_until 30 "[ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"SELECT COUNT(*) FROM messages WHERE session_id='$U'\")\" = 2 ]" \
  || fail "$NAME" "expected 2 rows for $U, observed $(hub_sql "SELECT COUNT(*) FROM messages WHERE session_id='$U'")"
MPATH=$(mirror_dir "$LAPTOP_HOST" claude)/projects/-tmp-recall-torn/$U.jsonl
LSIZE=$(lap "stat -c %s ~/.claude/projects/-tmp-recall-torn/$U.jsonl")
WM=$(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path='$MPATH'")
WSIZE=$(hub_sql "SELECT last_size FROM ingest_watermark WHERE transcript_path='$MPATH'")
step "torn state: rows=2 watermark rows=$WM last_size=$WSIZE laptop size=$LSIZE"
[ "$WM" = 1 ] || fail "$NAME" "expected one watermark row for the mirror path, observed $WM"
[ "$WSIZE" = "$LSIZE" ] || fail "$NAME" "watermark last_size $WSIZE does not equal the laptop file size $LSIZE"

step "completing the torn line"
lap "python3 - <<'PY'
import os
d=os.path.expanduser('~/.claude/projects/-tmp-recall-torn')
f=os.path.join(d,'$U.jsonl')
line=open(os.path.expanduser('~/.recall/torn.state')).read()
data=open(f).read()
# drop the half line, then write it whole
data=data[:data.rfind('\n')+1]+line+'\n'
open(f,'w').write(data)
os.remove(os.path.expanduser('~/.recall/torn.state'))
print('completed, size', os.path.getsize(f))
PY" | sed 's/^/    /' || fail "$NAME" "could not complete the torn line"

lap "$P"'recall push' || fail "$NAME" "recall push failed (completed state)"
wait_until 30 "[ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"SELECT COUNT(*) FROM messages WHERE session_id='$U'\")\" = 3 ]" \
  || fail "$NAME" "expected 3 rows for $U, observed $(hub_sql "SELECT COUNT(*) FROM messages WHERE session_id='$U'")"
DIST=$(hub_sql "SELECT COUNT(DISTINCT message_id) FROM messages WHERE session_id='$U'")
WM2=$(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path='$MPATH'")
step "completed state: rows=3 distinct message_ids=$DIST watermark rows=$WM2"
[ "$DIST" = 3 ] || fail "$NAME" "distinct message ids = $DIST, expected 3"
[ "$WM2" = 1 ] || fail "$NAME" "watermark rows = $WM2, expected 1"

step "LEFT-CHANGED: synthetic torn-tail session $U (rows stay in the hub DB; the laptop file stays under ~/.claude/projects/-tmp-recall-torn until 90-teardown.sh)"
pass "$NAME"
