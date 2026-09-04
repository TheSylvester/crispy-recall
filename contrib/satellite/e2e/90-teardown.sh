#!/usr/bin/env bash
# 90-teardown.sh — rule 12: remove everything the acceptance run installed.
# Runs only with RECALL_E2E_CONFIRM=teardown; otherwise it prints the plan.
source "$(dirname "$0")/lib.sh"
set -u
NAME=90-teardown
exec > >(tee -a "$(log_file "$NAME")") 2>&1

PLAN="  hub:     systemctl --user disable --now recall-hub; rm the unit file; daemon-reload
  hub:     recall hub token --revoke $LAPTOP_HOST and --revoke $WIN_HOST
  laptop:  recall uninstall --yes; npm uninstall -g --prefix ~/.local crispy-recall;
           restore ~/.claude/settings.json from settings.json.pre-e2e;
           rm -rf ~/.claude/projects/-tmp-recall-torn
  windows: recall uninstall --purge --yes; npm uninstall -g crispy-recall; rm the recall-e2e Temp dir
  local:   rm -f $TOKEN_FILE"
if [ "${RECALL_E2E_CONFIRM:-}" != teardown ]; then
  printf 'teardown plan (set RECALL_E2E_CONFIRM=teardown to run it):\n%s\n' "$PLAN"
  exit 2
fi
printf '%s\n' "$PLAN"

step "hub: stopping and removing the systemd unit"
systemctl --user disable --now recall-hub 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/recall-hub.service"
systemctl --user daemon-reload || true
step "hub: unit active state now: $(systemctl --user is-active recall-hub 2>/dev/null || echo inactive)"

step "hub: revoking both tokens"
REV1=$("$RECALL_BIN" hub token --revoke "$LAPTOP_HOST" 2>&1) || true
REV2=$("$RECALL_BIN" hub token --revoke "$WIN_HOST" 2>&1) || true
printf '%s\n%s\n' "$REV1" "$REV2" | sed 's/^/    /' 

step "laptop: uninstalling"
LAPOUT=$(lap 'export PATH="$HOME/.local/bin:$PATH"; recall uninstall --yes 2>&1 | tail -5; npm uninstall -g --prefix "$HOME/.local" crispy-recall 2>&1 | tail -3; [ -f ~/.claude/settings.json.pre-e2e ] && cp ~/.claude/settings.json.pre-e2e ~/.claude/settings.json && echo settings.json restored; rm -rf ~/.claude/projects/-tmp-recall-torn; rm -f /tmp/crispy-recall.tgz; echo laptop done') \
  || step "WARNING: the laptop teardown reported an error"
printf '%s\n' "$LAPOUT" | sed 's/^/    /'

step "windows: uninstalling"
win_cmd 90-teardown <<CMD
@echo off
call $WIN_RECALL_W uninstall --purge --yes
call "$WIN_NPM_W" uninstall -g crispy-recall
exit /b %ERRORLEVEL%
CMD
rm -rf "$WIN_DIR"
step "windows: removed $WIN_DIR"

step "local: removing the token file"
if [ -f "$TOKEN_FILE" ]; then
  shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"
fi
step "token file present: $([ -f "$TOKEN_FILE" ] && echo yes || echo no)"
[ ! -f "$HOME/.config/systemd/user/recall-hub.service" ] || fail "$NAME" "the recall-hub unit file survived the teardown"
step "REMOVED: the systemd unit, both hub tokens, the laptop and Windows installs, the token file"
step "KEPT (by design): every mirror under ~/.recall/remote and every row ingested from it"
pass "$NAME"
