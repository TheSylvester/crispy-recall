#!/usr/bin/env bash
# 60-hub-repair-full-snapshot.sh — spec §9.5.2: `repair --full` against a
# SNAPSHOT, never the live database (it cascades DELETE FROM messages into
# 208K+ vectors).
#
# The snapshot root symlinks the LIVE bin/ and models/. It therefore runs ONLY
# `repair --full --yes`; never install, uninstall or backfill, and never
# `rm -rf $S/bin/` — the final rm removes the LINK, not the live runtime.
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
# The final removal happens in the EXIT trap and refuses unless $S/bin is still
# the SYMLINK to the live runtime (removing the link never touches ~/.recall/bin).
cleanup() {
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
step "snapshot at $S ($(du -m "$S/recall.db" | cut -f1) MiB), bin and models symlinked"

Q="SELECT project_key, COUNT(*) FROM messages m JOIN session_provenance p USING(session_id) WHERE p.transcript_path LIKE '%/remote/sylvester-laptop/%' GROUP BY 1"
B=$(sqlite3 -readonly "$S/recall.db" "$Q")
printf '%s\n' "$B" | sed 's/^/    before: /'
[ -n "$B" ] || fail "$NAME" "the snapshot holds no laptop-mirror rows — run 41/43 first"

step "repair --full on the snapshot (re-ingest + re-embed ~280K messages, up to 60 min)"
timeout 3600 env RECALL_HOME="$S" RECALL_REMOTE_ROOT="$HOME/.recall/remote" \
  CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="$HOME/.codex" \
  "$NODE" "$HOME/.recall/bin/recall.js" repair --full --yes > "$E2E_LOG_DIR/60-repair.log" 2>&1 \
  || fail "$NAME" "repair --full exited nonzero or timed out (see $E2E_LOG_DIR/60-repair.log)"
tail -15 "$E2E_LOG_DIR/60-repair.log" | sed 's/^/    /'

A=$(sqlite3 -readonly "$S/recall.db" "$Q")
printf '%s\n' "$A" | sed 's/^/    after:  /'
[ "$A" = "$B" ] || fail "$NAME" "the laptop-mirror project_key histogram changed across repair --full"
printf '%s\n' "$A" | grep -qE '^path:/home/sylvester|^path:c:/' \
  && fail "$NAME" "a laptop-mirror row was re-keyed from the mirror path"
step "no laptop-mirror row carries a path: key (the Windows host's path:c:/ rows are by design and are not in this query)"

WM=$(sqlite3 -readonly "$S/recall.db" "SELECT COUNT(*) FROM ingest_watermark WHERE transcript_path LIKE '%/remote/%'")
FILES=$(find "$HOME/.recall/remote" -name '*.jsonl' ! -name '*.superseded-*' | wc -l)
step "mirror watermarks in the snapshot: $WM   mirror files on disk: $FILES"
[ "$WM" = "$FILES" ] || fail "$NAME" "watermark count $WM does not equal the mirror file count $FILES"
pass "$NAME"
