#!/usr/bin/env bash
# 21-repo-gates.sh — spec §9.1.1: the repo gate on the integration worktree.
#
# The suites isolate themselves (embed-lockfile.test.ts:27 intentionally reads
# the live ~/.recall/bin runtime), so this script sets NO ambient RECALL_HOME /
# RECALL_REMOTE_ROOT / CLAUDE_CONFIG_DIR / CODEX_HOME. Non-interference is
# proven the ledger's way instead: the live /tmp-scoped row count T and the
# md5 of ~/.recall/config.json must not move, and no satellite-token may appear.
source "$(dirname "$0")/lib.sh"
set -u
NAME=21-repo-gates
exec > >(tee -a "$(log_file "$NAME")") 2>&1

require_e2e_env RECALL_INT_WORKTREE RECALL_E2E_NODE
INT=$RECALL_INT_WORKTREE
BASELINE=${RECALL_E2E_BASELINE:?set RECALL_E2E_BASELINE to the recorded baseline test count}
[ -d "$INT" ] || fail "$NAME" "integration worktree $INT does not exist"
export PATH="$(dirname "$NODE"):$PATH"

T_BEFORE=$(hub_sql "SELECT COUNT(*) FROM messages WHERE project_id LIKE '/tmp/%'")
MD5_BEFORE=$(md5sum "$HOME/.recall/config.json" | cut -d' ' -f1)
step "leak watch before: T=$T_BEFORE config.md5=$MD5_BEFORE"

cd "$INT" || fail "$NAME" "cannot enter $INT"
npm run build > "$E2E_LOG_DIR/21-build.log" 2>&1 || fail "$NAME" "npm run build failed (see $E2E_LOG_DIR/21-build.log)"
step "build OK"

TEST_RC=0
npm test > "$E2E_LOG_DIR/21-test.log" 2>&1 || TEST_RC=$?
if [ "$TEST_RC" != 0 ]; then
  # R-kan3kw: test/integration/stop-hook.test.ts:181 flakes with "database is
  # locked" in 25-37 % of runs. Re-run that ONE file once; any other failing
  # file is a real failure.
  # The carve-out applies ONLY when the flake is the WHOLE failing set: a run
  # whose file list cannot be parsed, or that names any other file, is a real
  # failure.
  FAILED=$(grep -oE '^ *FAIL +[^ ]+' "$E2E_LOG_DIR/21-test.log" | awk '{print $2}' | sort -u)
  step "npm test rc=$TEST_RC; failing files: ${FAILED:-<none parsed>}"
  [ "$FAILED" = 'test/integration/stop-hook.test.ts' ] \
    || fail "$NAME" "npm test rc=$TEST_RC; failing files: ${FAILED:-<none parsed — see $E2E_LOG_DIR/21-test.log>}"
  step "re-running test/integration/stop-hook.test.ts once (R-kan3kw)"
  npx vitest run test/integration/stop-hook.test.ts > "$E2E_LOG_DIR/21-stop-hook-rerun.log" 2>&1 \
    || fail "$NAME" "stop-hook.test.ts failed on the re-run too"
  step "re-run green (first run failed, re-run passed — R-kan3kw flake)"
else
  step "npm test green on the first run"
fi

COUNT=$(npx vitest list 2>/dev/null | grep -c ' > ')
step "test count: $COUNT (baseline $BASELINE)"
[ "$COUNT" -ge "$BASELINE" ] || fail "$NAME" "test count $COUNT is below the baseline $BASELINE"

npx tsc --noEmit > "$E2E_LOG_DIR/21-tsc.log" 2>&1 || fail "$NAME" "tsc --noEmit failed (see $E2E_LOG_DIR/21-tsc.log)"
step "tsc --noEmit OK"
step "describe.skipIf occurrences: $(grep -rn 'describe.skipIf' test | wc -l)"

T_AFTER=$(hub_sql "SELECT COUNT(*) FROM messages WHERE project_id LIKE '/tmp/%'")
MD5_AFTER=$(md5sum "$HOME/.recall/config.json" | cut -d' ' -f1)
step "leak watch after:  T=$T_AFTER config.md5=$MD5_AFTER"
[ "$T_BEFORE" = "$T_AFTER" ] || fail "$NAME" "the test run leaked into the live database (T $T_BEFORE → $T_AFTER)"
[ "$MD5_BEFORE" = "$MD5_AFTER" ] || fail "$NAME" "the test run rewrote the live ~/.recall/config.json"
[ ! -e "$HOME/.recall/satellite-token" ] || fail "$NAME" "the test run wrote a satellite token into the live root"
pass "$NAME"
