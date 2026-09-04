#!/usr/bin/env bash
# 91-hub-rollback.sh — rule 11: the ledger's ROLLBACK REHEARSAL, executed.
# Runs only with RECALL_E2E_CONFIRM=rollback; otherwise it prints the plan.
#
# This is the ONE script allowed to enter /home/silver/dev/recall, and it runs
# only `npm link` there (package.json has prepack, not prepare, so npm link does
# NOT rebuild the owner's main checkout).
source "$(dirname "$0")/lib.sh"
set -u
NAME=91-hub-rollback
exec > >(tee -a "$(log_file "$NAME")") 2>&1

MAIN=/home/silver/dev/recall
SNAP=${RECALL_E2E_SNAPSHOT_DIR:-<snapshot dir>}
# The Phase-0 literal recorded in the ledger. Both hook commands must EQUAL it
# after the rollback; the before/after listing below is a printed record only.
HOOK_CMD=${RECALL_E2E_HOOK_CMD:-'"/home/silver/.nvm/versions/node/v22.18.0/bin/node" "/home/silver/.recall/bin/stop-hook.js"'}
PLAN="  1. systemctl --user disable --now recall-hub; rm -f ~/.config/systemd/user/recall-hub.service; systemctl --user daemon-reload
  2. export PATH=/home/silver/.nvm/versions/node/v22.18.0/bin:\$PATH; npm uninstall -g crispy-recall
  3. cd $MAIN && npm link   (fallback: npm install -g crispy-recall@0.3.1)
  4. recall install --yes
  5. verify: recall \"VACUUM INTO snapshot\" returns rows within 30 s; both hook commands EQUAL the Phase-0 literal; recall doctor exit 0
  6. PRINT ONLY, never run: the DB-restore contingency from $SNAP"
if [ "${RECALL_E2E_CONFIRM:-}" != rollback ]; then
  printf 'rollback plan (set RECALL_E2E_CONFIRM=rollback to run it):\n%s\n' "$PLAN"
  exit 2
fi
printf '%s\n' "$PLAN"
export PATH=/home/silver/.nvm/versions/node/v22.18.0/bin:$PATH

HOOKS_BEFORE=$(python3 - "$HOME/.claude/settings.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); h=d.get('hooks',{})
for ev in ('Stop','SubagentStop'):
    for g in h.get(ev,[]):
        for x in g.get('hooks',[]): print(ev, x.get('command'))
PY
)
printf '%s\n' "$HOOKS_BEFORE" | sed 's/^/    before: /'

step "1. removing the systemd unit"
systemctl --user disable --now recall-hub 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/recall-hub.service"
systemctl --user daemon-reload || true

step "2. npm uninstall -g crispy-recall"
npm uninstall -g crispy-recall 2>&1 | tail -3 | sed 's/^/    /'

step "3. npm link from $MAIN"
( cd "$MAIN" && npm link ) 2>&1 | tail -5 | sed 's/^/    /'
LINK=$(readlink -f "$(command -v recall)" 2>/dev/null || echo none)
step "readlink -f \$(which recall) → $LINK"
npm ls -g --depth 0 crispy-recall 2>&1 | sed 's/^/    /'
if [ "$LINK" != "$MAIN/dist/recall.js" ]; then
  step "the link did not restore; falling back to npm install -g crispy-recall@0.3.1"
  npm install -g crispy-recall@0.3.1 2>&1 | tail -3 | sed 's/^/    /'
  LINK=$(readlink -f "$(command -v recall)" 2>/dev/null || echo none)
  step "recall now resolves to $LINK"
fi

step "4. recall install --yes"
recall install --yes > "$E2E_LOG_DIR/91-install.log" 2>&1 || fail "$NAME" "recall install --yes failed (see $E2E_LOG_DIR/91-install.log)"
tail -8 "$E2E_LOG_DIR/91-install.log" | sed 's/^/    /'

step "5. verifying"
T0=$(date +%s)
ROWS=$(timeout 30 recall "VACUUM INTO snapshot" | rows)
step "query returned $ROWS unique sessions in $(( $(date +%s) - T0 )) s"
[ "${ROWS:-0}" -ge 1 ] || fail "$NAME" "the rolled-back binary answers no sessions"
HOOKS_AFTER=$(python3 - "$HOME/.claude/settings.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); h=d.get('hooks',{})
for ev in ('Stop','SubagentStop'):
    for g in h.get(ev,[]):
        for x in g.get('hooks',[]): print(ev, x.get('command'))
PY
)
printf '%s\n' "$HOOKS_AFTER" | sed 's/^/    after:  /'
[ "$HOOKS_BEFORE" = "$HOOKS_AFTER" ] || step "NOTE: the before/after hook listing differs — see the record above"
# The gate is equality with the Phase-0 literal, not merely no change.
python3 - "$HOME/.claude/settings.json" "$HOOK_CMD" <<'HK' || fail "$NAME" "a hook command does not equal the Phase-0 literal"
import json,sys
d=json.load(open(sys.argv[1])); want=sys.argv[2]; h=d.get('hooks',{}); ok=True
for ev in ('Stop','SubagentStop'):
    cmds=[x.get('command') for g in h.get(ev,[]) for x in g.get('hooks',[])]
    hit=[c for c in cmds if c==want]
    print('    %s: %d command(s), %d equal to the Phase-0 literal' % (ev,len(cmds),len(hit)))
    ok = ok and len(hit)==1
sys.exit(0 if ok else 1)
HK
step "both hook commands equal the Phase-0 literal"
recall doctor > "$E2E_LOG_DIR/91-doctor.log" 2>&1 || fail "$NAME" "recall doctor exited nonzero after the rollback"
step "recall doctor exit 0"

step "6. DB-restore contingency (PRINTED, NOT RUN):"
printf '     recall uninstall            # keeps the DB, removes the hooks\n'
printf '     rm -f ~/.recall/recall.db-wal ~/.recall/recall.db-shm\n'
printf '     cp %s/recall.db ~/.recall/recall.db\n' "$SNAP"
printf '     recall install --yes  &&  recall "VACUUM INTO snapshot"\n'
pass "$NAME"
