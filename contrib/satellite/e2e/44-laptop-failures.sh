#!/usr/bin/env bash
# 44-laptop-failures.sh — spec §9.3.6 and §9.3.6b: a wrong token, a hub outage
# and the hub-driven full-sweep recovery.
#
# This script holds the ONE write this suite makes to the live hub database:
# a DELETE of a single ingest_watermark row bound to the exact mirror path of
# the §9.3.6b fixture. Nothing else writes; no DELETE FROM messages, ever.
source "$(dirname "$0")/lib.sh"
set -u
NAME=44-laptop-failures
exec > >(tee -a "$(log_file "$NAME")") 2>&1

VARS=$E2E_LOG_DIR/41.vars
[ -f "$VARS" ] || fail "$NAME" "no $VARS — run 41-laptop-session.sh first"
# shellcheck disable=SC1090
. "$VARS"
require_hub_up
P='export PATH="$HOME/.local/bin:$PATH"; '
MDIR=$(mirror_dir "$LAPTOP_HOST" claude)
HOSTS_JSON=$HOME/.recall/run/hub-hosts.json

restart_hub() {
  systemctl --user start recall-hub 2>/dev/null
  wait_until 20 'hub_health | grep -q ok' || printf '  WARNING: the hub did not come back — start recall-hub by hand\n'
}
trap restart_hub EXIT

# --- §9.3.6 wrong token -----------------------------------------------------
step "wrong token: the bad value is written and restored inside ONE remote command"
BAD=$(lap "$P"'cp ~/.recall/satellite-token /tmp/st.bak; echo bad > ~/.recall/satellite-token; recall x 2>/tmp/err; echo rc=$?; cat /tmp/err; cp /tmp/st.bak ~/.recall/satellite-token; chmod 600 ~/.recall/satellite-token; rm -f /tmp/st.bak /tmp/err')
printf '%s\n' "$BAD" | sed 's/^/    /'
printf '%s\n' "$BAD" | grep -q '^rc=2$' || fail "$NAME" "a wrong token did not exit 2"
ERRLINES=$(printf '%s\n' "$BAD" | grep -c '^recall: hub ')
step "stderr lines beginning 'recall: hub ': $ERRLINES"
[ "$ERRLINES" = 1 ] || fail "$NAME" "expected exactly one hub error line, observed $ERRLINES"
printf '%s\n' "$BAD" | grep '^recall: hub ' | grep -q '401' || fail "$NAME" "the error line does not name 401"

# --- §9.3.6 hub outage ------------------------------------------------------
LOG0=$(lap "wc -l < ~/.recall/logs/push.log")
step "stopping recall-hub"
systemctl --user stop recall-hub || fail "$NAME" "could not stop recall-hub"
wait_until 15 '! hub_health | grep -q ok' || fail "$NAME" "the hub still answers after stop"
N=$(nonce)
step "nonce HUB-DOWN-$N (hub down)"
TSTART=$(date +%s)
lap 'cd ~/dev/crispy && claude -p "Reply with exactly this test phrase and nothing else: HUB-DOWN-'"$N"'" --model haiku' \
  || fail "$NAME" "claude -p failed on the laptop while the hub was down"
step "the turn took $(( $(date +%s) - TSTART )) s with the hub down"
wait_until 10 "lap \"tail -5 ~/.recall/logs/push.log\" | grep -q 'push-failed'" \
  || fail "$NAME" "push.log gained no push-failed line within 10 s"
lap "tail -3 ~/.recall/logs/push.log" | sed 's/^/    /'
lap "tail -3 ~/.recall/logs/push.log" | grep -q 'err=unreachable' \
  || fail "$NAME" "the push-failed line does not report 'unreachable'"
SH=$(lap "ls ~/.recall/logs/stop-hook.log 2>/dev/null | wc -l")
step "satellite stop-hook.log files: $SH"
[ "$SH" = 0 ] || fail "$NAME" "the satellite hook wrote a stop-hook.log"
LOG1=$(lap "wc -l < ~/.recall/logs/push.log")
step "push.log $LOG0 → $LOG1 lines while the hub was down"

step "starting recall-hub"
systemctl --user start recall-hub || fail "$NAME" "could not start recall-hub"
wait_until 15 'hub_health | grep -q ok' || fail "$NAME" "the hub did not come back within 15 s"
R=$(lap "cd ~/dev/crispy && $P"'recall "HUB-DOWN-'"$N"'"') || fail "$NAME" "the drain-proving query failed"
printf '%s\n' "$R" | head -8 | sed 's/^/    /'
printf '%s\n' "$R" | grep -q "HUB-DOWN-$N" || fail "$NAME" "one query after the restart does not find the queued turn"

# --- §9.3.6b full-sweep recovery -------------------------------------------
REL=${MFILE#"$MDIR"/}
LAPFILE=\~/.claude/$REL
step "fixture: mirror $MFILE   laptop ~/.claude/$REL"
step "stopping recall-hub for the 6b fixture"
systemctl --user stop recall-hub || fail "$NAME" "could not stop recall-hub"
wait_until 15 '! hub_health | grep -q ok' || fail "$NAME" "the hub still answers after stop"
lap "touch -d '-10 days' $LAPFILE" || fail "$NAME" "could not backdate the laptop transcript"
rm -f "$MFILE" "$MFILE.meta.json" || fail "$NAME" "could not remove the mirror file"
sqlite3 "$HOME/.recall/recall.db" "DELETE FROM ingest_watermark WHERE transcript_path='$MFILE'" \
  || fail "$NAME" "could not delete the watermark row"
step "removed the mirror file, its sidecar and the one watermark row"
python3 - "$HOSTS_JSON" "$LAPTOP_HOST" <<'PY' || fail "$NAME" "could not backdate lastFullManifestAt"
import json,os,sys,time,datetime
p,host=sys.argv[1],sys.argv[2]
d=json.load(open(p)) if os.path.exists(p) else {}
rec=d.setdefault(host,{})
rec['lastFullManifestAt']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=2)).isoformat().replace('+00:00','Z')
tmp=p+'.e2e-tmp'
json.dump(d,open(tmp,'w'))
os.replace(tmp,p)
print('    lastFullManifestAt for',host,'=',rec['lastFullManifestAt'])
PY
step "starting recall-hub"
systemctl --user start recall-hub || fail "$NAME" "could not start recall-hub"
wait_until 15 'hub_health | grep -q ok' || fail "$NAME" "the hub did not come back within 15 s"

N2=$(nonce)
step "one ordinary turn on the laptop (nonce SWEEP-$N2); nobody runs 'recall push --full'"
lap 'cd ~/dev/crispy && claude -p "Reply with exactly this test phrase and nothing else: SWEEP-'"$N2"'" --model haiku' \
  || fail "$NAME" "claude -p failed on the laptop"
wait_until 60 "[ -f '$MFILE' ] && [ \"\$(sqlite3 -readonly '$HOME/.recall/recall.db' \"SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path='$MFILE'\")\" = 1 ]" \
  || fail "$NAME" "the deleted mirror file did not come back with a watermark row within 60 s"
step "mirror file restored: $(ls -l "$MFILE" | awk '{print $5" bytes"}'); watermark rows: $(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path='$MFILE'")"
ROWS=$(hub_sql "SELECT COUNT(*) FROM messages WHERE message_text LIKE '%SAT-LAPTOP-$NONCE%'")
step "rows still carrying SAT-LAPTOP-$NONCE: $ROWS"
[ "${ROWS:-0}" -ge 1 ] || fail "$NAME" "the recovered session has no rows"
pass "$NAME"
