#!/usr/bin/env bash
# 43-laptop-idempotency.sh — spec §9.3.5: a full push mirrors every transcript
# once, and the second run appends nothing that was already mirrored.
#
# DEVIATION §9.3.5 — "row and watermark counts unchanged" is asserted over the
# files mirrored by run 1, because both the hub and the satellite are live during
# acceptance (the satellite's owner session keeps creating transcripts); a
# total-count equality is not a property of a live system.
#
# DEVIATION §9.3.5 — a frozen set freezes file IDENTITY, not CONTENT: the
# satellite's live session APPENDS turns to transcripts that already existed at
# run 1, so run 2 legitimately re-pushes their tail. The idempotency property
# actually asserted is therefore "run 2 re-sends no byte the hub already holds":
# a frozen-set line is accepted when it reports `offset==size`, or when it is a
# `pushed … from=<n>` whose n EQUALS the mirror file size frozen after run 1.
# Those files are counted as APPENDED and reported; the watermark byte-equality
# and the row-count equality are asserted over the frozen files that were NOT
# appended, and an appended file only has to keep growing.
#
# Push.log formats, re-verified against src/satellite/push.ts at this head:
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
laptop_count() { lap "find ~/.claude/projects ~/.codex/sessions -name '*.jsonl' 2>/dev/null | wc -l"; }

LOCAL0=$(laptop_count)
LOG0=$(lap "wc -l < ~/.recall/logs/push.log 2>/dev/null || echo 0")
step "laptop transcripts before run 1: $LOCAL0   push.log lines: $LOG0"

step "run 1: recall push --full"
lap "$P"'recall push --full' || fail "$NAME" "recall push --full exited nonzero (run 1)"
LOG1=$(lap "wc -l < ~/.recall/logs/push.log")
GAIN1=$((LOG1-LOG0))
LOCAL1=$(laptop_count)
MIRROR1=$(mirror_count)
step "run 1: push.log +$GAIN1 lines; laptop $LOCAL0 → $LOCAL1 transcripts; hub mirror files $MIRROR1"
[ "$GAIN1" -ge "$LOCAL0" ] || fail "$NAME" "push.log gained $GAIN1 lines for $LOCAL0 transcripts"
# Lower bound only: the mirror is append-only and is never pruned when a laptop
# transcript is deleted, so it may legitimately exceed the laptop's count.
[ "$MIRROR1" -ge "$LOCAL0" ] || fail "$NAME" "the hub mirrors $MIRROR1 files, fewer than the $LOCAL0 the laptop held before run 1"
step "mirror $MIRROR1 vs laptop now $LOCAL1 (information only — the mirror is never pruned)"

# Identity AND size in ONE find pass: a second `stat` pass would fork per file
# and widen the window in which the satellite can append to a frozen file.
find "$MROOT" -name '*.jsonl' ! -name '*.superseded-*' -printf '%s|%p\0' 2>/dev/null > "$WORK/scan1.z"
COUNT1=$(scan_list "$WORK/scan1.z" "$WORK/set1" "$WORK/sizes1") || fail "$NAME" "a mirror path cannot be handled by this script"
[ "${COUNT1:-0}" -ge 1 ] || fail "$NAME" "run 1 mirrored no files under $MROOT"
step "frozen set: $COUNT1 mirror files with their run-1 sizes"

IN=$(in_list "$WORK/set1")
printf 'SELECT transcript_path || char(124) || last_size FROM ingest_watermark WHERE transcript_path IN (%s) ORDER BY 1;\n' "$IN" > "$WORK/wm.sql"
printf 'SELECT p.transcript_path || char(124) || COUNT(*) FROM messages m JOIN session_provenance p USING(session_id) WHERE p.transcript_path IN (%s) GROUP BY p.transcript_path ORDER BY 1;\n' "$IN" > "$WORK/rows.sql"
hub_sql_file "$WORK/wm.sql" > "$WORK/wmset1" || fail "$NAME" "the watermark query failed"
[ -s "$WORK/wmset1" ] || fail "$NAME" "the watermark query returned nothing for $COUNT1 frozen mirror files"
hub_sql_file "$WORK/rows.sql" > "$WORK/rowset1" || fail "$NAME" "the row query failed"
[ -s "$WORK/rowset1" ] || fail "$NAME" "the row query returned nothing for $COUNT1 frozen mirror files"
step "frozen set: $(wc -l < "$WORK/wmset1") watermark rows, $(wc -l < "$WORK/rowset1") ingested files, $(awk -F'|' '{t+=$NF} END{print t+0}' "$WORK/rowset1") message rows"
step "whole-DB totals (information only): rows $(hub_sql 'SELECT COUNT(*) FROM messages'), mirror watermarks $(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '$MROOT/%'")"

# One comparator for both `<path>|<number>` snapshots: a STABLE frozen file must
# be byte-identical, an APPENDED one may only grow, and none may disappear.
cat > "$WORK/cmp.py" <<'PY'
import sys
def load(f):
    d={}
    for l in open(f):
        p,_,s=l.rstrip("\n").rpartition("|")
        if p: d[p]=int(s)
    return d
a=load(sys.argv[1]); b=load(sys.argv[2])
app={l.rstrip("\n") for l in open(sys.argv[3]) if l.strip()}
label=sys.argv[4]
bad=[]
for p,s in a.items():
    if p not in b:
        bad.append("%s lost its %s" % (p,label)); continue
    if p in app:
        if b[p] < s: bad.append("%s (appended) shrank %d -> %d" % (p,s,b[p]))
    elif b[p] != s:
        bad.append("%s moved %d -> %d with no append line to explain it" % (p,s,b[p]))
for l in bad[:10]: print("    %s" % l)
print("    %s: %d entries, %d appended, %d stable, %d violation(s)"
      % (label, len(a), len(app & set(a)), len(a) - len(app & set(a)), len(bad)))
sys.exit(1 if bad else 0)
PY

step "run 2: recall push --full"
lap "$P"'recall push --full' || fail "$NAME" "recall push --full exited nonzero (run 2)"
LOG2=$(lap "wc -l < ~/.recall/logs/push.log")
GAIN2=$((LOG2-LOG1))
[ "$GAIN2" -ge 1 ] || fail "$NAME" "run 2 logged nothing"
lap "tail -n $GAIN2 ~/.recall/logs/push.log" > "$WORK/run2"
step "run 2: push.log +$GAIN2 lines"
head -5 "$WORK/run2" | sed 's/^/    /'

# Classify every run-2 line by the mirror path it names and the frozen size.
python3 - "$WORK/run2" "$WORK/sizes1" "$MROOT" > "$WORK/verdict" <<'PY'
import re,sys
lines=[l.rstrip("\n") for l in open(sys.argv[1]) if l.strip()]
sizes={}
for l in open(sys.argv[2]):
    p,_,s=l.rstrip("\n").rpartition("|")
    if p: sizes[p]=int(s)
root=sys.argv[3]
bad=[]; new=[]; other=[]; unchanged=0; appended=[]; seen=[]; ahead=0
for l in lines:
    v=re.search(r' vendor=(\S+)', l)
    p=re.search(r' path=(.+?)(?: (?:offset==size|from=|err=)|$)', l)
    if not v or not p:
        other.append(l); continue
    mp = "%s/%s/%s" % (root, v.group(1), p.group(1))
    if mp not in sizes:
        new.append(l); continue
    if "offset==size" in l:
        unchanged += 1; seen.append(mp); continue
    m=re.search(r' from=(\d+) to=(\d+)', l)
    # A strict append: run 2 re-sent no byte the hub already held. `>=`, not
    # `==`: a live Stop-hook push between the freeze and run 2 legitimately
    # advances the hub's on-disk size, and the manifest offset is that size
    # (server.ts:256-258). Only a SMALLER offset would re-send mirrored bytes.
    if m and int(m.group(1)) >= sizes[mp]:
        if int(m.group(1)) > sizes[mp]: ahead += 1
        appended.append(mp); seen.append(mp); continue
    bad.append(l)
print("UNCHANGED %d" % unchanged)
print("APPENDED %d" % len(appended))
print("AHEAD %d" % ahead)
for p in sorted(set(appended)): print("APPENDEDPATH %s" % p)
for p in sorted(set(seen)): print("SEENPATH %s" % p)
print("NEWFILES %d" % len(new))
for l in new[:5]: print("NEWLINE %s" % l)
print("OTHER %d" % len(other))
print("OTHERFAILED %d" % sum("push-failed" in l for l in other))
for l in other[:5]: print("OTHERLINE %s" % l)
print("BAD %d" % len(bad))
for l in bad[:5]: print("BADLINE %s" % l)
PY
grep -v '^APPENDEDPATH ' "$WORK/verdict" | sed 's/^/    /'
UNCHANGED=$(awk '/^UNCHANGED /{print $2}' "$WORK/verdict")
APPENDED=$(awk '/^APPENDED /{print $2}' "$WORK/verdict")
NEWFILES=$(awk '/^NEWFILES /{print $2}' "$WORK/verdict")
OTHERFAILED=$(awk '/^OTHERFAILED /{print $2}' "$WORK/verdict")
AHEAD=$(awk '/^AHEAD /{print $2}' "$WORK/verdict")
BAD=$(awk '/^BAD /{print $2}' "$WORK/verdict")
step "run 2 over the frozen set: $UNCHANGED unchanged, $APPENDED strict appends ($AHEAD of them from an offset the live hook had already advanced), $BAD re-sending mirrored bytes; $NEWFILES line(s) for new transcripts; $OTHERFAILED path-less push-failed line(s)"
[ "$BAD" = 0 ] || fail "$NAME" "$BAD run-2 line(s) re-sent bytes the hub already held; every frozen-set line must be 'offset==size' or a strict append"
[ "$OTHERFAILED" = 0 ] || fail "$NAME" "run 2 logged $OTHERFAILED path-less push-failed line(s) (transport or manifest failure)"
[ $((UNCHANGED+APPENDED)) -ge 1 ] || fail "$NAME" "run 2 accounted for no frozen-set file"
awk '/^APPENDEDPATH /{print substr($0, 14)}' "$WORK/verdict" | sort -u > "$WORK/appended-log"
awk '/^SEENPATH /{print substr($0, 10)}' "$WORK/verdict" | sort -u > "$WORK/seen"

# A frozen file can also GROW out of band: the laptop's Stop hook may deliver its
# tail between the freeze and run 2, in which case run 2 finds nothing to send
# and logs `offset==size` — yet its watermark and rows have moved. Identity is
# not enough; re-scan the sizes and let the disk decide what was appended to.
find "$MROOT" -name '*.jsonl' ! -name '*.superseded-*' -printf '%s|%p\0' 2>/dev/null > "$WORK/scan2.z"
scan_list "$WORK/scan2.z" "$WORK/set2" "$WORK/sizes2" > /dev/null || fail "$NAME" "a mirror path cannot be handled by this script"
python3 - "$WORK/sizes1" "$WORK/sizes2" "$WORK/grown" <<'PY' || fail "$NAME" "a frozen mirror file shrank between the two runs"
import sys
def load(f):
    d={}
    for l in open(f):
        p,_,s=l.rstrip("\n").rpartition("|")
        if p: d[p]=int(s)
    return d
a=load(sys.argv[1]); b=load(sys.argv[2])
grown=[p for p,s in a.items() if p in b and b[p] > s]
shrank=[p for p,s in a.items() if p in b and b[p] < s]
open(sys.argv[3],'w').write(''.join(p+'\n' for p in sorted(grown)))
for p in shrank[:5]: print("    %s shrank %d -> %d" % (p,a[p],b[p]))
print("    frozen files that grew on disk during the run: %d" % len(grown))
sys.exit(1 if shrank else 0)
PY
sort -u "$WORK/appended-log" "$WORK/grown" > "$WORK/appended"
step "APPENDED set: $(wc -l < "$WORK/appended-log") from the log, $(wc -l < "$WORK/grown") from the disk, $(wc -l < "$WORK/appended") in union"
# A file that grew but which run 2 logged as neither an append nor an
# `offset==size` is the genuine idempotency violation: run 2 never accounted
# for it at all.
comm -23 "$WORK/grown" "$WORK/seen" > "$WORK/unaccounted"
if [ -s "$WORK/unaccounted" ]; then
  head -5 "$WORK/unaccounted" | sed 's/^/    /'
  fail "$NAME" "$(wc -l < "$WORK/unaccounted") frozen mirror file(s) grew during the run and run 2 logged no line for them"
fi

hub_sql_file "$WORK/wm.sql" > "$WORK/wmset2" || fail "$NAME" "the watermark query failed after run 2"
[ -s "$WORK/wmset2" ] || fail "$NAME" "the watermark query returned nothing after run 2"
hub_sql_file "$WORK/rows.sql" > "$WORK/rowset2" || fail "$NAME" "the row query failed after run 2"
[ -s "$WORK/rowset2" ] || fail "$NAME" "the row query returned nothing after run 2"
MIRROR2=$(mirror_count)
step "after run 2: frozen-set watermarks $(wc -l < "$WORK/wmset2"), ingested files $(wc -l < "$WORK/rowset2"), hub mirror files $MIRROR2"
step "whole-DB totals (information only): rows $(hub_sql 'SELECT COUNT(*) FROM messages'), mirror watermarks $(hub_sql "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '$MROOT/%'")"

python3 "$WORK/cmp.py" "$WORK/wmset1" "$WORK/wmset2" "$WORK/appended" watermark \
  || fail "$NAME" "the frozen set's watermarks did not hold across an idempotent push"
python3 "$WORK/cmp.py" "$WORK/rowset1" "$WORK/rowset2" "$WORK/appended" rows \
  || fail "$NAME" "the frozen set's row counts did not hold across an idempotent push"
[ "$MIRROR2" -ge "$MIRROR1" ] || fail "$NAME" "the mirror shrank ($MIRROR1 → $MIRROR2)"
pass "$NAME"
