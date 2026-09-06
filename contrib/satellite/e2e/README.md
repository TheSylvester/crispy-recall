# Satellite mode — end-to-end acceptance scripts (spec §9)

These scripts drive REAL machines — a hub, a Linux satellite reached over SSH and
a Windows satellite reached through WSL interop. Nothing below is hard-coded to
one person's boxes: every machine-specific value arrives in the environment, and
a script that needs one it was not given stops on its own `FAIL <name> — set
<VAR> …` line before it touches anything. Run them only from an acceptance seat
whose owner has agreed to the state changes each script prints up front.

Each prints indented progress lines and exactly one final `PASS <name>` /
`FAIL <name> — <reason>` line, and exits 0 or 1.
## Run order
`10-parity.sh` (pre / pre-raw at the branch base, then post-raw / scope at the head)
→ `20-hub-precondition.sh` → `21-repo-gates.sh` → hub bring-up in rule-9 order
(snapshot, `npm install -g`, `recall install --yes`, drain, verify) →
`30-hub-tokens-serve.sh` → `31-hub-service.sh` → `32-hub-rekey.sh` →
`33-hub-hardening.sh` → `34-hub-protocol-probes.sh` (before 50: it re-issues the
Windows satellite token) → `40-laptop-install.sh` → `41-laptop-session.sh` →
`42-laptop-queries.sh` → `43-laptop-idempotency.sh` → `44-laptop-failures.sh` →
`45-laptop-torn-tail.sh` → `46-laptop-codex.sh` → `50-win-install.sh` →
`51-win-sessions.sh` → `52-win-queries.sh` → `60-hub-repair-full-snapshot.sh` →
`61-hub-backup.sh` → `62-hub-sweep-retry.sh`. Then, only on the owner's word, `90-teardown.sh` and `91-hub-rollback.sh`.

## Environment

"Required" means the scripts listed under "Used by" refuse to run without it —
`lib.sh`'s `require_e2e_env` (and `10-parity.sh`'s own `need_env`) checks it
lazily, after `NAME=` is set, so sourcing `lib.sh` with an empty environment
stays silent.

### Machines — required, no default

| Variable | Used by | Meaning |
| --- | --- | --- |
| `RECALL_E2E_HUB_ADDR` | 30–34, 40–46, 50–52, 62 | Address the hub's HTTP API answers on. Joined with `RECALL_E2E_HUB_PORT` into `HUB_URL`. |
| `RECALL_E2E_LAPTOP` | 31, 34, 40–46, 90 | `user@host` for the Linux satellite; every remote call is `ssh` exec/pty (no SFTP). |
| `RECALL_E2E_LAPTOP_HOST` | 30, 31, 34, 41, 43–46, 60, 61, 62, 90 | The satellite's registered host name — the mirror directory and `hub token` name. |
| `RECALL_E2E_LAPTOP_HOME` | 40, 60 | The satellite's home directory (e.g. `/home/alex`); 40 checks where `recall` resolves and 60 recognises its `path:` project keys. |
| `RECALL_E2E_LAPTOP_REPO` | 41, 42, 44, 46 | Absolute path on the satellite of the git repo the §9.3.2 turn and the scoped queries run in. |
| `RECALL_E2E_WIN_HOST` | 30, 31, 34, 51, 90 | The Windows satellite's registered host name. |
| `RECALL_E2E_WIN_USER` | 50, 51, 52, 90 | Windows user name. `WIN_HOME` (`/mnt/c/Users/<user>`), `WIN_HOME_W`, `WIN_DIR`, `WIN_RECALL_W`, `WIN_CLAUDE_W` and `WIN_HOOK_W` are all derived from it. |
| `RECALL_E2E_NODE` | 21, 50, 91 (and 10 via `RECALL_NODE`) | Absolute path to the hub's `node` binary. Its directory becomes the `PATH` prefix and the expected `recall` location. |
| `RECALL_MAIN_CHECKOUT` | 10 (scope, scope-pre), 91 | The hub's main checkout of this repo. |
| `RECALL_INT_WORKTREE` | 10 (all but pre-raw), 21 | The integration worktree whose `dist/recall.js` is under test. |
| `RECALL_BASE_WORKTREE` | 10 (pre-raw) | The branch-base worktree whose build produces the `pre-raw` oracle. |
| `RECALL_E2E_HUB_REPO` | 10 (scope) | Hub-side repo path the scope gate looks for; matched as `<repo>/%` and `<repo>-agent-fix-%`. |
| `RECALL_E2E_BASELINE` | 21 | The recorded baseline test count. |
| `RECALL_E2E_TGZ` | 40, 50 | The packed tarball to install on the satellites. |
| `RECALL_E2E_SNAPSHOT_DIR` | 61, 91 | The Phase-4 snapshot directory. |
| `RECALL_E2E_CONFIRM` | 90, 91 | Explicit confirmation; 91 needs `rollback`. |

### Impersonal defaults

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `RECALL_E2E_LOG_DIR` | `$HOME/.recall/logs/e2e` | all | Where each script tees its log. |
| `RECALL_E2E_HUB_PORT` | `7877` | 30–34, 40–46, 50–52, 62 | Hub API port. |
| `RECALL_E2E_LAPTOP_PATH_PREFIX` | `$HOME/.local/bin` (expanded on the SATELLITE) | 40–45, 90 | Added after the candidate `~/.local/bin` in remote `PATH` to select Node/npm. See the nvm trap below. |
| `RECALL_E2E_LAPTOP_RECALL_BIN` | `<RECALL_E2E_LAPTOP_HOME>/.local/bin/recall` | 40 | Legacy assertion override; must equal the candidate path in `~/.local/bin` (other paths are rejected). |
| `RECALL_E2E_WIN_NPM_W` | `C:\Program Files\nodejs\npm.cmd` | 50, 90 | Windows `npm` shim, in Windows path form. |
| `RECALL_E2E_HUB_RECALL_BIN` | `$(dirname "$RECALL_E2E_NODE")/recall` | 50 | Where `which -a recall` must resolve in the WSL shell after the Windows install. |
| `RECALL_E2E_BACKUP_SCRIPT` | `$HOME/.local/bin/wsl-backup` | 61 | The backup script §9.5.3 edits so the mirror travels with it. |
| `RECALL_E2E_HOOK_CMD` | `"$RECALL_E2E_NODE" "$HOME/.recall/bin/stop-hook.js"` | 91 | The Phase-0 hook literal both hook commands must equal after a rollback. |
| `RECALL_E2E_RECALL` | `recall` | many | The `recall` binary the hub-side assertions invoke. |
| `RECALL_E2E_REPO_GIT_KEY` | the crispy root-commit key | 41, 51 | The git `project_key` of `RECALL_E2E_LAPTOP_REPO` and of the Windows checkout of the same repo. Override it when the fixture repo is not crispy. |
| `RECALL_E2E_SSH_TIMEOUT` | `120` | all remote | Seconds per `ssh` call. |
| `RECALL_E2E_WIN_TIMEOUT` | `300` | 50–52, 90 | Seconds per `cmd.exe` call. |
| `RECALL_E2E_HUB_ONLY_PHRASE` | `VACUUM INTO snapshot of the recall database` | 42, 51 | A phrase only the hub can answer. |
| `RECALL_E2E_WIN_SYNTHETIC` | `auto` | 51, 52 | `0` disables the synthetic Stop-hook fallback, `1` forces the check. |
| `RECALL_E2E_REISSUE` | — | 30 | Re-issue the tokens instead of reusing the token file. |
| `RECALL_E2E_PUSH_TIMEOUT` | — | 43 | Seconds to wait for a push to land. |
| `RECALL_E2E_REPAIR_TIMEOUT` | `3600` | 60 | Seconds for `repair --full`. The seat sets it from the measured embed rate times the snapshot's hot-message count: ~28 msg/s on one hub's GPU meant ~2.5 h for the 2026-09-04 snapshot; on a snapshot root without `run/` the repair's embed phase yields and only the re-ingest is timed (R-k73qa4). |
| `RECALL_TOKEN_FILE` | `$HOME/.recall/e2e-tokens.env` | all token users | The 0600 token file — see "Tokens". |
| `RECALL_E2E_TOKEN`, `RECALL_E2E_TOKEN_WIN` | read from the token file | all token users | The two bearer tokens. Never put them on a command line. |
| `RECALL_PARITY_HOME` | `$HOME/.recall-parity` | 10 | Snapshot root the parity queries run against. |
| `RECALL_PARITY_BASE` | `$HOME/.recall-parity-base` | 10 (pre-raw, post-raw) | Base snapshot root. |
| `RECALL_NODE` | `$RECALL_E2E_NODE` | 10 | `10-parity.sh` does not source `lib.sh`; this is its own name for the node binary. |

### Example

Placeholder values — substitute your own:

```sh
export RECALL_E2E_HUB_ADDR=100.64.0.10
export RECALL_E2E_HUB_PORT=7877
export RECALL_E2E_LAPTOP=alex@100.64.0.11
export RECALL_E2E_LAPTOP_HOST=alex-laptop
export RECALL_E2E_LAPTOP_HOME=/home/alex
export RECALL_E2E_LAPTOP_REPO=/home/alex/dev/crispy
export RECALL_E2E_WIN_HOST=alex-desktop
export RECALL_E2E_WIN_USER=alex
export RECALL_E2E_NODE=/home/alex/.nvm/versions/node/v22.20.0/bin/node
export RECALL_MAIN_CHECKOUT=/home/alex/dev/recall
export RECALL_INT_WORKTREE=/home/alex/dev/recall-sat-int
export RECALL_BASE_WORKTREE=/home/alex/dev/recall-sat-base
export RECALL_E2E_HUB_REPO=/home/alex/dev/recall
export RECALL_E2E_BASELINE=914
export RECALL_E2E_TGZ=/home/alex/dev/recall/crispy-recall-0.4.0.tgz
export RECALL_E2E_SNAPSHOT_DIR=/home/alex/.recall-phase4-snapshot
# Only when recall does not live under ~/.local/bin on the satellite:
# export RECALL_E2E_LAPTOP_PATH_PREFIX=/home/alex/.nvm/versions/node/v22.20.0/bin
```

### Trap: a non-interactive ssh never loads nvm

`lap`/`lap_stdin` run `ssh <host> '<command>'`, which is a NON-INTERACTIVE,
non-login shell. Ubuntu's stock `~/.bashrc` returns early for exactly that case,
so nvm is never sourced and the remote `PATH` is the bare system one — a `recall`
installed under `~/.nvm/versions/node/*/bin` is then invisible, and `command -v
recall` comes back empty even though an interactive login finds it. Set
`RECALL_E2E_LAPTOP_PATH_PREFIX` to that Node `bin` directory when Node/npm come from
nvm on the satellite. Script 40 always installs the tarball under `~/.local`,
checks its version against the tarball metadata, and invokes that installed
binary explicitly. All later laptop scripts prefer `~/.local/bin` over nvm;
do not point `RECALL_E2E_LAPTOP_RECALL_BIN` at an older nvm copy. The value is sent to the remote shell verbatim, so a
literal `$HOME` in it is expanded THERE, not on the seat.

## Windows without an interactive login
`RECALL_E2E_WIN_SYNTHETIC` (`auto` by default, `0` to disable, `1` to force the
check) lets 51 and 52 continue when Windows Claude Code cannot authenticate: the
script writes a two-entry transcript where Claude Code would have written one and
pipes the Stop payload into the STAGED `stop-hook.js` under the Windows user's
`.recall` (`WIN_HOOK_W`, derived from `RECALL_E2E_WIN_USER`).
That proves the staged hook, the push, the mirror layout, the path and git key
derivation and the vectorisation on Windows. It leaves a real transcript in the
owner's Windows project directory: each one is printed as `LEFT-CHANGED:`,
listed in `$RECALL_E2E_LOG_DIR/win-synthetic.paths`, and removed file by file by
`90-teardown.sh`. It does NOT prove that Claude Code itself fires the hook on
Windows, and 52's console-flash observation becomes "not observable in synthetic
mode". The final line then reads
`PASS <script> (synthetic hook: Windows Claude auth unavailable)`.

## Tokens
`30-hub-tokens-serve.sh` is the only writer of `$RECALL_TOKEN_FILE` (default
`~/.recall/e2e-tokens.env`, mode 0600, lines `RECALL_E2E_TOKEN=` and
`RECALL_E2E_TOKEN_WIN=`); `34` rewrites it after re-issuing. Both may be supplied in
the environment instead. No script echoes, logs or puts a token on a command line,
and `90-teardown.sh` shreds the file.
