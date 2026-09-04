#!/usr/bin/env bash
# 61-hub-backup.sh — spec §9.5.3: the owner's backup routine must carry the
# mirror.
#
# The smallest edit inserts `.recall/remote` into the per-path list of the
# "Claude config" step of ~/.local/bin/wsl-backup, right after
# `.recall/config.json`, so the mirror travels in claude-config.tar.zst.
# Without --run the script only makes and checks the edit (~3.5 GB otherwise).
source "$(dirname "$0")/lib.sh"
set -u
NAME=61-hub-backup
exec > >(tee -a "$(log_file "$NAME")") 2>&1

SNAP=${RECALL_E2E_SNAPSHOT_DIR:?set RECALL_E2E_SNAPSHOT_DIR to the Phase-4 snapshot directory}
BK=$HOME/.local/bin/wsl-backup
[ -f "$BK" ] || fail "$NAME" "no $BK"
mkdir -p "$SNAP"
[ -f "$SNAP/wsl-backup.orig" ] || cp "$BK" "$SNAP/wsl-backup.orig"
step "original kept at $SNAP/wsl-backup.orig"

python3 - "$BK" <<'PY' || fail "$NAME" "could not insert .recall/remote into the per-path list"
import sys
p=sys.argv[1]; lines=open(p).read().split('\n')
if any('.recall/remote' in l for l in lines):
    print('    .recall/remote already present — no edit needed'); sys.exit(0)
for i,l in enumerate(lines):
    if '.recall/config.json' in l:
        lines[i]=l.replace('.recall/config.json', '.recall/config.json .recall/remote', 1)
        print('    line %d now: %s' % (i+1, lines[i].strip())); break
else:
    print('    could not find the .recall/config.json entry'); sys.exit(1)
open(p,'w').write('\n'.join(lines))
PY

bash -n "$BK" || fail "$NAME" "the edited $BK does not parse"
grep -q 'recall/remote' "$BK" || fail "$NAME" "the edit did not take"
step "edit verified; bash -n clean"
df -h /mnt/d | sed 's/^/    /'

if [ "${1:-}" != --run ]; then
  step "backup not run (pass --run)"
  pass "$NAME"
fi

step "running the full backup (~3.5 GB)"
"$BK" > "$E2E_LOG_DIR/61-backup.log" 2>&1 || fail "$NAME" "wsl-backup exited nonzero (see $E2E_LOG_DIR/61-backup.log)"
tail -10 "$E2E_LOG_DIR/61-backup.log" | sed 's/^/    /'
NEW=$(ls -1dt /mnt/d/wsl-backups/*/ 2>/dev/null | head -1)
step "newest backup directory: ${NEW:-<none>}"
[ -n "$NEW" ] || fail "$NAME" "no backup directory appeared under /mnt/d/wsl-backups/"
FOUND=
for a in "$NEW"*.tar.zst; do
  [ -f "$a" ] || continue
  if tar -I zstd -tf "$a" 2>/dev/null | grep -m1 -q "^\.recall/remote/$LAPTOP_HOST/"; then FOUND=$a; break; fi
done
step "archive holding .recall/remote/$LAPTOP_HOST/: ${FOUND:-<none>}"
[ -n "$FOUND" ] || fail "$NAME" "no archive in $NEW carries remote/$LAPTOP_HOST/"
pass "$NAME"
