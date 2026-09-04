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
#   scope  — (iii) scope-change proof: the same queries WITHOUT --all from
#            /home/silver/dev/recall, on the UNPAGINATED per-message list
#            (--raw-messages --limit 100000; the table view pages 75 sessions
#            and a larger candidate pool displaces pre-set sessions by rank);
#            pre session set ⊆ post session set and post contains ≥1
#            session whose project_id is under /home/silver/dev/recall/ or
#            /home/silver/dev/recall-agent-fix-*.
#
# Env: RECALL_PARITY_HOME, RECALL_INT_WORKTREE (dist/recall.js to run),
#      RECALL_MAIN_CHECKOUT (cwd for scope mode).
set -u
S=${RECALL_PARITY_HOME:-$HOME/.recall-parity}
INT=${RECALL_INT_WORKTREE:-/home/silver/dev/recall-sat-int}
MAIN=${RECALL_MAIN_CHECKOUT:-/home/silver/dev/recall}
RUNS=$S/runs
CLI=$INT/dist/recall.js
NODE=${RECALL_NODE:-/home/silver/.nvm/versions/node/v22.18.0/bin/node}
mkdir -p "$RUNS"

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
json_sessions() { # every session id in a --raw-messages JSON (unpaginated, pre-shaping)
  python3 -c 'import json,sys; [print(m["session_id"]) for m in json.load(open(sys.argv[1]))["messages"]]' "$1"
}

mode=${1:-}
fail=0
case "$mode" in
  pre)
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
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      run_query "$q" "$RUNS/scope-post-$n.json" "--raw-messages --limit 100000" "$MAIN"
      [ -f "$RUNS/scope-pre-$n.json" ] || { echo "  q$n: no scope-pre run (run 'scope-pre' at the branch base first)"; fail=1; continue; }
      pre_s=$(json_sessions "$RUNS/scope-pre-$n.json" | sort -u); post_s=$(json_sessions "$RUNS/scope-post-$n.json" | sort -u)
      lost=$(comm -23 <(echo "$pre_s") <(echo "$post_s") | grep -c . || true)
      hit=0
      for sid in $post_s; do
        c=$(sqlite3 -readonly "$S/recall.db" "SELECT COUNT(*) FROM messages WHERE session_id='$sid' AND (project_id LIKE '/home/silver/dev/recall/%' OR project_id LIKE '/home/silver/dev/recall-agent-fix-%')")
        [ "$c" -gt 0 ] && { hit=1; break; }
      done
      echo "  q$n pre=$(echo "$pre_s" | grep -c .) post=$(echo "$post_s" | grep -c .) lost=$lost worktree_or_subdir_hit=$hit"
      { [ "$lost" = 0 ] && [ "$hit" = 1 ]; } || fail=1
    done
    ;;
  scope-pre)
    for i in "${!QUERIES[@]}"; do
      n=$((i+1)); q=${QUERIES[$i]}
      run_query "$q" "$RUNS/scope-pre-$n.json" "--raw-messages --limit 100000" "$MAIN"
      echo "  q$n scope-pre sessions=$(json_sessions "$RUNS/scope-pre-$n.json" | sort -u | wc -l)"
    done
    ;;
  *) echo "usage: $0 pre|post|scope-pre|scope"; exit 2;;
esac
if [ "$fail" = 0 ]; then echo "PASS 10-parity $mode"; exit 0; else echo "FAIL 10-parity $mode"; exit 1; fi
