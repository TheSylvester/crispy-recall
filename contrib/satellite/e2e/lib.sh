# lib.sh — shared helpers for the spec §9 end-to-end acceptance scripts.
#
# Source this from every 20-…/90-… script:
#     source "$(dirname "$0")/lib.sh"
#     NAME=<script basename without .sh>
#     exec > >(tee -a "$(log_file "$NAME")") 2>&1
#
# The scripts drive REAL machines (a hub, a Linux satellite and a Windows
# satellite), all named through RECALL_E2E_* variables — see README.md,
# "Environment". Every remote call goes through lap/lap_stdin/lap_put (Tailscale
# SSH, exec + pty only, NO SFTP) or win_cmd (WSL -> cmd.exe interop). Nothing
# here echoes a bearer token.
set -u

# The acceptance seat is itself a Claude Code session, and the native binary
# refuses a nested run while CLAUDECODE is set ("Claude Code cannot be launched
# inside another Claude Code session"). Scripts 20, 41 and 44 run `claude -p`.
unset CLAUDECODE

E2E_LOG_DIR=${RECALL_E2E_LOG_DIR:-$HOME/.recall/logs/e2e}
mkdir -p "$E2E_LOG_DIR"

# No machine-specific value below carries a default: each is either impersonal
# or EMPTY, and every script gates the ones it uses through require_e2e_env at
# run time. Derived values use `${VAR:-}` so an unset variable never aborts this
# file under `set -u` — sourcing lib.sh with an almost-empty environment must
# stay silent and succeed.
HUB_ADDR=${RECALL_E2E_HUB_ADDR:-}
HUB_PORT=${RECALL_E2E_HUB_PORT:-7877}
HUB_URL=http://$HUB_ADDR:$HUB_PORT
LAPTOP=${RECALL_E2E_LAPTOP:-}
LAPTOP_HOST=${RECALL_E2E_LAPTOP_HOST:-}
LAPTOP_HOME=${RECALL_E2E_LAPTOP_HOME:-}
LAPTOP_REPO=${RECALL_E2E_LAPTOP_REPO:-}
# Sent to the REMOTE shell verbatim, so `$HOME` must survive this expansion:
# it is the laptop's home, not the seat's. Point it at the laptop's node bin
# directory to select Node/npm (a non-interactive ssh never loads nvm).
# Always prefer the candidate installed by script 40 over an older nvm recall.
LAPTOP_PATH_PREFIX=\$HOME/.local/bin${RECALL_E2E_LAPTOP_PATH_PREFIX:+:$RECALL_E2E_LAPTOP_PATH_PREFIX}
LAPTOP_CANDIDATE_BIN=${LAPTOP_HOME:-}/.local/bin/recall
WIN_HOST=${RECALL_E2E_WIN_HOST:-}
WIN_USER=${RECALL_E2E_WIN_USER:-}
WIN_HOME=/mnt/c/Users/${WIN_USER:-}
WIN_HOME_W="C:\\Users\\${WIN_USER:-}"
WIN_DIR=$WIN_HOME/AppData/Local/Temp/recall-e2e
WIN_DIR_W="$WIN_HOME_W\\AppData\\Local\\Temp\\recall-e2e"
WIN_RECALL_W="$WIN_HOME_W\\AppData\\Roaming\\npm\\recall.cmd"
WIN_CLAUDE_W="$WIN_HOME_W\\AppData\\Roaming\\npm\\claude.cmd"
WIN_HOOK_W="$WIN_HOME_W\\.recall\\bin\\stop-hook.js"
WIN_NPM_W=${RECALL_E2E_WIN_NPM_W:-'C:\Program Files\nodejs\npm.cmd'}
NODE=${RECALL_E2E_NODE:-}
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

# require_e2e_env <VAR>… — the LAZY gate on the machine-specific variables.
# Call it from a script AFTER `NAME=` is set, never at source time: this file is
# also sourced by the lint suite with an almost-empty environment.
require_e2e_env() { # $1.. variable names
  local v
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then
      fail "${NAME:-lib}" "set $v (see contrib/satellite/e2e/README.md, \"Environment\")"
    fi
  done
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

# scan_list <NUL-delimited "<size>|<path>" records> <paths out> <path|size out>
# One atomic `find … -printf '%s|%p\0'` pass gives identity AND size together, so
# no file can change between the two reads. Writes the sorted path list and the
# path|size map, and prints the count.
#
# Validator limit, not a hub rule: the hub accepts any non-control, non-`?`
# character in a rel segment (protocol.ts:227-236). Only what would desynchronise
# a line reader is rejected here — a newline, a carriage return or leading and
# trailing whitespace. in_list's quote doubling makes every other character safe
# in SQL, and `path|size` is split at the LAST `|`, so a path may hold one.
scan_list() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
recs=[r for r in open(sys.argv[1],'rb').read().split(b'\0') if r]
paths=[]
for r in recs:
    size,_,path = r.decode('utf-8','surrogateescape').partition('|')
    if any(c in path for c in ('\n','\r')) or path != path.strip():
        print('unsafe path (validator limit — a newline, CR or edge whitespace '
              'breaks the line readers): %r' % path, file=sys.stderr)
        sys.exit(1)
    paths.append((path,int(size)))
paths.sort()
open(sys.argv[2],'w').write(''.join(p+'\n' for p,_ in paths))
open(sys.argv[3],'w').write(''.join('%s|%d\n' % (p,s) for p,s in paths))
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

# --- windows (WSL interop; run a relative batch name from its directory) -----

# win_cmd <name>  — the .cmd body is read from this function's stdin.
win_cmd() {
  local name=$1 rc
  mkdir -p "$WIN_DIR"
  sed 's/$/\r/' > "$WIN_DIR/$name.cmd"
  # WSL maps this DrvFs working directory to Windows. A relative batch name
  # avoids cmd.exe /c quote stripping for profiles with spaces.
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || return 2
  ( cd "$WIN_DIR" && timeout "$WIN_TIMEOUT" cmd.exe /c "$name.cmd" ) 2>&1 | tr -d '\r'
  rc=${PIPESTATUS[0]}
  return "$rc"
}
