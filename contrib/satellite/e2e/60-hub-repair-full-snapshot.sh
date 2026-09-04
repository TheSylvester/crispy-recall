#!/usr/bin/env bash
# 60-hub-repair-full-snapshot.sh — spec §9.5.2: `repair --full` against a
# SNAPSHOT, never the live database (it cascades DELETE FROM messages into
# 208K+ vectors).
#
# The snapshot root symlinks the LIVE bin/ and models/. It therefore runs ONLY
# `repair --full --yes`; never install, uninstall or backfill, and never
# `rm -rf $S/bin/` — the final rm removes the LINK, not the live runtime.
#
# DEVIATION §9.5.2 — the histogram and watermark gates are asserted over the
# mirror files present at snapshot time, because satellites keep pushing during
# the (up to 60 min) repair; files that arrive mid-run are counted and reported,
# never failed on.
#
# `repair --full` reads the LIVE mirror through RECALL_REMOTE_ROOT, so it
# re-ingests every file that arrived while it ran, at whatever size it then has.
# A per-key ROW COUNT therefore cannot be equal on a live satellite — an appended
# frozen file re-ingests larger, and bytes mirrored but not yet ingested when the
# VACUUM INTO ran add rows too. The gate is what §9.5.2 actually claims: repair
# re-ingests the frozen files and does NOT RE-KEY them. So the SET of
# project_keys must be identical before and after (none lost, none added), every
# key's count must be non-decreasing, and no key may APPEAR with a mirror-path
# prefix. That last refusal is about RE-KEYING: a git-keyed session rewritten
# from its mirror path or sidecar cwd shows up as a git: key that DISAPPEARED and
# a path: key that APPEARED. A path: key already present before the repair is
# correct — the laptop derives it itself for a non-git cwd such as
# /home/sylvester/dev, and its sidecar carries it — so it is carried and reported,
# never failed on. The NULL pseudo-key is exempt from the non-decreasing rule and
# may vanish entirely: a sidecar can GAIN a key between the first ingest and the
# repair (the satellite's derivation was transient at first push and a later push
# rewrote it), and the repair honours the CURRENT sidecar, so those rows come back
# under a real key. That migration is reported, not failed on; NULL GROWING is
# still a violation, because it means a real key was lost. The watermark gate
# asserts PRESENCE — one row per frozen path — never last_size.
source "$(dirname "$0")/lib.sh"
set -u
NAME=60-hub-repair-full-snapshot
exec > >(tee -a "$(log_file "$NAME")") 2>&1

AVAIL=$(df --output=avail -m "$HOME" | tail -1 | tr -dc '0-9')
step "free space under \$HOME: ${AVAIL} MiB"
[ "${AVAIL:-0}" -ge 4000 ] || fail "$NAME" "less than 4 GiB free under \$HOME"

S=$HOME/.recall-repair-test
rm -rf "$S"
mkdir -p "$S"
WORK=$(mktemp -d)
# The final removal happens in the EXIT trap and refuses unless $S/bin is still
# the SYMLINK to the live runtime (removing the link never touches ~/.recall/bin).
cleanup() {
  rm -rf "$WORK"
  if [ -d "$S" ]; then
    [ -L "$S/bin" ] || { printf '  REFUSING to remove %s: bin is not a symlink\n' "$S"; return 0; }
    rm -rf "$S"
    printf '  removed %s\n' "$S"
  fi
}
trap cleanup EXIT

sqlite3 -readonly "$HOME/.recall/recall.db" "VACUUM INTO '$S/recall.db'" \
  || fail "$NAME" "VACUUM INTO the snapshot failed"
ln -s "$HOME/.recall/bin" "$S/bin"
ln -s "$HOME/.recall/models" "$S/models"
cp "$HOME/.recall/config.json" "$S/"
# Frozen the instant the snapshot is taken: a push landing mid-run adds mirror
# files the snapshot's watermark table cannot be asked about.
find "$HOME/.recall/remote" -name '*.jsonl' ! -name '*.superseded-*' -printf '%s|%p\0' > "$WORK/pre.z"
FILES_PRE=$(scan_list "$WORK/pre.z" "$WORK/pre" "$WORK/pre-sizes") || fail "$NAME" "a mirror path cannot be handled by this script"
[ "${FILES_PRE:-0}" -ge 1 ] || fail "$NAME" "the mirror holds no transcripts — run 41/43/51 first"
grep "/remote/$LAPTOP_HOST/" "$WORK/pre" > "$WORK/pre-laptop" || true
LAP_PRE=$(wc -l < "$WORK/pre-laptop")
step "mirror files at snapshot time: $FILES_PRE ($LAP_PRE under $LAPTOP_HOST)"
step "snapshot at $S ($(du -m "$S/recall.db" | cut -f1) MiB), bin and models symlinked"
[ "$LAP_PRE" -ge 1 ] || fail "$NAME" "no $LAPTOP_HOST mirror file at snapshot time — run 41/43 first"

# Both queries are fed on STDIN: an IN-list of thousands of paths does not fit
# in one argv element. $S/recall.db is the SNAPSHOT, never the live database.
snap_sql() { sqlite3 -readonly "$S/recall.db" < "$1"; }
LAPIN=$(in_list "$WORK/pre-laptop")
printf 'SELECT project_key, COUNT(*) FROM messages m JOIN session_provenance p USING(session_id) WHERE p.transcript_path LIKE %s AND p.transcript_path IN (%s) GROUP BY 1 ORDER BY 1;\n' \
  "'%/remote/$LAPTOP_HOST/%'" "$LAPIN" > "$WORK/hist.sql"
ALLIN=$(in_list "$WORK/pre")
printf 'SELECT COUNT(*), COUNT(DISTINCT transcript_path) FROM ingest_watermark WHERE transcript_path IN (%s);\n' "$ALLIN" > "$WORK/wm.sql"

B=$(snap_sql "$WORK/hist.sql") || fail "$NAME" "the histogram query failed"
printf '%s\n' "$B" | sed 's/^/    before: /'
[ -n "$B" ] || fail "$NAME" "the snapshot holds no laptop-mirror rows for the frozen set — run 41/43 first"

# The re-embed dominates: this box measured ~28 messages/s on the GPU, so a
# snapshot holding 213K hot messages needs hours, not the 3600 s default. The
# seat sets the cap per run from the measured rate.
REPAIR_TIMEOUT=${RECALL_E2E_REPAIR_TIMEOUT:-3600}
case "$REPAIR_TIMEOUT" in
  ''|*[!0-9]*|0) fail "$NAME" "RECALL_E2E_REPAIR_TIMEOUT must be a positive integer number of seconds (got '$REPAIR_TIMEOUT')";;
esac
step "repair --full on the snapshot (re-ingest ~360K rows; re-embed only when the embed lock is free — on a root without run/ it yields, R-k73qa4; up to ${REPAIR_TIMEOUT} s)"
timeout "$REPAIR_TIMEOUT" env RECALL_HOME="$S" RECALL_REMOTE_ROOT="$HOME/.recall/remote" \
  CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="$HOME/.codex" \
  "$NODE" "$HOME/.recall/bin/recall.js" repair --full --yes > "$E2E_LOG_DIR/60-repair.log" 2>&1 \
  || fail "$NAME" "repair --full exited nonzero or timed out (see $E2E_LOG_DIR/60-repair.log)"
tail -15 "$E2E_LOG_DIR/60-repair.log" | sed 's/^/    /'

snap_sql "$WORK/hist.sql" > "$WORK/hist2" || fail "$NAME" "the histogram query failed after the repair"
sed 's/^/    after:  /' "$WORK/hist2"
printf '%s\n' "$B" > "$WORK/hist1"
python3 - "$WORK/hist1" "$WORK/hist2" <<'PY' || fail "$NAME" "the laptop-mirror project_key histogram did not hold across repair --full"
import re,sys
def load(f):
    d={}
    for l in open(f):
        l=l.rstrip("\n")
        if not l: continue
        k,_,c=l.rpartition("|")
        d[k or '<NULL project_key>']=int(c)  # a NULL key prints as an empty field
    return d
MIRRORKEY=re.compile(r'^(path:/home/sylvester|path:c:/)')
NULLKEY='<NULL project_key>'
a=load(sys.argv[1]); b=load(sys.argv[2])
bad=[]; left_null=0; real_growth=0
for k in sorted(set(a) | set(b)):
    before, after = a.get(k), b.get(k)
    if k == NULLKEY:
        # Rows may LEAVE the NULL bucket: a sidecar that carried "key":null at
        # the first ingest can be rewritten with a real key by a later push, and
        # the repair re-ingests the whole file under the CURRENT sidecar. Rows
        # ARRIVING in it would mean a real key was lost — that stays a violation.
        if before is None:
            bad.append("key %s APPEARED (%d rows): a real key was lost to NULL" % (k, after))
        elif after is None:
            print("    NULL key: %d row(s) before, none after — migrated to real keys" % before)
            left_null += before
        else:
            print("    delta %s: %d -> %d (%+d)" % (k, before, after, after - before))
            if after < before:
                print("    NULL key: %d -> %d (%+d) — rows left NULL for a real key "
                      "(a later push wrote a keyed sidecar; carried, not failed on)"
                      % (before, after, after - before))
                left_null += before - after
            elif after > before:
                bad.append("key %s grew %d -> %d: a real key was lost to NULL" % (k, before, after))
        continue
    if before is None:
        # An APPEARED key is a violation on its own; a mirror-path prefix names
        # the cause. A path: key that was already there is the satellite's own
        # derivation for a non-git cwd and is carried below, not failed on.
        if MIRRORKEY.match(k):
            bad.append("key %s APPEARED — re-keyed from the mirror path (%d rows)" % (k, after))
        else:
            bad.append("key %s APPEARED (%d rows)" % (k, after))
    elif after is None: bad.append("key %s DISAPPEARED (%d rows)" % (k, before))
    else:
        print("    delta %s: %d -> %d (%+d)" % (k, before, after, after - before))
        if after < before: bad.append("key %s lost rows: %d -> %d" % (k, before, after))
        else: real_growth += after - before
# Rows that left NULL must be accounted for by growth on the real keys; the live
# satellite's own appends can only make that growth larger, never smaller.
if left_null:
    print("    %d row(s) left the NULL key; real keys grew by %d in total" % (left_null, real_growth))
    if left_null > real_growth:
        bad.append("NULL rows vanished without landing on a real key (%d left NULL, real keys grew by %d)"
                   % (left_null, real_growth))
carried=[k for k in a if MIRRORKEY.match(k)]
if carried:
    print("    %d row(s) under %d path: key(s) before the repair (satellite-derived, non-git cwd — carried, not failed on): %s"
          % (sum(a[k] for k in carried), len(carried), ", ".join(sorted(carried))))
for l in bad[:10]: print("    %s" % l)
print("    %d key(s) before, %d after, %d violation(s)" % (len(a), len(b), len(bad)))
sys.exit(1 if bad else 0)
PY
step "the set of REAL project_keys is unchanged and no real key lost rows (counts may grow: repair re-ingests the live mirror; NULL rows may migrate to a real key — DEVIATION §9.5.2)"
step "no laptop-mirror key APPEARED with a mirror-path prefix (path: keys present before the repair are carried — DEVIATION §9.5.2)"

WMPAIR=$(snap_sql "$WORK/wm.sql") || fail "$NAME" "the watermark query failed"
WM=${WMPAIR%%|*}
WMD=${WMPAIR##*|}
FILES_POST=$(find "$HOME/.recall/remote" -name '*.jsonl' ! -name '*.superseded-*' | wc -l)
WMTOTAL=$(sqlite3 -readonly "$S/recall.db" "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '%/remote/%'")
step "frozen-set watermarks in the snapshot: $WM rows, $WMD distinct paths, of $FILES_PRE frozen mirror files"
step "information only: $WMTOTAL mirror watermarks in total; $(( FILES_POST - FILES_PRE )) mirror file(s) arrived during the run ($FILES_PRE → $FILES_POST)"
[ "$WM" = "$FILES_PRE" ] || fail "$NAME" "$WM watermark rows for $FILES_PRE frozen mirror files — repair --full did not re-ingest every one"
[ "$WMD" = "$FILES_PRE" ] || fail "$NAME" "$WMD distinct watermark paths for $FILES_PRE frozen mirror files"
pass "$NAME"
