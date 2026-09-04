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
# re-ingests every file that arrived while it ran. Only the frozen set can carry
# a gate: the histogram compares the same laptop-mirror paths before and after,
# and the watermark gate asserts PRESENCE — exactly one row per frozen path,
# which is the spec's real claim that repair --full re-ingests every mirrored
# file. It never asserts last_size.
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
find "$HOME/.recall/remote" -name '*.jsonl' ! -name '*.superseded-*' -print0 | sort -z > "$WORK/pre.z"
FILES_PRE=$(path_list "$WORK/pre.z" "$WORK/pre") || fail "$NAME" "a mirror path is unsafe for line and SQL use"
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

step "repair --full on the snapshot (re-ingest + re-embed ~280K messages, up to 60 min)"
timeout 3600 env RECALL_HOME="$S" RECALL_REMOTE_ROOT="$HOME/.recall/remote" \
  CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="$HOME/.codex" \
  "$NODE" "$HOME/.recall/bin/recall.js" repair --full --yes > "$E2E_LOG_DIR/60-repair.log" 2>&1 \
  || fail "$NAME" "repair --full exited nonzero or timed out (see $E2E_LOG_DIR/60-repair.log)"
tail -15 "$E2E_LOG_DIR/60-repair.log" | sed 's/^/    /'

A=$(snap_sql "$WORK/hist.sql") || fail "$NAME" "the histogram query failed after the repair"
printf '%s\n' "$A" | sed 's/^/    after:  /'
[ "$A" = "$B" ] || fail "$NAME" "the laptop-mirror project_key histogram changed across repair --full"
printf '%s\n' "$A" | grep -qE '^path:/home/sylvester|^path:c:/' \
  && fail "$NAME" "a laptop-mirror row was re-keyed from the mirror path"
step "no laptop-mirror row carries a path: key (the Windows host's path:c:/ rows are by design and are not in this query)"

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
