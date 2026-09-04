#!/usr/bin/env bash
# 40-laptop-install.sh — spec §9.3.1: install the satellite on sylvester-laptop.
#
# npm's prefix on that box is the root-owned /usr and sudo needs a password, so
# the install uses `--prefix "$HOME/.local"`. The token reaches the remote shell
# on stdin only; the remote output is filtered through sed as a second guard.
source "$(dirname "$0")/lib.sh"
set -u
NAME=40-laptop-install
exec > >(tee -a "$(log_file "$NAME")") 2>&1

load_tokens laptop
require_hub_up
[ -n "$TGZ" ] && [ -f "$TGZ" ] || fail "$NAME" "set RECALL_E2E_TGZ to the packed tarball"
mask() { sed "s/$RECALL_E2E_TOKEN/<token>/g"; }
step "REMOTE STATE THIS SCRIPT CHANGES: laptop ~/.claude/settings.json (backup ~/.claude/settings.json.pre-e2e, restored by 90-teardown.sh), a global npm install under ~/.local, and a satellite ~/.recall"

OLD=$(lap "find ~/.claude/projects -name '*.jsonl' -mtime +30 | wc -l")
step "laptop transcripts older than 30 days: $OLD"
[ "$OLD" = 0 ] || fail "$NAME" "the laptop holds $OLD transcripts older than 30 days — lowering cleanupPeriodDays to 30 would delete them; take the DEVIATION path in the orchestrator brief instead"

lap "cp ~/.claude/settings.json ~/.claude/settings.json.pre-e2e" || fail "$NAME" "could not back up the laptop settings.json"
lap "python3 - <<'PY'
import json,os
p=os.path.expanduser('~/.claude/settings.json')
d=json.load(open(p)); d['cleanupPeriodDays']=30
json.dump(d,open(p,'w'),indent=2)
print('cleanupPeriodDays set to 30')
PY" || fail "$NAME" "could not set cleanupPeriodDays to 30"

lap_put "$TGZ" /tmp/crispy-recall.tgz
INST=$(lap 'npm install -g --prefix "$HOME/.local" /tmp/crispy-recall.tgz 2>&1') \
  || { printf '%s\n' "$INST" | sed 's/^/    /'; fail "$NAME" "npm install -g failed on the laptop"; }
printf '%s\n' "$INST" | tail -20 | sed 's/^/    /'
printf '%s\n' "$INST" | grep -q 'EBADENGINE' && fail "$NAME" "npm reported EBADENGINE on Node 20"
WHICH=$(lap 'export PATH="$HOME/.local/bin:$PATH"; command -v recall')
step "laptop command -v recall → $WHICH"
[ "$WHICH" = /home/sylvester/.local/bin/recall ] || fail "$NAME" "recall resolved to ${WHICH:-<nothing>}"

step "installing in satellite mode against $HUB_URL"
SAT=$(lap_stdin 'read -r T; export PATH="$HOME/.local/bin:$PATH"; RECALL_HUB_TOKEN="$T" recall install --hub '"$HUB_URL"' --yes 2>&1' <<<"$RECALL_E2E_TOKEN") \
  || { printf '%s\n' "$SAT" | mask | sed 's/^/    /'; fail "$NAME" "recall install --hub failed on the laptop"; }
printf '%s\n' "$SAT" | mask | tail -25 | sed 's/^/    /'

step "satellite root assertions"
DB=$(lap '[ -e ~/.recall/recall.db ] && echo present || echo absent')
MODELS=$(lap '[ -e ~/.recall/models ] && echo present || echo absent')
ADDONS=$(lap "find ~/.recall -name '*.node' | wc -l")
step "recall.db=$DB models=$MODELS *.node=$ADDONS"
[ "$DB" = absent ] || fail "$NAME" "a satellite must hold no recall.db"
[ "$MODELS" = absent ] || fail "$NAME" "a satellite must hold no models/ directory"
[ "$ADDONS" = 0 ] || fail "$NAME" "$ADDONS native addons were staged under the satellite ~/.recall"

HOOKS=$(lap "python3 - <<'PY'
import json,os
d=json.load(open(os.path.expanduser('~/.claude/settings.json')))
h=d.get('hooks',{})
for ev in ('Stop','SubagentStop'):
    cmds=[x.get('command','') for g in h.get(ev,[]) for x in g.get('hooks',[])]
    print(ev, 'OK' if any('stop-hook.js' in c for c in cmds) else 'MISSING')
print('cleanupPeriodDays', d.get('cleanupPeriodDays'))
PY")
printf '%s\n' "$HOOKS" | sed 's/^/    /'
printf '%s\n' "$HOOKS" | grep -q '^Stop OK' || fail "$NAME" "no Stop hook naming stop-hook.js"
printf '%s\n' "$HOOKS" | grep -q '^SubagentStop OK' || fail "$NAME" "no SubagentStop hook naming stop-hook.js"
printf '%s\n' "$HOOKS" | grep -q '^cleanupPeriodDays 999' || fail "$NAME" "cleanupPeriodDays was not raised to 999"
BAK=$(lap "ls -1 ~/.claude/settings.json.bak.* 2>/dev/null | wc -l")
step "settings.json.bak.* files: $BAK"
[ "$BAK" -ge 1 ] || fail "$NAME" "the retention change left no .bak backup"

DOC=$(lap 'export PATH="$HOME/.local/bin:$PATH"; recall doctor 2>&1'); DRC=$?
printf '%s\n' "$DOC" | sed 's/^/    /'
[ "$DRC" = 0 ] || fail "$NAME" "recall doctor exited $DRC on the satellite"
for line in 'hub reachable' 'auth ok' 'hub version' 'last push' 'pending bytes' 'git' 'cleanupPeriodDays'; do
  printf '%s\n' "$DOC" | grep -q "$line" || fail "$NAME" "doctor prints no '$line' row"
done
step "claude: $(lap 'claude --version' 2>&1 | head -1)"
step "codex:  $(lap 'codex --version' 2>&1 | head -1)"
pass "$NAME"
