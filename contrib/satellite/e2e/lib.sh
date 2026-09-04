# lib.sh — shared helpers for the spec §9 end-to-end acceptance scripts.
#
# Source this from every 20-…/90-… script:
#     source "$(dirname "$0")/lib.sh"
#     NAME=<script basename without .sh>
#     exec > >(tee -a "$(log_file "$NAME")") 2>&1
#
# The scripts drive the owner's REAL machines (hub era2-wsl, Linux satellite
# sylvester-laptop, Windows satellite silverera2). Every remote call goes
# through lap/lap_stdin/lap_put (Tailscale SSH, exec + pty only, NO SFTP) or
# win_cmd (WSL → cmd.exe interop). Nothing here echoes a bearer token.
set -u

# The acceptance seat is itself a Claude Code session, and the native binary
# refuses a nested run while CLAUDECODE is set ("Claude Code cannot be launched
# inside another Claude Code session"). Scripts 20, 41 and 44 run `claude -p`.
unset CLAUDECODE

E2E_LOG_DIR=${RECALL_E2E_LOG_DIR:-$HOME/.recall/logs/e2e}
mkdir -p "$E2E_LOG_DIR"

HUB_ADDR=${RECALL_E2E_HUB_ADDR:-100.79.117.97}
HUB_PORT=${RECALL_E2E_HUB_PORT:-7877}
HUB_URL=http://$HUB_ADDR:$HUB_PORT
LAPTOP=${RECALL_E2E_LAPTOP:-sylvester@100.64.125.99}
LAPTOP_HOST=sylvester-laptop
WIN_HOST=silverera2
WIN_DIR=/mnt/c/Users/silve/AppData/Local/Temp/recall-e2e
WIN_DIR_W='C:\Users\silve\AppData\Local\Temp\recall-e2e'
WIN_RECALL_W='C:\Users\silve\AppData\Roaming\npm\recall.cmd'
WIN_CLAUDE_W='C:\Users\silve\AppData\Roaming\npm\claude.cmd'
WIN_NPM_W='C:\Program Files\nodejs\npm.cmd'
NODE=/home/silver/.nvm/versions/node/v22.18.0/bin/node
RECALL_BIN=${RECALL_E2E_RECALL:-recall}
TGZ=${RECALL_E2E_TGZ:-}
TOKEN_FILE=${RECALL_TOKEN_FILE:-$HOME/.recall/e2e-tokens.env}
SSH_TIMEOUT=${RECALL_E2E_SSH_TIMEOUT:-120}
WIN_TIMEOUT=${RECALL_E2E_WIN_TIMEOUT:-300}

# --- reporting --------------------------------------------------------------

log_file() { # $1 script name
  printf '%s/%s.log' "$E2E_LOG_DIR" "$1"
}

step() { # $1.. progress text
  printf '  %s\n' "$*"
}

pass() { # $1 script name
  printf 'PASS %s\n' "$1"
  exit 0
}

# fail <script name> <reason...> — prints the ONE final line and stops the run.
# The line goes to stderr, which the script's `exec > >(tee …) 2>&1` captures
# into both the terminal and the log — a caller may have redirected stdout into
# a command substitution, so stdout alone is not safe. In a SUB-SHELL the line is
# ALSO appended straight to the log, because a redirected caller (`wait_until`
# sends its command to /dev/null) would otherwise swallow it; the top-level shell
# is signalled so the run stops. `pass` needs none of this: it only ever runs at
# the top level.
fail() { # $1 script name, $2.. reason
  local n=$1; shift
  local msg="FAIL $n — $*"
  printf '%s\n' "$msg" >&2
  if [ "${BASHPID:-$$}" != "$$" ]; then
    printf '%s\n' "$msg" >> "$(log_file "$n")" 2>/dev/null
    kill -TERM $$ 2>/dev/null
  fi
  exit 1
}

# --- secrets ----------------------------------------------------------------

# write_token_file <laptop token> <windows token>
# The ONLY writer of the token file. Never prints a token.
write_token_file() {
  local old_umask
  old_umask=$(umask)
  umask 077
  { printf 'RECALL_E2E_TOKEN=%s\n' "$1"
    printf 'RECALL_E2E_TOKEN_WIN=%s\n' "$2"
  } > "$TOKEN_FILE"
  umask "$old_umask"
  chmod 600 "$TOKEN_FILE"
  step "tokens written (not shown) → $TOKEN_FILE"
}

# load_tokens [laptop|win|both]  — default both. Env wins over the token file.
load_tokens() {
  local want=${1:-both}
  if [ -f "$TOKEN_FILE" ]; then
    # shellcheck disable=SC1090
    . "$TOKEN_FILE"
  fi
  RECALL_E2E_TOKEN=${RECALL_E2E_TOKEN:-}
  RECALL_E2E_TOKEN_WIN=${RECALL_E2E_TOKEN_WIN:-}
  case "$want" in
    laptop|both) [ -n "$RECALL_E2E_TOKEN" ] || fail "${NAME:-lib}" "no laptop token — run 30-hub-tokens-serve.sh first ($TOKEN_FILE)";;
  esac
  case "$want" in
    win|both) [ -n "$RECALL_E2E_TOKEN_WIN" ] || fail "${NAME:-lib}" "no windows token — run 30-hub-tokens-serve.sh first ($TOKEN_FILE)";;
  esac
}

nonce() {
  openssl rand -hex 6
}

# rows — unique-session count of a `recall` search, read from stdin. runSearch
# ALWAYS prints `Results: <n> messages, <m> unique sessions (showing …)`
# (recall.ts:968), including for zero results, so this is the only safe row
# count: the table itself holds opaque ids (UUID, agent-<7hex>, codex-jsonl-…).
rows() {
  local n
  n=$(sed -nE 's/^Results: ([0-9]+) messages, ([0-9]+) unique sessions.*/\2/p' | head -1)
  printf '%s' "${n:-0}"
}

# --- hub --------------------------------------------------------------------

hub_sql() { # $1 SQL — read-only, always
  sqlite3 -readonly "$HOME/.recall/recall.db" "$1"
}

# hub_sql_file <path to .sql> — the same read-only handle, with the statement on
# STDIN. An IN-list of a few thousand mirror paths does not fit in one argv
# element (execve E2BIG), and a rejected statement must be visible: callers check
# the exit status.
hub_sql_file() { # $1 SQL file
  sqlite3 -readonly "$HOME/.recall/recall.db" < "$1"
}

# path_list <NUL-delimited input> <line-delimited output> — validates and
# converts. A path holding a newline or a quote would desynchronise the line
# readers AND the SQL IN-list at once, so anything outside [A-Za-z0-9._/-] is a
# hard error. Prints the count.
path_list() {
  python3 - "$1" "$2" <<'PY'
import re,sys
data=open(sys.argv[1],'rb').read()
paths=[p.decode('utf-8','surrogateescape') for p in data.split(b'\0') if p]
bad=[p for p in paths if not re.fullmatch(r'[A-Za-z0-9._/-]+', p)]
if bad:
    print('unsafe path: %r' % bad[0], file=sys.stderr)
    sys.exit(1)
open(sys.argv[2],'w').write(''.join(p+'\n' for p in paths))
print(len(paths))
PY
}

# in_list <line-delimited path file> — an SQL IN-list, single quotes doubled.
# Feed the result to hub_sql_file, never to argv.
in_list() {
  python3 - "$1" <<'PY'
import sys
paths=[l.rstrip("\n") for l in open(sys.argv[1]) if l.strip()]
print(",".join("'" + p.replace("'", "''") + "'" for p in paths))
PY
}

hub_health() {
  curl -s -m 4 "$HUB_URL/v1/health"
}

require_hub_up() {
  hub_health | grep -q '"ok":true' \
    || fail "${NAME:-lib}" "hub $HUB_URL does not answer /v1/health — run 30-hub-tokens-serve.sh / 31-hub-service.sh first"
}

mirror_dir() { # $1 host, $2 vendor
  printf '%s/.recall/remote/%s/%s' "$HOME" "$1" "$2"
}

# --- bounded polling --------------------------------------------------------

# wait_until <seconds> <cmd...> — 1 s interval, returns 0 on first success.
wait_until() {
  local budget=$1; shift
  local i=0
  while [ "$i" -lt "$budget" ]; do
    if eval "$@" >/dev/null 2>&1; then return 0; fi
    i=$((i+1))
    sleep 1
  done
  return 1
}

# --- laptop (Tailscale SSH: exec + pty only, no SFTP) ------------------------

_lap_check_stderr() { # $1 stderr file
  local url
  if grep -q 'To authenticate, visit:' "$1" 2>/dev/null; then
    url=$(grep -o 'https://login.tailscale.com/a/[A-Za-z0-9]*' "$1" | head -1)
    printf 'TAILSCALE-CHECK %s\n' "$url"
    fail "${NAME:-lib}" "the tailnet SSH rule is in check mode — approve $url and re-run"
  fi
}

lap() { # $1 remote command — stdout passes through, remote exit code returned
  local err rc
  err=$(mktemp)
  timeout "$SSH_TIMEOUT" ssh -o ConnectTimeout=15 "$LAPTOP" "$1" 2>"$err"
  rc=$?
  _lap_check_stderr "$err"
  cat "$err" >&2
  rm -f "$err"
  return $rc
}

lap_stdin() { # $1 remote command — stdin of this function is fed to the remote
  local err rc
  err=$(mktemp)
  timeout "$SSH_TIMEOUT" ssh -o ConnectTimeout=15 "$LAPTOP" "$1" 2>"$err"
  rc=$?
  _lap_check_stderr "$err"
  cat "$err" >&2
  rm -f "$err"
  return $rc
}

lap_put() { # $1 local file, $2 remote absolute path — no SFTP on this tailnet
  local local_sum remote_sum
  timeout "$SSH_TIMEOUT" ssh -o ConnectTimeout=15 "$LAPTOP" "cat > '$2'" < "$1" \
    || fail "${NAME:-lib}" "copy of $1 to $2 failed"
  local_sum=$(sha256sum "$1" | cut -d' ' -f1)
  remote_sum=$(lap "sha256sum '$2' | cut -d' ' -f1")
  step "sha256 local=$local_sum remote=$remote_sum"
  [ "$local_sum" = "$remote_sum" ] || fail "${NAME:-lib}" "sha256 mismatch after copying $1 to $2"
}

# --- windows (WSL interop; NO double quotes on the interop command line) -----

# win_cmd <name>  — the .cmd body is read from this function's stdin.
win_cmd() {
  local name=$1 rc
  mkdir -p "$WIN_DIR"
  sed 's/$/\r/' > "$WIN_DIR/$name.cmd"
  ( cd /mnt/c && timeout "$WIN_TIMEOUT" cmd.exe /c $WIN_DIR_W\\$name.cmd ) 2>&1 | tr -d '\r'
  rc=${PIPESTATUS[0]}
  return "$rc"
}
