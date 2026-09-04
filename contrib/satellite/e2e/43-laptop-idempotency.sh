#!/usr/bin/env bash
# 43-laptop-idempotency.sh — spec §9.3.5: a full push mirrors every transcript
# once, and the second run appends nothing.
#
# DEVIATION §9.3.5 — "row and watermark counts unchanged" is asserted over the
# files mirrored by run 1, because both the hub and the satellite are live during
# acceptance (the satellite's owner session keeps creating transcripts); a
# total-count equality is not a property of a live system.
#
# So run 1 freezes a SET of mirror paths, and every run-2 claim is made over that
# set only. Files the laptop created between the two runs are counted, printed
# and never failed on. Push.log formats used below, re-verified against
# src/satellite/push.ts at this head:
#   :626  `<ISO> pushed host=<h> vendor=<v> path=<rel> from=<n> to=<n>`
#   :530, :608  `<ISO> unchanged host=<h> vendor=<v> path=<rel> offset==size`
#   :542/:554/:573/:587/:596/:615  `<ISO> push-failed host=<h> vendor=<v> path=<rel> err=…`
#   :351/:470/:487/:502  `push-failed …` with NO `path=` (transport or manifest)
# The mirror path of a logged file is `$MROOT/<vendor>/<rel>`.
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
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mirror_count() { find "$MROOT" -name '*.jsonl' ! -name '*.superseded-*' 2>/dev/null | wc -l; }
mirror_set()   { find "$MROOT" -name '*.jsonl' ! -name '*.superseded-*' 2>/dev/null | sort; }
laptop_count() { lap "find ~/.claude/projects ~/.codex/sessions -name '*.jsonl' 2>/dev/null | wc -l"; }

# in_list <file of paths> — an SQL IN-list, single quotes doubled.
in_list() {
  python3 - "$1" <<'PY'
import sys
paths=[l.rstrip("\n") for l in open(sys.argv[1]) if l.strip()]
print(",".join("'" + p.replace("'", "''") + "'" for p in paths))
PY
}

LOCAL0=$(laptop_count)
LOG0=$(lap "wc -l < ~/.recall/logs/push.log 2>/dev/null || echo 0")
step "laptop transcripts before run 1: $LOCAL0   push.log lines: $LOG0"

step "run 1: recall push --full"
lap "$P"'recall push --full' || fail "$NAME" "recall push --full exited nonzero (run 1)"
LOG1=$(lap "wc -l < ~/.recall/logs/push.log")
GAIN1=$((LOG1-LOG0))
LOCAL1=$(laptop_count)
MIRROR1=$(mirror_count)
mirror_set > "$WORK/set1"
step "run 1: push.log +$GAIN1 lines; laptop $LOCAL0 → $LOCAL1 transcripts; hub mirror files $MIRROR1"
[ "$GAIN1" -ge "$LOCAL0" ] || fail "$NAME" "push.log gained $GAIN1 lines for $LOCAL0 transcripts"
[ "$MIRROR1" -ge "$LOCAL0" ] && [ "$MIRROR1" -le "$LOCAL1" ] \
  || fail "$NAME" "the hub mirrors $MIRROR1 files, outside the live window [$LOCAL0, $LOCAL1]"

IN=$(in_list "$WORK/set1")
[ -n "$IN" ] || fail "$NAME" "run 1 mirrored no files under $MROOT"
WMQ="SELECT transcript_path, last_size FROM ingest_watermark WHERE transcript_path IN ($IN) ORDER BY 1"
ROWQ="SELECT COUNT(*) FROM messages m JOIN session_provenance p USING(session_id) WHERE p.transcript_path IN ($IN)"
hub_sql "$WMQ" > "$WORK/wmset1"
ROWSET1=$(hub_sql "$ROWQ")
step "frozen set: $(wc -l < "$WORK/set1") mirror files, $(wc -l < "$WORK/wmset1") watermark rows, $ROWSET1 message rows"
step "whole-DB totals (information only): rows $(hub_sql 'SELECT COUNT(*) FROM messages'), mirror watermarks $(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '$MROOT/%'")"

step "run 2: recall push --full"
lap "$P"'recall push --full' || fail "$NAME" "recall push --full exited nonzero (run 2)"
LOG2=$(lap "wc -l < ~/.recall/logs/push.log")
GAIN2=$((LOG2-LOG1))
[ "$GAIN2" -ge 1 ] || fail "$NAME" "run 2 logged nothing"
lap "tail -n $GAIN2 ~/.recall/logs/push.log" > "$WORK/run2"
step "run 2: push.log +$GAIN2 lines"
head -5 "$WORK/run2" | sed 's/^/    /'

# Classify every run-2 line by the mirror path it names.
python3 - "$WORK/run2" "$WORK/set1" "$MROOT" > "$WORK/verdict" <<'PY'
import re,sys
lines=[l.rstrip("\n") for l in open(sys.argv[1]) if l.strip()]
frozen={l.rstrip("\n") for l in open(sys.argv[2]) if l.strip()}
root=sys.argv[3]
bad=[]; new=[]; other=[]; unchanged=0
for l in lines:
    v=re.search(r' vendor=(\S+)', l)
    p=re.search(r' path=(.+?)(?: (?:offset==size|from=|err=)|$)', l)
    if not v or not p:
        other.append(l); continue
    mp = "%s/%s/%s" % (root, v.group(1), p.group(1))
    if mp in frozen:
        if 'offset==size' in l: unchanged += 1
        else: bad.append(l)
    else:
        new.append(l)
print("UNCHANGED %d" % unchanged)
print("NEWFILES %d" % len(new))
for l in new[:5]: print("NEWLINE %s" % l)
print("OTHER %d" % len(other))
for l in other[:5]: print("OTHERLINE %s" % l)
print("BAD %d" % len(bad))
for l in bad[:5]: print("BADLINE %s" % l)
PY
sed 's/^/    /' "$WORK/verdict"
UNCHANGED=$(awk '/^UNCHANGED /{print $2}' "$WORK/verdict")
NEWFILES=$(awk '/^NEWFILES /{print $2}' "$WORK/verdict")
BAD=$(awk '/^BAD /{print $2}' "$WORK/verdict")
step "run 2 over the frozen set: $UNCHANGED unchanged, $BAD reporting work; $NEWFILES line(s) for transcripts the laptop created since run 1"
[ "$BAD" = 0 ] || fail "$NAME" "$BAD run-2 line(s) for frozen-set files report work; every one must be 'unchanged … offset==size'"
[ "$UNCHANGED" -ge 1 ] || fail "$NAME" "run 2 reported no frozen-set file as unchanged"
grep -q '^OTHERLINE .*push-failed' "$WORK/verdict" \
  && fail "$NAME" "run 2 logged a path-less push-failed line (transport or manifest failure)"

hub_sql "$WMQ" > "$WORK/wmset2"
ROWSET2=$(hub_sql "$ROWQ")
MIRROR2=$(mirror_count)
step "after run 2: frozen-set watermarks $(wc -l < "$WORK/wmset2"), frozen-set rows $ROWSET2, hub mirror files $MIRROR2"
step "whole-DB totals (information only): rows $(hub_sql 'SELECT COUNT(*) FROM messages'), mirror watermarks $(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '$MROOT/%'")"
diff "$WORK/wmset1" "$WORK/wmset2" > "$WORK/wmdiff" || {
  head -10 "$WORK/wmdiff" | sed 's/^/    /'
  fail "$NAME" "the watermark rows of the frozen set changed on an idempotent push"
}
[ "$ROWSET1" = "$ROWSET2" ] || fail "$NAME" "the frozen set's row count moved ($ROWSET1 → $ROWSET2) on an idempotent push"
[ "$MIRROR2" -ge "$MIRROR1" ] || fail "$NAME" "the mirror shrank ($MIRROR1 → $MIRROR2)"
pass "$NAME"
