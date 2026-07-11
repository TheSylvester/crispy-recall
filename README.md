# crispy-recall

**Save every session. Recall any conversation. Continue where you left off.**

Each conversation with your agent lands in a transcript on disk, waiting for Claude Code's [startup cleanup (30 days by default)](https://code.claude.com/docs/en/settings) to delete it. recall indexes user and assistant turns as they end — verbatim, on your machine — so your agent can search, read, and continue the conversation even after its transcript is gone.

**Local session memory for Claude Code, with Codex support.** Hybrid text and semantic search. Verbatim conversation history.

No daemon, no cron, no cloud. A Stop hook and a SQLite file.

## Quick start

Requires Claude Code and either Node.js 22 LTS (`>=22.16`) or Node.js 24+. Install recall in the same environment where you run Claude Code:

```bash
npm install -g crispy-recall
recall install
```

recall downloads a local embedding runtime and model, sets up a `Stop` hook in Claude Code, installs the recall Agent Skill, and starts indexing the session history still on disk. If Codex is detected, recall sets up the same integration there.

## How to use recall

### Ask your agent

**Your agent starts every session from zero — until you say the word.**

The word is `recall`. Say it in a prompt and your agent goes and gets exactly what it needs: a top-level conversation by UUID, messages by keyword or meaning, or the Claude Code session that wrote the code behind a commit.

Use it naturally:

| Say this | What your agent can recover |
|---|---|
| `Recall where we left off.` | The decisions, unfinished work, and next step from prior sessions. |
| `Recall — we solved this before.` | The earlier fix, even when your new wording doesn't match the transcript. |
| `Recall <session-uuid> and continue.` | A UUID-backed conversation in a fresh session, centered on the relevant part. |
| `Recall why this line exists.` | The session behind a commit or line, including alternatives discussed at the time. |

The installed skill teaches Claude Code and Codex when and how to search, so your agent can invoke recall without you typing a special command.

### Use the CLI directly

Search first:

```bash
recall "why did we choose this retry policy?"
```

Every result includes a session id and the matched message id. For UUID-based Claude Code results, read the promising result centered on the match:

```bash
recall <session-uuid> <message-uuid>
```

Search defaults to the current project's sessions. Expand only when needed:

```bash
recall --all "the decision may have happened in another repo"
recall --project ~/dev/other-repo "the decision"
recall "the latest release issue" --recent
```

recall surfaces evidence, not truth. Good agents check recovered context against git HEAD, the current files, and fresh tests before acting on it.

## Why recall?

> My agent burned 20 minutes re-diagnosing a failure. The one-line fix sat in 24 prior sessions.

So I built crispy-recall — local, verbatim search across my agent's past sessions.

Your agent doesn't need to guess what will matter later. It needs a way to search what actually happened once the question becomes clear.

## What makes recall different

### The conversation, not a summary

recall keeps the user and assistant conversation word-for-word. It doesn't replace the record with a model's guess about which details might matter later.

That distinction matters when you need the exact constraint, command, promise, rejected idea, or one-line fix that a summary would reasonably discard.

**`/compact` summarizes. recall quotes.**

Auto-memory saves what you knew to keep. recall finds what you didn't know you'd need. They complement each other: one keeps selected facts close; the other searches the verbatim conversation record on demand.

Tool calls, tool output, and hidden thinking are intentionally excluded from the searchable conversation. Tool output is re-runnable; the conversation that interpreted it isn't.

### Continue without replaying the session

Read a past conversation by UUID-shaped session id:

```text
Recall fe6cc221-2e63-4928-8417-65ec1587d062 and continue the release.
```

recall reads the indexed conversation instead of replaying an entire raw transcript. Reads can open on the matched message, paginate forward, and combine context from several past sessions. That means your agent can recover the few facts that matter without pouring every old tool result back into its context window.

`/resume` dies with the transcript; recall doesn't. recall reads the relevant indexed turns instead of replaying one whole session, and it can combine facts from other sessions.

### From a line of code back to the conversation

`git blame` can tell you who changed a line. `recall --blame` can take you back to the conversation that produced it.

```bash
recall --commit 25dd0f8
recall --blame src/paths.ts:82-84
recall --blame src/foo.ts:42 src/bar.ts:10-20 --limit 20
```

Matching is structural: recall compares edits recorded in sessions with commit diffs instead of guessing from timestamps. A commit message summarizes intent; the conversation holds the reasoning, tradeoffs, and rejected alternatives.

Commit and blame attribution currently scans Claude Code transcripts. Codex sessions remain searchable by text and meaning, but aren't yet attributed to commits.

**`git blame` tells you who. `recall --blame` tells you why.**

### Search for the idea, not just the words

You rarely remember the exact phrase an agent used three weeks ago. recall searches two ways at once:

- SQLite FTS5 finds exact words and phrases quickly.
- Local semantic embeddings find the same idea under different wording.
- Rank fusion combines both result sets.
- Project scoping keeps everyday searches focused; `--all` crosses repositories when the project itself is the thing you forgot.

```bash
recall "the mac installer hang we fixed"
recall --all "why we stopped using the wasm sqlite binding"
recall --project ~/dev/my-app "booking slot id decision"
```

### Grep is still the right tool sometimes

If you know the exact string and the transcript still exists, use grep. recall earns its keep when:

- the transcript has already been deleted;
- your wording doesn't match the original conversation;
- the answer spans several sessions or repositories;
- you need to move from a commit or line of code back to the session that produced it; or
- you want your agent to retrieve the context itself instead of manually hunting through JSONL files.

Claude Code deletes transcripts after 30 days by default. The recall index doesn't. You can and often should raise `cleanupPeriodDays`; longer retention keeps more source files, while recall makes the record searchable after those files are gone.

**Grep can't search a deleted file.**

## How it works

Under the hood, recall is deliberately boring:

1. Stop and SubagentStop hooks index conversation text as turns finish.
2. A local llama.cpp embedding model vectorizes it on your machine.
3. SQLite stores the text, FTS5 index, vectors, and session metadata in `~/.recall/`.
4. A small skill teaches your agent to search first when prior work is likely to matter.
5. Search results enter the context only when the agent asks for them.

There's no resident daemon, and recall makes no LLM calls of its own. Indexing and search don't consume model tokens; retrieved text costs context tokens only when your agent reads it, like any other local file.

Install-time backfill indexes the Claude Code and Codex sessions still present on disk, so recall is useful on day one rather than only after day one.

## Install

### Requirements

- Node.js 22 LTS (`>=22.16`) or Node.js 24+
- Claude Code (required); Codex session indexing and search are also configured when Codex is detected
- Linux x64/arm64, macOS x64/arm64, or Windows x64
- macOS 14+ on Apple Silicon or macOS 13.7+ on Intel
- 500 MB free recommended for installation; upgrading also needs free space for retained rollback snapshots — roughly the database size when upgrading from 0.2.x, and roughly twice that from 0.1.x (which keeps two snapshots)

Node 23 is unsupported because no prebuilt SQLite binding is available for it.

```bash
npm install -g crispy-recall
recall install
```

> **Don't use `npx`.** recall installs persistent hooks, a skill, a model, and a command that must remain available after setup.

Run the installer in the environment where you use your agent. WSL and Windows-native are separate environments, so install once in each if you use both.

The installer:

- creates `~/.recall/`;
- downloads the llama.cpp binary and local embedding model;
- installs Claude Code and Codex lifecycle hooks when each harness is detected;
- installs the recall skill and a short AGENTS.md/CLAUDE.md nudge; and
- backfills the session history that is still on disk.

Use `recall doctor` if setup reports a problem. Use `recall install --offline` with pre-staged assets for an offline install.

### Upgrading

Close active Claude Code and Codex sessions, then make `recall install` the first recall command you run after upgrading — it applies any pending one-time database migrations attended, before your agent reopens the database:

```bash
npm install -g crispy-recall
recall install
```

- **From 0.1.x**, the installer migrates the wasm database to native SQLite/WAL (writing a `~/.recall/recall.db.pre-upgrade-<stamp>` snapshot) and checks integrity, then runs the retrieval-class migration below.
- **From 0.2.x**, the installer runs the retrieval-class migration: it reclassifies any subagent (agent-leaf) messages as durable-but-excluded-from-default-search, rebuilds the FTS index, and re-embeds affected rows in the background.

Before it changes anything, the retrieval-class migration writes a `~/.recall/recall.db.pre-retrieval-<stamp>` snapshot; a 0.1.x upgrade therefore keeps two retained snapshots (pre-upgrade and pre-retrieval). Keep free disk roughly equal to the current database size — twice that when upgrading from 0.1.x — and delete the snapshots only after you're satisfied.

If a live session or a running backfill holds the database, the installer aborts cleanly so you can exit it and rerun `recall install`. Search remains available during migration; use `recall status` to watch progress, and the background re-embed resumes after interruption or reboot.

Migration works from `recall.db`, not the source transcripts, so indexed history is preserved even when the original JSONL has already been cleaned up. Your database is the store of record; if old transcripts are gone, `recall repair --full` cannot recreate them. Don't downgrade to `<=0.1.6` after converting the database.

## Command reference

| Command | Purpose |
|---|---|
| `recall "<query>"` | Hybrid text + semantic search in the current project. |
| `recall "<query>" --all` | Search every indexed project. |
| `recall <session-id> [<message-id>]` | Read a session, optionally centered on a match. IDs are opaque — full stored IDs or literal prefixes (UUIDs, `agent-<hex>` leaves, `codex-jsonl-*` messages) all resolve. |
| `recall read <session-ref> [<message-ref>]` | Explicit read for any stored ID shape; a failed read exits nonzero and never falls back to search. |
| `recall search <terms…>` | Force a search when a term would otherwise look like a session/message ID. |
| `recall --commit <hash>` | Find Claude Code sessions that produced a commit. |
| `recall --blame <path>[:line[-line]]` | Trace current code back to its producing Claude Code conversations. |
| `recall install` | Install or upgrade the hooks, skills, local assets, and history index. |
| `recall backfill [--auto-embed] [--vendor <v>] [--detach]` | Index session transcripts currently on disk, optionally for one vendor or as a detached job. |
| `recall status` | Show database size, message counts, embedding gap/migration progress, and active backfill state. |
| `recall doctor [--integrity]` | Run read-only install and database checks. |
| `recall repair --fts \| --vectors \| --full` | Rebuild FTS5, clear vectors for re-embedding, or fully reingest on-disk transcripts. |
| `recall statusline [--suggest]` | Print the session-id chip or integration guidance. |
| `recall uninstall [--purge]` | Remove the integration; `--purge` also deletes recall's data. |

Run `recall --help` for the full search and read flag set. Add `--json` to `install`, `uninstall`, `status`, or `doctor` for machine-readable output. Installer options include `--offline`, `--no-backfill`, `--auto-backfill`, `--statusline`, and `--no-statusline`.

### Optional statusline

```bash
recall install --statusline
```

It is off by default: accepting the installer defaults, using `--yes` or a non-interactive install, or upgrading an install that has never enabled it will not opt you in. Once enabled, it stays enabled across upgrades. If Claude Code has no statusline, recall installs a muted line with the current folder and git branch, model, context use, and a `🔗 <session_id>` chip. If you already have a statusline, recall leaves it unchanged and prints paste-ready integration guidance; `recall statusline --suggest` repeats it later.

The installed statusline never opens the database. Its only I/O is one guarded `git status` call with a 400 ms timeout; failure simply drops the git segment, and any segment whose input is missing is omitted. For composition with your own statusline, `recall statusline` prints only the bare, uncolored session-id chip. Uninstall removes the line only if recall still owns it, and doctor reports statusline problems as warnings.

> **Warning:** `recall repair --full` is destructive: it replaces the index contents from the transcripts still on disk. If older source transcripts have already been cleaned up, their indexed history cannot be rebuilt. Prefer `--fts` or `--vectors` unless a full reingest is truly necessary.

## Privacy and data

- Your index lives in `~/.recall/recall.db`.
- Search and indexing stay on your machine.
- While a query is being embedded, its text is written to a transient file under `~/.recall/run/query-embed/` (mode 0600) and deleted as soon as the embedding completes.
- There is no telemetry.
- The database is plain SQLite and inspectable with ordinary SQLite tools.
- Network access is limited to downloading the embedding runtime and model when missing, plus host reachability probes during install and doctor checks.
- `recall uninstall --purge` removes the local store completely.

The installed integration is inspectable too: Claude's skill and hook live under `~/.claude/skills/recall/` and `~/.claude/settings.json`. When Codex is detected, recall also uses `~/.codex/skills/recall/` and `~/.codex/hooks.json`.

The index deliberately outlives source-transcript cleanup. recall doesn't encrypt `recall.db`; treat `~/.recall/` with the same care as your original Claude Code and Codex histories.

## Limitations

- It isn't automatic fact injection into every prompt. Retrieval is pull-based.
- It isn't a replacement for documentation, tests, or git.
- It doesn't claim recalled context is still correct.
- It doesn't preserve tool output or hidden thinking in the searchable conversation.
- It doesn't yet offer per-session deletion; forgetting is database-level today.
- Subagent transcripts (Claude Task leaves, Codex child rollouts) are stored durable and readable by explicit ID, but are excluded from default search, lists, and semantic vectors — the parent thread's narration is the canonical memory. There is no search mode that includes them yet.

## Project status

crispy-recall is in active development and was spun out of the recall subsystem in [Crispy](https://github.com/TheSylvester/crispy). See [GitHub Releases](https://github.com/TheSylvester/crispy-recall/releases) for version history.

Issues and contributions are welcome at [github.com/TheSylvester/crispy-recall](https://github.com/TheSylvester/crispy-recall).

## License

MIT — see [LICENSE](./LICENSE).

---

**Memory, lazily evaluated.**
