# BENCH-REPORT — agent-fix/fable

## Header

| Field | Value |
|---|---|
| Model slug | `fable` |
| Pinned base commit | `f2f8173c5d87d7e500c8ddc6f188020e6e223b28` (`docs: replace README for 0.2.2`) |
| Branch | `agent-fix/fable` |
| Final implementation commit | `f92beb9e81fa1dde96a922065cfca9cf9158bcc9` (this report is committed on top of it; `git rev-parse agent-fix/fable` is authoritative) |
| Wall-clock start | 2026-07-10 ~18:50 UTC (worktree creation + baseline) |
| Wall-clock end | 2026-07-10 ~20:55 UTC |
| Baseline verification | `npm test` at the pinned commit: **273/273 passed, exit 0** before any change |

Commit sequence (reviewable increments, one per workstream phase):

1. `d2087d0` — Workstream C: daemonless cross-process query embedding coordinator
2. `9d56627` — Workstream B: opaque, round-trippable session/message ID reads
3. `044f258` — Workstream A: agent-leaf messages cold-but-durable + classification
4. `e447f7b` — Workstream A migration: attended, WAL-safe, idempotent
5. `8627678` — docs (README, gated GPU acceptance test)
6. `f92beb9` — fixes from an independent adversarial review (see below)
7. (this commit) — BENCH-REPORT.md

**Independent adversarial review.** A read-only sub-agent adversarially reviewed the coordinator, migration, store guards, and classifier before finalization. It confirmed the central invariants (no response mis-routing, no direct-embed fallback path, marker-gate atomicity for fresh DBs, crash-rollback recovery, hot-guard completeness, no child-under-parent-id path, no alias cycles or classification flip-flop) and surfaced one real invariant hole plus two hardening items, all fixed in `f92beb9`: (a) a legitimate leadership tenure (20 rounds × 5-min compute deadline) could outlive the 10-min lock-age reap backstop, letting a follower reap a LIVE leader mid-embed and spawn a second concurrent model load — leaders now stop starting rounds after a 2-min tenure and the reap age is floored above tenure + one compute deadline; (b) the migration's drain-quiesce could read a mid-`wx`-create `embed.lock` as empty and misjudge it quiesced — now retried; (c) a failed snapshot left a partial file — now removed. Accepted residuals it identified are listed under Known gaps.

## DoD table (§11)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Agent/subagent messages durable + explicitly readable | done | `test/integration/agent-cold.test.ts :: child messages remain explicitly readable by session and message id`; `retrieval-class-migration.test.ts :: migrates in place …` (explicit reads post-migration) |
| 2 | Claude + Codex children classified from vendor/path/hook provenance, not only ID shape | done | `test/unit/session-classifier.test.ts` (path layout, session-meta `source.subagent.thread_spawn`, hook evidence, stored provenance, malformed→conservative) |
| 3 | Agent rows excluded from default FTS, semantic, lists, grep, vectors, every gap/backfill selector | done | `agent-cold.test.ts :: parent narration hits default FTS; child-only tokens do not`, `:: no child vector exists; child rows appear in NO embedding-gap selector`, `:: normal list and default grep exclude children`, `:: semantic search returns hot rows only` |
| 4 | `insertMessageVectors` hot-guarded (drain cannot resurrect a cold vector) | done | `agent-cold.test.ts :: the vector WRITE is hot-guarded…`; guard at `src/recall/message-store.ts` (INSERT…SELECT with class predicate inside BEGIN IMMEDIATE) |
| 5 | Filtered external-content FTS rebuild + **rank-1** integrity proven; all repair paths preserve it | done | `test/unit/fts-filtered-view.test.ts` (9 tests: 4-state triggers, filtered rebuild, rank-1 rejects mismatch that rank-less passes, transactional DDL + rollback, old-`ensureSchema` no-op); `retrieval-class-migration.test.ts :: repair --fts and --vectors + T1 rescans do not resurrect cold content` |
| 6 | Migration attended, WAL-safe-snapshot-backed (failure aborts), durable-marker-gated, idempotent, crash-safe, history-preserving | done | `retrieval-class-migration.test.ts` (12 tests: byte-for-byte preservation, WAL-frame snapshot + restore, failed snapshot aborts, crash-rollback recovery, idempotent rerun, concurrent opener fails closed, drain/backfill quiesce aborts, hook-restore on abort); `install-upgrade.test.ts` (attended wiring over a legacy wasm/delete-mode DB) |
| 7 | Stop-hook/T1 identity reconciliation prevents duplicate Codex children | done | `agent-cold.test.ts :: SubagentStop → T1 mtime-scan: ONE canonical Codex child even when hook agent_id differs`; `codex-path.test.ts :: SubagentStop WITHOUT agent_id still targets the child` |
| 8 | `agent-*` and `codex-jsonl-*` reads work with opaque literal prefixes | done | `test/integration/cli-opaque-reads.test.ts` (16 built-bundle tests incl. `%`/`_`/uppercase/descriptive IDs and the LIKE-wildcard trap) |
| 9 | Human output round-trippable; failed reads never become semantic searches | done | `cli-opaque-reads.test.ts :: every displayed search reference round-trips…`, `:: the human search table shows full IDs…`, `:: the --list table…`, `:: nonexistent session-shaped reference … never embeds` |
| 10 | Concurrent CLI bursts → at most one query model load per overlapping batch | done | `test/integration/query-coordinator.test.ts :: a synchronized burst of 7 CLIs … coalesces into ONE one-shot invocation` (exactly 1 invocation asserted; timing rationale in file header), `:: default coalescing window … max ONE concurrent` |
| 11 | Coordinator uses only the one-shot path, never llama-server; stale-leader reap TOCTOU-safe | done | burst test uses 7 (>5) queries with a fake `llama-server` that records any invocation (asserted empty); `:: two followers racing a DEAD leader lock elect exactly one replacement (TOCTOU reap)`; rename-verify-delete protocol at `src/recall/query-embed-coordinator.ts` (reapAndAcquire) + pre-spawn ownership re-verify |
| 12 | Multiword and `agent-`-prefixed searches remain expressible; documented force-search escape | done | `cli-opaque-reads.test.ts :: multiword searches still search: agent-based retrieval…`, `:: a quoted multiword phrase … reaches search`, `:: the documented force-search escape works`; failed-read errors name `recall search` |
| 13 | Leader death and malformed/stale IPC recover without hangs or fan-out | done | `query-coordinator.test.ts :: SIGKILLed leader is replaced without hanging or fan-out`, `:: corrupt and stale artifacts … are reaped`, `:: SIGTERM mid-coordination cleans up`; `test/unit/query-embed-coordinator.test.ts` (error propagation → FTS-only, live-lock never stolen, no direct-embed fallback) |
| 14 | No daemon/process/artifact after clean exits; crash remnants inert + reaped on next entry | done | every fake-backend test asserts the `run/query-embed` dir is empty after clean exits; the SIGKILL test asserts a fresh invocation reaps leftovers and that the only child (one-shot `llama-embedding`) self-terminates |
| 15 | Embed-lock behavior, Stop ingestion, T1, commit/blame, repair, root retrieval green | done | full suite green including untouched `embed-lockfile`, `git-attribution`, `repair-full`, `wal-*`, `backfill-idempotency`, `mtime-scan` suites |
| 16 | Typecheck, build, focused integration, full tests, built-bundle subprocess tests pass | done | verification transcript below |
| 17 | No live-state touch; isolation held | done | all tests/manual runs sandboxed (`RECALL_HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`); see honesty note on own-orphan cleanup below |
| 18 | Work committed clean in reviewable increments + this report | done | commit list above; `git status` clean |

## Verification transcript (final, actually executed)

Commands run from the worktree root, in order (heavy runs under the arena lock):

```
$ npm run typecheck
> tsc --noEmit
(exit 0)

$ npm run build
Built dist/recall.js, dist/stop-hook.js, dist/embed-pending.js, dist/statusline.js
(exit 0)

$ flock -w 7200 -E 217 /tmp/recall-arena.lock -c 'timeout 2400 npm test'
 Test Files  46 passed (46)
      Tests  352 passed | 1 skipped (353)
   Duration  20.75s
(exit 0)          # the 1 skipped test is the RECALL_GPU_ACCEPTANCE-gated manual leg

$ flock -w 7200 -E 217 /tmp/recall-arena.lock -c 'timeout 1800 npx vitest run \
    test/integration/query-coordinator.test.ts \
    test/integration/cli-opaque-reads.test.ts \
    test/integration/agent-cold.test.ts \
    test/integration/retrieval-class-migration.test.ts \
    test/integration/stop-hook.test.ts \
    test/integration/embed-lockfile.test.ts'
 Test Files  6 passed (6)
      Tests  48 passed | 1 skipped (49)
   Duration  12.30s
(exit 0)
```

Both runs above were re-executed in full AFTER the adversarial-review fixes
(`f92beb9`) — the numbers shown are from the final post-fix invocations.

Post-run cleanliness (executed): no `llama-*`/`embed-pending` process attributable to this worktree survived; no `req-*`/`res-*`/`leader.lock` artifacts in any sandbox `run/query-embed/`; my `ARENA_TMP` scratch roots removed; `~/.recall/recall.db` and `~/.claude/settings.json` mtimes predate all my test runs.

One earlier full-suite invocation (same commands) failed `embed-lockfile.test.ts :: serializes 5 concurrent children…` with `serverStarts = 2` while a sibling arena agent was saturating the shared GPU outside my lock window — the two starts were *sequential* (children didn't overlap under load), not concurrent. The reported final runs above are the authoritative ones; see Known gaps.

## How to verify (referee sequence)

From a clean checkout of `agent-fix/fable` (Linux; Node 22):

```bash
git clone <repo> recall-verify && cd recall-verify && git checkout agent-fix/fable
# or: git worktree add ../recall-verify agent-fix/fable && cd ../recall-verify
npm ci                # no lifecycle scripts; better-sqlite3 arrives as a prebuild
npm run typecheck
npm run build         # REQUIRED before tests (stop-hook/statusline suites need dist/)
flock -w 7200 -E 217 /tmp/recall-arena.lock -c 'timeout 2400 npm test'
flock -w 7200 -E 217 /tmp/recall-arena.lock -c 'timeout 1800 npx vitest run \
  test/integration/query-coordinator.test.ts \
  test/integration/cli-opaque-reads.test.ts \
  test/integration/agent-cold.test.ts \
  test/integration/retrieval-class-migration.test.ts \
  test/integration/stop-hook.test.ts \
  test/integration/embed-lockfile.test.ts'
```

Expected: typecheck/build exit 0; full suite **46 files / 352 passed / 1 skipped**, exit 0; bundle suites **6 files / 48 passed / 1 skipped**, exit 0. Notes:

- `embed-lockfile.test.ts` self-skips unless real llama binaries + the nomic model exist at `~/.recall/{bin,models}`; it loads the real model — run on a quiet machine.
- The 1 skipped test is the manual GPU acceptance leg; to run it (real RTX 2060/CUDA, quiet GPU): `RECALL_GPU_ACCEPTANCE=1 npx vitest run test/integration/query-coordinator.test.ts` (see the test header for what it asserts and the `nvidia-smi` observation step). It was NOT executed during this arena run, per §0.2 rule 6.
- No test touches `~/.recall`, `~/.claude/settings.json`, or `~/.codex` (embed-lockfile symlinks the real `bin/`+`models/` read-only; everything else is per-test tmp roots).

## Deviations and judgment calls

1. **Explicit `recall read` grammar adopted** (§5.1 offered it as an option) *in addition to* the narrow implicit dispatch: `read <session-ref> [<message-ref>]` treats references as fully opaque (reaches descriptive agent IDs that the narrow implicit shape intentionally excludes), and `recall search <terms…>` is the documented force-search escape. Implicit reads hard-fail on unresolved references (no resolve-uniquely-else-search fallback — I chose the stricter behavior to keep "failed reads never become searches" unconditional). Help, README, and SKILL.md.template document all three forms.
2. **Pre-existing test changes** (each is a contract update, not a weakening):
   - `test/unit/vector-search.test.ts`: the embed mock re-points from `embedder.embed` to `query-embed-coordinator.coordinatedQueryEmbed` — the new seam `dualPathSearch` calls. All behavioral assertions unchanged.
   - `test/integration/codex-path.test.ts`: two `resolveIngestTarget` tests updated — the old expectations *encoded the §4.4 defect* (child stapled to hook `agent_id`; parent id as fallback). New expectations assert the child transcript is targeted with hook evidence forwarded, plus a NEW regression test for the agent_id-absent mis-pairing. The ingest test now asserts canonicalization to the session-meta UUID + alias registration (it previously asserted rows under the caller-proposed id, which is exactly the duplicate-identity bug).
   - No pre-existing test was deleted, skipped, or had an assertion removed.
3. **`embed-lock.ts` `LOCK_PATH` const → lazy `embedLockPath()`**: the module-level const froze the path at import time, before test sandboxes took effect — in-process baseline tests could write the LIVE `~/.recall/run/embed.lock`, and the migration's drain-quiesce would have read the live lock. All call sites updated.
4. **`codex-jsonl-reader` `CODEX_SESSIONS_DIR` hardcode fixed** to honor `CODEX_HOME` lazily (declared in-scope by §0.2 rule 2); `extractCodexSessionMeta` now also surfaces `payload.source` for the classifier.
5. **Coordinator batching**: the coalesced set is embedded in ONE one-shot invocation (chunked only above 64 texts) rather than ≤5-text chunks — one model load per burst instead of ⌈n/5⌉, still never `llama-server`. A compute deadline (`timeout` + SIGKILL) was added to the one-shot `execFile` path, used only by the coordinator (the backfill path keeps its unbounded behavior).
6. **Interface extensions** (additive): `MessageRecord.retrieval_class?`, `IngestResult.retrievalClass?/canonical sessionId`, `IngestOptions.hook?`, `StatusReport.agentMessageCount`, `MigrationInfo.retrieval?`, `getDb(path, {allowPendingMigration})`. `recall status` text output now reports hot and agent counts separately (spec-required).
7. **Reclassification reconciliation**: when hook evidence marks an already-hot-ingested session as a leaf (SubagentStop after a T1 scan), `insertMessages` flips the session's rows cold and purges their vectors in the same transaction; stored provenance otherwise pins identity/kind (explicit subagent evidence may upgrade a stored root, never the reverse).
8. **Migration scope**: `_stem`/`embed_version` reconciliation happens via a normal reopen after the marker commits (the standard `ensureSchema` path), keeping the migration transaction focused on classification/FTS/vectors/marker.
9. **Test-only env knobs** on the coordinator (`RECALL_QE_COALESCE_MS`, `RECALL_QE_POLL_MS`, `RECALL_QE_RESPONSE_TIMEOUT_MS`, `RECALL_QE_EMBED_TIMEOUT_MS`, `RECALL_QE_LOCK_MAX_AGE_MS`) — production defaults are hard-coded; the subprocess tests widen the coalescing window to make the single-batch assertion deterministic (rationale in the test header).
10. **Own-orphan cleanup during the run** (§0.2 rule 3 honesty note): two of my test invocations timed out under sibling GPU saturation and orphaned 4 llama processes (one-shot children + idle servers) spawned by MY OWN vitest runs, identified by their sandbox paths (`/tmp/recall-test-*` created during my run windows, dirs already deleted; `/tmp/recall-arena-fable-*`) and dead parents. I killed those 4 PIDs only. Sibling processes (paths under `recall-agent-fix-gpt-5.6-sol`, live parents) were identified and explicitly left alone.

## Known gaps

- **Windows**: the coordinator/opaque-read/cold-behavior subprocess suites skip on `win32` (the fake backend uses shebang executables). The coordinator protocol itself is Windows-safe by construction (`wx` create, same-volume rename, `process.kill(pid,0)`, no sockets/POSIX-only calls) and the in-process unit suite exercises it everywhere, but no Windows execution happened in this run.
- **macOS**: not executable on this machine. `.github/workflows/macos-smoke.yml` was reviewed — its assertions (`assert-search.mjs` reads `total_messages`/`semantic_available` from `--raw` JSON; root Stop-hook payload shape) are unaffected by these changes; fresh installs there initialize the new schema directly. Not run locally.
- **Real-GPU acceptance**: implemented as the `RECALL_GPU_ACCEPTANCE=1`-gated test (8 real simultaneous CUDA searches → ≤2 loads/max-1-concurrent/no server/clean dir, with a documented `nvidia-smi` VRAM observation) — deliberately NOT executed during the arena run (§0.2 rule 6).
- **`embed-lockfile.test.ts` (pre-existing) is load-sensitive**: with the shared GPU saturated by a sibling arena agent, the lock-holder's `llama-server` can crash (CUDA pressure), leaving work that a later child picks up — two *sequential* server starts, which its `≤1` assertion counts as a failure even though the at-most-one-*concurrent* invariant held. Passed at baseline and in the final quiet-machine runs; I did not modify the test.
- **Pre-existing vitest forks-worker teardown wart** (baseline: post-summary "Failed to terminate forks worker … install-upgrade.test.ts"): during development it intermittently surfaced on `manifest-optout.test.ts` as an unhandled worker-exit error. Final runs were clean; per the §0.1 dispensation I did not chase it.
- **Unresolved-Codex reporting granularity**: the migration's "unresolved" count identifies Codex-shaped sessions by their synthesized `codex-jsonl-*` message ids (the only ids this pipeline ever stores for Codex text turns). It is a report-only number; unresolved sessions are left hot by design.
- **`grepMessages` hot-filter** is exercised via unit/integration tests only — it has no CLI surface at this commit (spec §4.3 note).
- **Accepted residuals from the adversarial review** (all low severity, degradation-not-corruption): a dead leader whose PID is immediately reused by a live process blocks reaping until the (floored ≥10-min) age backstop — followers degrade to FTS-only at their 3-min response timeout, never to direct embedding; a continuous burst of one embedding identity can starve a different-identity follower into the same FTS-only timeout (only reachable mid-config-change); a crash after the migration's COMMIT but before its normal reopen leaves `_stem`/`embed_version` reconciliation to the next `getDb` (self-healing by design); aborted snapshot attempts from *distinct* runs each leave one timestamped snapshot file (disk residue only).
