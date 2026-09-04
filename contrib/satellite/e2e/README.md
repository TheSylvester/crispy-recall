# Satellite mode — end-to-end acceptance scripts (spec §9)

These scripts drive the owner's real machines; run them only from the acceptance seat.
Each prints indented progress lines and exactly one final `PASS <name>` /
`FAIL <name> — <reason>` line, and exits 0 or 1.
## Run order
`10-parity.sh` (pre / pre-raw at the branch base, then post-raw / scope at the head)
→ `20-hub-precondition.sh` → `21-repo-gates.sh` → hub bring-up in rule-9 order
(snapshot, `npm install -g`, `recall install --yes`, drain, verify) →
`30-hub-tokens-serve.sh` → `31-hub-service.sh` → `32-hub-rekey.sh` →
`33-hub-hardening.sh` → `34-hub-protocol-probes.sh` (before 50: it re-issues the
`silverera2` token) → `40-laptop-install.sh` → `41-laptop-session.sh` →
`42-laptop-queries.sh` → `43-laptop-idempotency.sh` → `44-laptop-failures.sh` →
`45-laptop-torn-tail.sh` → `46-laptop-codex.sh` → `50-win-install.sh` →
`51-win-sessions.sh` → `52-win-queries.sh` → `60-hub-repair-full-snapshot.sh` →
`61-hub-backup.sh` → `62-hub-sweep-retry.sh`. Then, only on the owner's word, `90-teardown.sh` and `91-hub-rollback.sh`.
## Environment
Shared: `RECALL_E2E_LOG_DIR` (default `~/.recall/logs/e2e`), `RECALL_E2E_HUB_ADDR`,
`RECALL_E2E_HUB_PORT`, `RECALL_E2E_LAPTOP`, `RECALL_E2E_RECALL`, `RECALL_E2E_SSH_TIMEOUT`,
`RECALL_E2E_WIN_TIMEOUT`. Per script: `RECALL_INT_WORKTREE` + `RECALL_E2E_BASELINE` (21),
`RECALL_E2E_REISSUE` (30), `RECALL_E2E_TGZ` (40, 50), `RECALL_E2E_HUB_ONLY_PHRASE` (42, 51),
`RECALL_E2E_PUSH_TIMEOUT` (43), `RECALL_E2E_SNAPSHOT_DIR` (61, 91), `RECALL_E2E_CONFIRM`
(90, 91), `RECALL_E2E_HOOK_CMD` (91, defaults to the Phase-0 hook literal). `10-parity.sh` uses `RECALL_PARITY_HOME`, `RECALL_PARITY_BASE`,
`RECALL_MAIN_CHECKOUT`, `RECALL_BASE_WORKTREE`.
## Tokens
`30-hub-tokens-serve.sh` is the only writer of `$RECALL_TOKEN_FILE` (default
`~/.recall/e2e-tokens.env`, mode 0600, lines `RECALL_E2E_TOKEN=` and
`RECALL_E2E_TOKEN_WIN=`); `34` rewrites it after re-issuing. Both may be supplied in
the environment instead. No script echoes, logs or puts a token on a command line,
and `90-teardown.sh` shreds the file.
