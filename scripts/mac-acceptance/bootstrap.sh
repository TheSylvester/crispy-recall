#!/usr/bin/env bash
# bootstrap.sh — take a fresh macOS box to a crispy-recall acceptance-ready state
# in one command, then self-check the install so the rented Mac's first hour is
# spent on acceptance (live hook, Metal, brew lifecycle) — not on plumbing.
#
# Usage:
#   ./bootstrap.sh --tarball <path|url>     install the BRANCH build (has the fixes)
#   ./bootstrap.sh --registry [version]     install the PUBLISHED build (default latest)
#   ./bootstrap.sh --ci                     runner rehearsal (headless, deterministic)
#   ./bootstrap.sh --dry-run                print the plan; execute nothing
#   ./bootstrap.sh --help
#
# Install-mode nuance: the Phase-2 macOS fixes are NOT published yet (npm has a
# broken-ish 0.2.0). To acceptance-test THE FIXES you must install from --tarball
# (the branch's CI artifact `recall-tarball-<sha>` via `gh run download`, or an
# `npm pack`'d .tgz scp'd over). --registry installs "what users get today" and
# therefore LACKS the fixes — the script warns loudly when you pick it.
#
# The script is fully self-contained: the self-check (seed → backfill → doctor →
# search) is embedded, so you only need to scp/curl THIS file plus the tarball —
# no repo checkout required on the rented Mac.
#
# Idempotent: every step no-ops cleanly when already done, so a re-run after a
# partial failure is safe. No `sudo` is used — Homebrew node installs into a
# user-writable prefix, sidestepping the /usr/local sudo trap by design.
set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
MODE=registry
REGISTRY_VERSION=latest
TARBALL=""
CI_MODE=false
DRY_RUN=false

usage() {
  # Print the header comment block (everything after the shebang up to the first
  # non-comment line), stripping the leading "# ".
  awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball)
      [ $# -ge 2 ] || { echo "[bootstrap] ERROR: --tarball requires a path or URL" >&2; exit 2; }
      MODE=tarball; TARBALL="$2"; shift 2 ;;
    --registry)
      MODE=registry
      # optional trailing version (anything not starting with '-')
      if [ $# -ge 2 ] && [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then
        REGISTRY_VERSION="$2"; shift 2
      else
        shift
      fi ;;
    --ci) CI_MODE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[bootstrap] ERROR: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[bootstrap] $*"; }
warn() { echo "[bootstrap] WARN: $*" >&2; }
die()  { local code="$1"; shift; echo "[bootstrap] ERROR: $*" >&2; exit "$code"; }

# run <cmd...> — execute, or (in --dry-run) just print the plan line.
run() {
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] would run: $*"
    return 0
  fi
  "$@"
}

# ver_lt A B — true (0) iff version A < version B, comparing major.minor only.
ver_lt() {
  local a="$1" b="$2" amaj amin bmaj bmin
  amaj=${a%%.*}
  bmaj=${b%%.*}
  case "$a" in *.*) amin=${a#*.}; amin=${amin%%.*} ;; *) amin=0 ;; esac
  case "$b" in *.*) bmin=${b#*.}; bmin=${bmin%%.*} ;; *) bmin=0 ;; esac
  [ -n "$amaj" ] || amaj=0; [ -n "$amin" ] || amin=0
  [ -n "$bmaj" ] || bmaj=0; [ -n "$bmin" ] || bmin=0
  if [ "$amaj" -ne "$bmaj" ]; then [ "$amaj" -lt "$bmaj" ]; return; fi
  [ "$amin" -lt "$bmin" ]
}

TMPDIR_BOOT="$(mktemp -d 2>/dev/null || mktemp -d -t recall-bootstrap)"
cleanup() { rm -rf "$TMPDIR_BOOT"; }
trap cleanup EXIT

# The distinctive seed token — unlikely to collide with anything on the box, so
# a search hit unambiguously proves ingest+index worked.
TOKEN="acceptance beacon zarquon"

log "mode=$MODE${MODE:+ }${TARBALL:+tarball=$TARBALL }${REGISTRY_VERSION:+version=$REGISTRY_VERSION }ci=$CI_MODE dry-run=$DRY_RUN"

# ---------------------------------------------------------------------------
# Step 1 — Preflight
# ---------------------------------------------------------------------------
log "STEP 1: preflight (macOS version floor, arch, disk, Xcode CLT)"
OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  if [ "$DRY_RUN" = true ]; then
    warn "Not macOS ($OS) — printing the plan for reference; a real run MUST be on macOS."
  else
    die 2 "This bootstrap targets macOS; detected $OS. Run it on the rented Mac."
  fi
fi
is_darwin() { [ "$OS" = "Darwin" ]; }

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  FLOOR="14.0"; ARCH_LABEL="arm64" ;;
  x86_64) FLOOR="13.7"; ARCH_LABEL="x64" ;;   # Intel Mac: CPU-only embeddings expected
  *)      FLOOR="14.0"; ARCH_LABEL="$ARCH" ;;
esac
log "arch=$ARCH ($ARCH_LABEL); recall macOS floor for this arch = $FLOOR"
[ "$ARCH_LABEL" = "x64" ] && warn "Intel Mac detected — semantic embeddings run CPU-only here (no Metal offload)."

# macOS version floor — mirrors recall's own preflight (WARN below the floor).
if is_darwin; then
  MACOS_VER="$(sw_vers -productVersion 2>/dev/null || true)"
  if [ -z "$MACOS_VER" ]; then
    warn "Could not read macOS version (sw_vers) — skipping the OS-floor check."
  elif ver_lt "$MACOS_VER" "$FLOOR"; then
    warn "macOS $MACOS_VER is BELOW recall's floor ($FLOOR for $ARCH_LABEL) — the bundled llama.cpp binaries may not load; semantic embedding could fail. recall install will FAIL this check."
  else
    log "macOS $MACOS_VER ≥ floor $FLOOR — OK"
  fi
else
  log "[plan] would run: sw_vers -productVersion; warn if < $FLOOR"
fi

# Disk ≥ 5 GB free at $HOME.
if is_darwin; then
  # `|| true` so a df failure yields "" (pipefail would otherwise abort here,
  # nullifying the empty-string tolerance below).
  FREE_GB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}' || true)"
  if [ -n "${FREE_GB:-}" ]; then
    if [ "$FREE_GB" -lt 5 ]; then
      warn "Only ${FREE_GB} GB free at \$HOME — recommend ≥5 GB (binary+model+DB+snapshots)."
    else
      log "Disk: ${FREE_GB} GB free at \$HOME — OK"
    fi
  fi
else
  log "[plan] would run: df -Pk \$HOME; warn if < 5 GB free"
fi

# Xcode Command Line Tools — needed if any native compile is triggered.
if is_darwin; then
  if xcode-select -p >/dev/null 2>&1; then
    log "Xcode Command Line Tools present: $(xcode-select -p)"
  elif [ "$DRY_RUN" = true ]; then
    warn "[dry-run] Xcode Command Line Tools not found — a real run would exit 2 with: xcode-select --install"
  else
    echo "[bootstrap] ERROR: Xcode Command Line Tools not found. Install them, then re-run:" >&2
    echo "    xcode-select --install" >&2
    exit 2
  fi
else
  log "[plan] would run: xcode-select -p (exit 2 + print 'xcode-select --install' if missing)"
fi

# ---------------------------------------------------------------------------
# Step 2 — Homebrew
# ---------------------------------------------------------------------------
log "STEP 2: Homebrew"
# Detect an installed brew by ABSOLUTE path first. A fresh SSH shell on Apple
# Silicon has no /opt/homebrew/bin on PATH until shellenv runs, so `command -v
# brew` would false-miss and needlessly re-run the installer on the two-phase
# re-run (exit-3 → login → re-run). Locate the binary directly, then shellenv it.
find_brew() {
  if [ -x /opt/homebrew/bin/brew ]; then echo /opt/homebrew/bin/brew
  elif [ -x /usr/local/bin/brew ]; then echo /usr/local/bin/brew
  elif command -v brew >/dev/null 2>&1; then command -v brew
  fi
}
BREW="$(find_brew)"
if [ -n "$BREW" ]; then
  log "Homebrew present: $BREW"
elif [ "$DRY_RUN" = true ]; then
  log "[dry-run] would install Homebrew (NONINTERACTIVE=1 official installer)"
else
  log "Installing Homebrew (NONINTERACTIVE)…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  BREW="$(find_brew)"
fi
# Load brew into THIS shell's env for the right prefix (arm64 vs Intel).
if [ -n "$BREW" ]; then
  eval "$("$BREW" shellenv)"
  log "brew shellenv loaded ($BREW)"
elif [ "$DRY_RUN" != true ]; then
  die 2 "Homebrew not available after install step."
fi

# ---------------------------------------------------------------------------
# Step 3 — Node (≥22, ≠23)
# ---------------------------------------------------------------------------
log "STEP 3: Node (require ≥22 and ≠23 — Node 23 has no darwin sqlite prebuild)"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [ -n "$major" ] || return 1
  [ "$major" -ge 22 ] && [ "$major" -ne 23 ]
}
if node_ok; then
  log "Active Node $(node -v) at $(command -v node) is suitable (≥22, ≠23) — using it."
else
  ACTIVE="$(node -v 2>/dev/null || echo none)"
  log "Active Node ($ACTIVE) unsuitable — installing Node via Homebrew…"
  run "$BREW" install node
  [ -n "$BREW" ] && [ "$DRY_RUN" != true ] && eval "$("$BREW" shellenv)"
  if [ "$DRY_RUN" != true ] && ! node_ok; then
    die 4 "Node still unsuitable after 'brew install node' (active: $(node -v 2>/dev/null || echo none)). A shadowing nvm/other Node is likely first on PATH — switch to Node 22 or 24 and re-run."
  fi
fi
[ "$DRY_RUN" = true ] || log "node: $(node -v)  ($(command -v node))"

# ---------------------------------------------------------------------------
# Step 4 — Claude Code + ~/.claude
# ---------------------------------------------------------------------------
log "STEP 4: Claude Code + ~/.claude"
if [ "$CI_MODE" = true ]; then
  # Rehearsal: no login is possible/needed. Substitute the dir the installer
  # requires and SKIP the claude-code install (not exercised by the self-check;
  # its install + login are validated live on the rented Mac).
  run mkdir -p "$HOME/.claude"
  log "--ci: created ~/.claude; skipping Claude Code install + login (login-dependent — validated on the rented Mac)."
else
  if command -v claude >/dev/null 2>&1; then
    log "Claude Code present: $(command -v claude)"
  else
    log "Installing Claude Code (npm install -g @anthropic-ai/claude-code)…"
    run npm install -g @anthropic-ai/claude-code
  fi
  if [ ! -d "$HOME/.claude" ]; then
    if [ "$DRY_RUN" = true ]; then
      log "[dry-run] ~/.claude missing → would instruct: run 'claude', log in, complete one turn, then re-run this script."
    else
      warn "The ~/.claude directory does not exist yet — Claude Code has not been authenticated."
      cat <<'EOF'
[bootstrap] Next steps to create ~/.claude, then continue:
    1) Run:  claude
    2) Log in and complete ONE real turn (this creates ~/.claude).
    3) Re-run this exact bootstrap command — it will pick up from here.
EOF
      exit 3
    fi
  else
    log "Found ~/.claude."
  fi
fi

# ---------------------------------------------------------------------------
# Step 5 — Install recall (per mode)
# ---------------------------------------------------------------------------
log "STEP 5: install crispy-recall ($MODE)"
case "$MODE" in
  tarball)
    LOCAL_TGZ="$TARBALL"
    if [ -z "$TARBALL" ]; then die 5 "--tarball mode but no tarball given."; fi
    case "$TARBALL" in
      http://*|https://*)
        LOCAL_TGZ="$TMPDIR_BOOT/crispy-recall-download.tgz"
        log "Downloading tarball → $LOCAL_TGZ"
        run curl -fsSL -o "$LOCAL_TGZ" "$TARBALL"
        ;;
      *)
        # Resolve a single-file glob for convenience (e.g. crispy-recall-*.tgz).
        if [ ! -f "$TARBALL" ]; then
          # shellcheck disable=SC2086
          set -- $TARBALL
          if [ "$#" -eq 1 ] && [ -f "$1" ]; then LOCAL_TGZ="$1"; TARBALL="$1"; fi
        fi
        [ "$DRY_RUN" = true ] || [ -f "$LOCAL_TGZ" ] || die 5 "tarball not found: $TARBALL"
        ;;
    esac
    log "npm install -g $LOCAL_TGZ"
    run npm install -g "$LOCAL_TGZ"
    ;;
  registry)
    warn "Registry install = the PUBLISHED build; it does NOT contain the unreleased Phase-2 macOS fixes. Use --tarball to acceptance-test the fixes."
    log "npm install -g crispy-recall@$REGISTRY_VERSION"
    run npm install -g "crispy-recall@$REGISTRY_VERSION"
    ;;
esac
if [ "$DRY_RUN" != true ] && ! command -v recall >/dev/null 2>&1; then
  die 5 "'recall' is not on PATH after install — check the npm global prefix is on PATH."
fi
[ "$DRY_RUN" = true ] || log "recall on PATH: $(command -v recall)"

# ---------------------------------------------------------------------------
# Step 6 — recall install (resident setup)
# ---------------------------------------------------------------------------
log "STEP 6: recall install (resident setup: ~/.recall + Stop hook + skill)"
if [ "$CI_MODE" = true ]; then
  log "recall install --yes --no-backfill (headless + deterministic; explicit backfill runs in the self-check)"
  run recall install --yes --no-backfill
else
  log "recall install (INTERACTIVE — the consent prompts ARE part of acceptance; do not hide them)"
  run recall install
fi

# ---------------------------------------------------------------------------
# Step 7 — Self-check (seed → backfill → doctor --json → search)
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
  log "STEP 7: [dry-run] would self-check: seed a synthetic session → recall backfill --auto-embed → recall doctor --json (assert binding health) → recall '<token>' --raw --all (assert hit + semantic)"
  log "STEP 8: [dry-run] would print PASS/FAIL table + acceptance-ready banner"
  log "[dry-run] plan complete — nothing was executed."
  exit 0
fi

write_helpers() {
  cat > "$TMPDIR_BOOT/seed.cjs" <<'EOF'
'use strict';
const { mkdirSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const token = process.env.SEED_TOKEN || 'acceptance beacon zarquon';
const home = process.env.SEED_HOME || homedir();
const cwd = join(home, 'recall-acceptance-project');
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const dir = join(home, '.claude', 'projects', slug);
mkdirSync(dir, { recursive: true });
const sid = 'recall-acceptance-session';
const file = join(dir, sid + '.jsonl');
const ts = '2026-07-05T10:00:00.000Z';
const user = (n, text) => JSON.stringify({ type: 'user', uuid: sid + '-u' + n, parentUuid: null, sessionId: sid, cwd: cwd, timestamp: ts, message: { role: 'user', content: text } });
const asst = (n, text) => JSON.stringify({ type: 'assistant', uuid: sid + '-a' + n, parentUuid: null, sessionId: sid, cwd: cwd, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: text }] } });
const lines = [
  user(1, 'Please help me tune the ' + token + ' indexing pipeline so retrieval stays deterministic across runs.'),
  asst(1, 'I tuned the ' + token + ' pipeline: fixed the ordering, added a stable sort, and documented the retrieval contract.'),
  user(2, 'Great, now add a regression test that locks the ' + token + ' behaviour so future refactors cannot silently break it.'),
];
writeFileSync(file, lines.join('\n') + '\n');
process.stdout.write(JSON.stringify({ file: file, sid: sid, cwd: cwd }) + '\n');
EOF

  cat > "$TMPDIR_BOOT/assert-doctor.cjs" <<'EOF'
'use strict';
const { readFileSync } = require('node:fs');
const f = process.argv[2];
if (!f) { console.error('assert-doctor: pass doctor.json'); process.exit(2); }
let doc;
try { doc = JSON.parse(readFileSync(f, 'utf-8')); }
catch (e) { console.error('assert-doctor: invalid JSON: ' + e.message); process.exit(1); }
const b = doc.binding || {};
const want = { bindingLoads: true, journalMode: 'wal', pinnedNodeOk: true, abiOk: true, markerPresent: true };
const fails = Object.entries(want).filter(function (kv) { return b[kv[0]] !== kv[1]; });
if (fails.length) {
  console.error('DOCTOR ASSERT FAIL — binding health mismatch:');
  fails.forEach(function (kv) { console.error('  ' + kv[0] + ': got ' + JSON.stringify(b[kv[0]]) + ', want ' + JSON.stringify(kv[1])); });
  if (Array.isArray(b.problems)) b.problems.forEach(function (p) { console.error('  problem: ' + p); });
  process.exit(1);
}
console.log('doctor OK — bindingLoads=true journalMode=wal pinnedNodeOk=true abiOk=true markerPresent=true (embedder=' + ((doc.embedder && doc.embedder.mode) || 'n/a') + ')');
EOF

  cat > "$TMPDIR_BOOT/assert-search.cjs" <<'EOF'
'use strict';
const { readFileSync } = require('node:fs');
const f = process.argv[2];
const requireSemantic = process.argv.includes('--require-semantic');
if (!f) { console.error('assert-search: pass search.json'); process.exit(2); }
let d;
try { d = JSON.parse(readFileSync(f, 'utf-8')); }
catch (e) { console.error('assert-search: invalid JSON: ' + e.message); process.exit(1); }
const errs = [];
if (!(Number(d.total_messages) >= 1)) errs.push('expected >=1 hit, got total_messages=' + d.total_messages);
if (requireSemantic && d.semantic_available !== true) errs.push('semantic_available=' + d.semantic_available + ' (want true)');
if (errs.length) {
  console.error('SEARCH ASSERT FAIL: ' + errs.join('; '));
  console.error('  query="' + d.query + '" total=' + d.total_messages + ' fts=' + d.fts_count + ' semantic=' + d.semantic_count + ' semantic_available=' + d.semantic_available);
  process.exit(1);
}
console.log('search OK — query="' + d.query + '" total=' + d.total_messages + ' fts=' + d.fts_count + ' semantic=' + d.semantic_count + ' semantic_available=' + d.semantic_available + (requireSemantic ? ' [semantic required]' : ''));
EOF

  cat > "$TMPDIR_BOOT/force-cpu.cjs" <<'EOF'
'use strict';
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, dirname } = require('node:path');
const root = (process.env.RECALL_HOME && process.env.RECALL_HOME.length > 0) ? process.env.RECALL_HOME : join(homedir(), '.recall');
const p = join(root, 'config.json');
let cfg = {};
try { cfg = JSON.parse(readFileSync(p, 'utf-8')); } catch (e) { /* absent — CPU is the safe default */ }
cfg.embedder = { mode: 'cpu', ngl: 0, libDir: null, detectedAt: '' };
mkdirSync(dirname(p), { recursive: true });
writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('forced embedder.mode=cpu at ' + p);
EOF
}

self_check() {
  log "STEP 7: self-check (seed → backfill → doctor → search)"
  write_helpers

  local DOCTOR=FAIL HIT=FAIL SEM=FAIL

  log "Seeding a synthetic session (token: \"$TOKEN\")…"
  SEED_TOKEN="$TOKEN" SEED_HOME="$HOME" node "$TMPDIR_BOOT/seed.cjs" \
    || die 1 "self-check seed failed — could not write the synthetic session (check ~/.claude is writable)."

  log "recall backfill --auto-embed (ingest + embed)…"
  recall backfill --auto-embed || warn "backfill returned non-zero (continuing to assertions)"

  log "recall doctor --json → asserting native-WAL binding health…"
  recall doctor --json > "$TMPDIR_BOOT/doctor.json" || true
  cat "$TMPDIR_BOOT/doctor.json" || true
  if node "$TMPDIR_BOOT/assert-doctor.cjs" "$TMPDIR_BOOT/doctor.json"; then DOCTOR=PASS; fi

  log "recall \"$TOKEN\" --raw --all → asserting search hit + semantic availability…"
  recall "$TOKEN" --raw --all > "$TMPDIR_BOOT/search.json" || true
  echo "--- human output (Paths: line) ---"
  recall "$TOKEN" --all || true

  # Semantic availability, with a Metal-flake CPU fallback in --ci only. On a real
  # Mac (non-ci) we do NOT mutate the embedder — observing real Metal behaviour is
  # itself part of acceptance — so semantic-unavailable degrades to WARN there.
  if node "$TMPDIR_BOOT/assert-search.cjs" "$TMPDIR_BOOT/search.json" --require-semantic; then
    SEM=PASS
  elif [ "$CI_MODE" = true ]; then
    warn "Semantic UNAVAILABLE first pass — suspected Metal flake on the paravirtual device. Forcing CPU + re-embedding."
    node "$TMPDIR_BOOT/force-cpu.cjs"
    recall backfill --auto-embed || true
    recall "$TOKEN" --raw --all > "$TMPDIR_BOOT/search.json" || true
    if node "$TMPDIR_BOOT/assert-search.cjs" "$TMPDIR_BOOT/search.json" --require-semantic; then SEM=PASS; else SEM=FAIL; fi
  else
    SEM=WARN
  fi

  # Hard gate: at least one hit (FTS guarantees it for our distinctive token).
  if node "$TMPDIR_BOOT/assert-search.cjs" "$TMPDIR_BOOT/search.json"; then HIT=PASS; fi

  # ---- verdict ----
  local overall=PASS
  [ "$DOCTOR" = PASS ] || overall=FAIL
  [ "$HIT" = PASS ] || overall=FAIL
  if [ "$CI_MODE" = true ]; then [ "$SEM" = PASS ] || overall=FAIL; fi

  echo ""
  log "----------------- SELF-CHECK -----------------"
  log "  doctor binding health : $DOCTOR"
  log "  search hit (FTS)      : $HIT"
  log "  semantic available    : $SEM$([ "$SEM" = WARN ] && echo '  (non-ci: informational — verify live Metal in the runbook)')"
  log "----------------------------------------------"
  log "SELF-CHECK: $overall"

  if [ "$overall" != PASS ]; then
    die 1 "Self-check FAILED — see the table above and \`recall doctor\` output."
  fi
}

self_check

# ---------------------------------------------------------------------------
# Step 8 — Final banner
# ---------------------------------------------------------------------------
echo ""
log "=============================================="
log " ACCEPTANCE-READY."
log " recall is installed and self-checked green."
log " Next: follow the acceptance runbook (sections C–H):"
log "   C. Live Stop-hook   D. Metal reality   E. brew-upgrade lifecycle"
log "   F. git attribution  G. evidence capture  H. teardown (DELETE the instance)"
log "=============================================="
recall status || true
