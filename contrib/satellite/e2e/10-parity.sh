#!/usr/bin/env bash
# 10-parity.sh — spec §9.1.3: parity on a FROZEN snapshot of the hub DB.
#
# The snapshot root (default $HOME/.recall-parity) holds recall.db (VACUUM INTO
# copy), config.json, a bin/ of per-file links to the live runtime and an empty
# claude/codex root pair so no catch-up scan can change the frozen data.
#
# Modes (one PASS/FAIL line each, exit 0 on PASS):
#   pre    — (i) oracle self-check at the branch base: every query twice, cmp.
#            Saves runs/pre-<n>.txt. A query whose pair differs is marked
#            DEGRADED and compared by ordered session-id list from then on.
#   post   — (ii) parity at the branch head: runs/post-<n>.txt vs pre. Codex
#            message ids are normalised (U0 re-keys codex-jsonl-<8hex>-N to
#            codex-jsonl-<uuid>-N; the counter is stable). A byte diff falls
#            back to the ordered session-id list; a session that vanished is
#            tolerated only when the migrated snapshot classifies it
#            kind='agent' (U0's session_meta cap fix reclassifies leaked child
#            rollouts) — anything else is FAIL.
#   pre-raw  — (ii') capture the UNPAGINATED result set (--all --raw-messages
#            --limit 100000) with the BASE binary on a base root
#            ($RECALL_PARITY_BASE: a fresh un-migrated snapshot). Saves
#            $RECALL_PARITY_BASE/runs/pre-raw-<n>.json.
#   post-raw — (ii') same capture at the branch head on the migrated root and
#            compare session sets: a lost CLAUDE session is always FAIL
#            (U0/U1 never rewrite Claude rows); a lost CODEX session is
#            tolerated only when the migrated root classes it kind='agent'
#            (spec §5 session_meta cap: leaked child rollouts leave default
#            retrieval) or lost at least one of its base-root rows by text
#            (the ingest-time isMeta filter drops boilerplate rows on §5's
#            force re-ingest, even when restored collision siblings make the
#            session larger overall) or was re-keyed by §5 at all (its rows
#            AND vectors were rebuilt, so a tail-of-pool semantic candidate
#            may cross the cutoff); post must still contain ≥1 Codex
#            session; the top-50 Claude message ids of the base run must
#            all be present at head. This is the (ii) gate once U0's
#            migration has changed Codex content; `post` (table view) stays
#            valid only while content is unchanged (U1 alone).
#   scope  — (iii) scope-change proof: the same queries WITHOUT --all from
#            $RECALL_MAIN_CHECKOUT, on the UNPAGINATED per-message list
#            (--raw-messages --limit 100000; the table view pages 75 sessions
#            and a larger candidate pool displaces pre-set sessions by rank);
#            pre session set ⊆ post session set (a lost session tolerated by
#            the same rule as post-raw) and post contains ≥1 session whose
#            project_id is under $RECALL_E2E_HUB_REPO/ or
#            $RECALL_E2E_HUB_REPO-agent-fix-*.
#
# Env: RECALL_PARITY_HOME, RECALL_INT_WORKTREE (dist/recall.js to run),
#      RECALL_MAIN_CHECKOUT (cwd for scope mode), RECALL_E2E_HUB_REPO (the
#      hub-side repo path the scope gate looks for), RECALL_PARITY_BASE +
#      RECALL_BASE_WORKTREE (base root and base build for pre-raw), and
#      RECALL_NODE (or RECALL_E2E_NODE) for the node binary. No default is
#      personal; see README.md, "Environment".
set -u
S=${RECALL_PARITY_HOME:-$HOME/.recall-parity}
INT=${RECALL_INT_WORKTREE:-}
MAIN=${RECALL_MAIN_CHECKOUT:-}
RUNS=$S/runs
CLI=$INT/dist/recall.js
B=${RECALL_PARITY_BASE:-$HOME/.recall-parity-base}
BASEWT=${RECALL_BASE_WORKTREE:-}
HUB_REPO=${RECALL_E2E_HUB_REPO:-}
NODE=${RECALL_NODE:-${RECALL_E2E_NODE:-}}
mkdir -p "$RUNS"

# This script does NOT source lib.sh (it runs against a snapshot root, not the
# live hub), so it carries its own gate. Both print the FAIL vocabulary.
need_env() { # $1.. variable names — none of them has a personal default
  local v
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then
      echo "FAIL 10-parity ${mode:-<no mode>} — set $v (see contrib/satellite/e2e/README.md, \"Environment\")" >&2
      exit 1
    fi
  done
}
need_node() {
  [ -n "$NODE" ] || {
    echo "FAIL 10-parity ${mode:-<no mode>} — set RECALL_NODE or RECALL_E2E_NODE to the node binary" >&2
    exit 1
  }
}

QUERIES=(
  "VACUUM INTO snapshot of the recall database"
  "Tailscale SSH check mode authenticate URL"
  "isMeta boilerplate filter at ingest"
  "nomic search_document search_query prefix"
  "LoCoMo recall@5 DRAGON baseline"
)

run_query() { # $1 query, $2 out file, $3 extra args (e.g. --all), $4 cwd
  ( cd "$4" && RECALL_HOME="$S" RECALL_LOG_LEVEL=error \
      CLAUDE_CONFIG_DIR="$S/empty-claude" CODEX_HOME="$S/empty-codex" \
      "$NODE" "$CLI" "$1" $3 --no-catchup > "$2" 2> "$2.err" )
}
normalise() { # fold full-uuid codex ids back to the legacy 8-hex form
  sed -E 's/codex-jsonl-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/codex-jsonl-\1-/g' "$1"
}
session_list() { # ordered session ids from the result table
  awk '/^ +[0-9]+ +[0-9a-f-]{36} /{print $2}' "$1"
}
run_query_base() { # $1 query, $2 out file — base binary on the base root
  ( cd "$B" && RECALL_HOME="$B" RECALL_LOG_LEVEL=error \
      CLAUDE_CONFIG_DIR="$B/empty-claude" CODEX_HOME="$B/empty-codex" \
      "$NODE" "$BASEWT/dist/recall.js" "$1" --all --raw-messages --limit 100000 --no-catchup > "$2" 2> "$2.err" )
}
# classify_lost PRE.json POST.json [top50]: prints one summary line, exits 0 when
# every lost session is explained (see header) and, with top50, when the base
# run's top-50 Claude message ids are all present at head.
classify_lost() {
  python3 - "$1" "$2" "$S/recall.db" "$B/recall.db" "${3:-}" <<'PY'
import json,sqlite3,sys
pre=json.load(open(sys.argv[1])); post=json.load(open(sys.argv[2]))
cs=sqlite3.connect('file:%s?mode=ro'%sys.argv[3], uri=True)
cb=sqlite3.connect('file:%s?mode=ro'%sys.argv[4], uri=True) if sys.argv[4] and __import__('os').path.exists(sys.argv[4]) else None
codex=lambda s: len(s)==36 and s[14]=='7' and s.startswith('01')
ps={m['session_id'] for m in pre['messages']}; qs={m['session_id'] for m in post['messages']}
lost=sorted(ps-qs)
def rows(c,s): return c.execute("SELECT COUNT(*) FROM messages WHERE session_id=?",(s,)).fetchone()[0] if c else -1
def kind(s):
    r=cs.execute("SELECT kind FROM session_provenance WHERE session_id=?",(s,)).fetchone(); return r[0] if r else 'none'
claude_lost=[s for s in lost if not codex(s) and rows(cs,s)>0]
agent=[s for s in lost if codex(s) and kind(s)=='agent']
def dropped(s): # ≥1 base row of this session whose text no longer exists at head (isMeta filter on force re-ingest)
    if cb is None: return False
    texts={r[0] for r in cs.execute("SELECT message_text FROM messages WHERE session_id=?",(s,))}
    return any(r[0] not in texts for r in cb.execute("SELECT message_text FROM messages WHERE session_id=?",(s,)))
fewer=[s for s in lost if codex(s) and kind(s)!='agent' and rows(cs,s)>0 and dropped(s)]
def rekeyed(s): # base held 8-hex codex ids for this session and head holds none → §5 force re-ingest rebuilt its rows AND vectors
    if cb is None: return False
    LEGACY="message_id LIKE 'codex-jsonl-%' AND message_id NOT LIKE 'codex-jsonl-________-____-____-____-____________-%'"
    b=cb.execute("SELECT COUNT(*) FROM messages WHERE session_id=? AND "+LEGACY,(s,)).fetchone()[0]
    h=cs.execute("SELECT COUNT(*) FROM messages WHERE session_id=? AND "+LEGACY,(s,)).fetchone()[0]
    return b>0 and h==0
reemb=[s for s in lost if codex(s) and kind(s)!='agent' and rows(cs,s)>0 and not dropped(s) and rekeyed(s)]
absent=[s for s in lost if rows(cs,s)==0]
unexpl=[s for s in lost if s not in claude_lost and s not in agent and s not in fewer and s not in reemb and s not in absent]
codex_present=any(codex(m['session_id']) for m in post['messages'])
top_missing=[]
if sys.argv[5]:
    top=[m['message_id'] for m in sorted(pre['messages'],key=lambda m:m['rank']) if not codex(m['session_id'])][:50]
    ids={m['message_id'] for m in post['messages']}
    top_missing=[i for i in top if i not in ids]
ok = not claude_lost and not unexpl and not top_missing and codex_present
print(f"pre={len(ps)} post={len(qs)} lost={len(lost)} claude_lost={len(claude_lost)} codex_agent={len(agent)} codex_rows_dropped={len(fewer)} codex_reembedded_only={len(reemb)} absent_from_snapshot={len(absent)} unexplained={len(unexpl)} top50_claude_missing={len(top_missing)} codex_present={int(codex_present)} new={len(qs-ps)}", end='')
for s in (claude_lost+unexpl)[:5]: print(f" [{s} kind={kind(s)} rows={rows(cs,s)}/{rows(cb,s)}]", end='')
print()
sys.exit(0 if ok else 1)
PY
}
json_sessions() { # every session id in a --raw-messages JSON (unpaginated, pre-shaping)
  python3 -c 'import json,sys; [print(m["session_id"]) for m in json.load(open(sys.argv[1]))["messages"]]' "$1"
}

mode=${1:-}
fail=0
case "$mode" in
  pre)
    need_node; need_env RECALL_INT_WORKTREE
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      run_query "$q" "$RUNS/pre-$n.txt" "--all" "$S"
      run_query "$q" "$RUNS/pre-$n.b.txt" "--all" "$S"
      rows=$(session_list "$RUNS/pre-$n.txt" | wc -l)
      if cmp -s "$RUNS/pre-$n.txt" "$RUNS/pre-$n.b.txt"; then
        echo "  q$n rows=$rows oracle=stable"; rm -f "$RUNS/pre-$n.degraded"
      else
        if [ "$(session_list "$RUNS/pre-$n.txt")" = "$(session_list "$RUNS/pre-$n.b.txt")" ]; then
          echo "  q$n rows=$rows oracle=DEGRADED (byte diff, session order stable)"; : > "$RUNS/pre-$n.degraded"
        else
          echo "  q$n rows=$rows oracle=UNSTABLE (session order differs between two runs)"; fail=1
        fi
      fi
      [ "$rows" -ge 1 ] || { echo "  q$n returned no rows"; fail=1; }
    done
    ;;
  post)
    need_node; need_env RECALL_INT_WORKTREE
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      [ -f "$RUNS/pre-$n.txt" ] || { echo "  q$n: no pre run"; fail=1; continue; }
      run_query "$q" "$RUNS/post-$n.txt" "--all" "$S"
      if [ ! -f "$RUNS/pre-$n.degraded" ] && cmp -s <(normalise "$RUNS/pre-$n.txt") <(normalise "$RUNS/post-$n.txt"); then
        echo "  q$n byte-identical (after codex-id normalisation)"; continue
      fi
      pre_l=$(session_list "$RUNS/pre-$n.txt"); post_l=$(session_list "$RUNS/post-$n.txt")
      if [ "$pre_l" = "$post_l" ]; then echo "  q$n session order identical"; continue; fi
      # tolerate only sessions the migrated snapshot now classes as agent
      missing=$(comm -23 <(echo "$pre_l" | sort) <(echo "$post_l" | sort))
      bad=0
      for sid in $missing; do
        k=$(sqlite3 -readonly "$S/recall.db" "SELECT kind FROM session_provenance WHERE session_id='$sid'")
        [ "$k" = "agent" ] || { echo "  q$n session $sid vanished and is not agent-classed (kind=${k:-none})"; bad=1; }
      done
      pre_f=$(echo "$pre_l" | grep -vxF -f <(echo "$missing") || true)
      if [ "$bad" = 0 ] && [ "$pre_f" = "$post_l" ]; then
        echo "  q$n session order identical after removing $(echo "$missing" | grep -c .) agent-reclassified session(s)"
      else
        echo "  q$n session order DIFFERS"; diff <(echo "$pre_l") <(echo "$post_l") | head -20; fail=1
      fi
    done
    ;;
  scope)
    need_node; need_env RECALL_INT_WORKTREE RECALL_MAIN_CHECKOUT RECALL_E2E_HUB_REPO
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      run_query "$q" "$RUNS/scope-post-$n.json" "--raw-messages --limit 100000" "$MAIN"
      [ -f "$RUNS/scope-pre-$n.json" ] || { echo "  q$n: no scope-pre run (run 'scope-pre' at the branch base first)"; fail=1; continue; }
      pre_s=$(json_sessions "$RUNS/scope-pre-$n.json" | sort -u); post_s=$(json_sessions "$RUNS/scope-post-$n.json" | sort -u)
      lost=$(comm -23 <(echo "$pre_s") <(echo "$post_s") | grep -c . || true)
      lost_ok=1
      if [ "$lost" != 0 ]; then
        if out=$(classify_lost "$RUNS/scope-pre-$n.json" "$RUNS/scope-post-$n.json"); then lost_ok=1; else lost_ok=0; fi
        echo "  q$n lost-set: $out"
      fi
      hit=0
      for sid in $post_s; do
        c=$(sqlite3 -readonly "$S/recall.db" "SELECT COUNT(*) FROM messages WHERE session_id='$sid' AND (project_id LIKE '$HUB_REPO/%' OR project_id LIKE '$HUB_REPO-agent-fix-%')")
        [ "$c" -gt 0 ] && { hit=1; break; }
      done
      echo "  q$n pre=$(echo "$pre_s" | grep -c .) post=$(echo "$post_s" | grep -c .) lost=$lost lost_explained=$lost_ok worktree_or_subdir_hit=$hit"
      { [ "$lost_ok" = 1 ] && [ "$hit" = 1 ]; } || fail=1
    done
    ;;
  scope-pre)
    need_node; need_env RECALL_INT_WORKTREE RECALL_MAIN_CHECKOUT
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      run_query "$q" "$RUNS/scope-pre-$n.json" "--raw-messages --limit 100000" "$MAIN"
      echo "  q$n scope-pre sessions=$(json_sessions "$RUNS/scope-pre-$n.json" | sort -u | wc -l)"
    done
    ;;
  pre-raw)
    need_node; need_env RECALL_BASE_WORKTREE
    [ -d "$B" ] && [ -f "$B/recall.db" ] || { echo "  base root $B missing (VACUUM INTO a fresh live snapshot there first)"; exit 2; }
    mkdir -p "$B/runs"
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      run_query_base "$q" "$B/runs/pre-raw-$n.json"
      echo "  q$n pre-raw sessions=$(json_sessions "$B/runs/pre-raw-$n.json" | sort -u | wc -l)"
    done
    ;;
  post-raw)
    need_node; need_env RECALL_INT_WORKTREE
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      [ -f "$B/runs/pre-raw-$n.json" ] || { echo "  q$n: no pre-raw run (run 'pre-raw' first)"; fail=1; continue; }
      run_query "$q" "$RUNS/post-raw-$n.json" "--all --raw-messages --limit 100000" "$S"
      if out=$(classify_lost "$B/runs/pre-raw-$n.json" "$RUNS/post-raw-$n.json" top50); then echo "  q$n $out"; else echo "  q$n $out"; fail=1; fi
    done
    ;;
  *) echo "usage: $0 pre|post|pre-raw|post-raw|scope-pre|scope"; exit 2;;
esac
if [ "$fail" = 0 ]; then echo "PASS 10-parity $mode"; exit 0; else echo "FAIL 10-parity $mode"; exit 1; fi
