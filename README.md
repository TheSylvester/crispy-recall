# crispy-recall

Searchable memory for your Claude Code and Codex sessions. Local, fast, no daemon.

**Status:** in development.

A standalone spin-off of the recall feature from [Crispy](https://github.com/TheSylvester/crispy). See the parent project for the broader multi-agent orchestration GUI.

## What's new in 0.2.0

- **Native SQLite engine with real WAL.** The database now runs on
  better-sqlite3 with write-ahead logging instead of the previous WebAssembly
  binding — which never actually engaged WAL and could silently corrupt the
  index when multiple processes wrote at once. That failure mode is eliminated
  at the root. `recall doctor` gains a SQLite-binding health section.
  **Node.js ≥ 22.16 is now required.**
- **Git provenance: `--commit` and `--blame`.** `recall --commit <hash>` lists
  the session(s) that produced a commit; `recall --blame <path>[:line[-line]]`
  traces a file or line range back to the conversations responsible. Matching
  is structural (your sessions' actual edits vs the commit's diff), not
  timestamp-based. These flags were documented in the skill but missing from
  the shipped CLI; they now work as documented.
- **Better semantic retrieval (embedding v3).** Stored messages and queries now
  carry the task prefixes the embedding model was trained on, and short turns
  (one-line answers, approvals, decisions) are embedded together with their
  preceding context so they're finally findable by meaning. Measurably improves
  retrieval on the LoCoMo benchmark (recall@5 54.9 → 58.4).
- **Semantic search stays available during migrations.** Upgrading re-embeds
  your history in the background; until it finishes, search transparently
  blends old- and new-format vectors and tags output with
  `(migrating: N% re-embedded)` instead of going dark.
- **Relevance-first ranking.** The hidden age penalty is off by default —
  older sessions now rank purely by relevance (previously the right old result
  could rank 2× worse just for being old). Pass `--recent` to prefer newer
  sessions explicitly.
- **Faster indexing on large databases.** A new index removes a full-table
  scan from every embedding batch and end-of-turn catch-up (~0.3 s → ~0.05 s
  at ~287K messages). Created automatically on first run.
- **Safe in-place upgrade for existing installs.** `recall install` migrates
  an existing database in place: rollback snapshot → WAL conversion →
  integrity check with auto-repair → background re-embed. See
  [Upgrading from 0.1.x](#upgrading-from-01x).
- **New scripting flags.** `--raw-messages` (full ranked per-message JSON) and
  `--no-idf` (keep common words in keyword search), both off by default.

## Install

Install the command globally, then run the one-time setup:

```bash
npm install -g crispy-recall
recall install
```

`recall install` is the resident setup step. It scaffolds `~/.recall/` (the
llama embedding binary, the model, and the SQLite DB), wires a Stop hook into
Claude Code so your transcripts are indexed automatically as sessions end, and
installs the `recall` skill. If Codex is detected it also gets the `recall`
skill (so the agent can search), but not an automatic per-turn hook (yet) —
index Codex history with `recall backfill --vendor codex`. After that, recall
runs passively — you only invoke `recall` directly for `status`, `doctor`,
`repair`, or `uninstall`.

Run it in the environment where you actually use Claude Code: **WSL and
Windows-native are separate installs.** If you use both, run the install in each
— the installer only configures the environment it is invoked in.

> **Don't install via `npx`.** recall must stay resident. `npx` runs from an
> ephemeral cache and leaves no `recall` command on your PATH, so follow-up
> commands (`recall status` / `doctor` / `repair` / `uninstall`) and the
> installed skill's command contract have nothing to call. Use the global
> install above.

Prerequisites: Node ≥ 22.16 and Claude Code installed. If Codex is detected
(`~/.codex/` exists), recall installs the `recall` skill into Codex (so the
agent can search) and you can index your Codex history with
`recall backfill --vendor codex`. Real-time per-turn Codex indexing is **not
yet** supported.

### Upgrading from 0.1.x

```bash
npm install -g crispy-recall
recall install   # run this FIRST, before any other recall command
```

Exit any running Claude/Codex sessions first, then make `recall install` the
first recall command you run after the npm upgrade — it performs a one-time,
in-place migration of your existing database (rollback snapshot → WAL
conversion → integrity check → background re-embed). If a live session is
still holding the database the installer aborts cleanly and asks you to
re-run; re-running is always safe and picks up where it left off.

What to expect:

- **Your indexed history is preserved — even without the original
  transcripts.** Claude Code deletes session `.jsonl` files after 30 days by
  default; the migration never reads them. It works on the database in place,
  and the re-embed sources text from the database itself.
- A rollback snapshot is written to `~/.recall/recall.db.pre-upgrade-<stamp>`
  (needs free disk roughly equal to your DB size; delete it once you're
  satisfied).
- A background re-embed upgrades your vectors to the new format — roughly an
  hour per 20K messages on CPU, minutes on GPU. Search works the entire time
  (output shows `migrating: N% re-embedded`); watch progress with
  `recall status`. It resumes automatically after reboots.
- The migration is one-way: **don't downgrade** to ≤ 0.1.6 afterwards — the
  old engine fails closed on the converted database.
- **Avoid `recall repair --full` unless you accept losing older history** — it
  rebuilds the index from the transcripts still on disk, which for most
  machines means only the last 30 days. Your database is the store of record;
  the pre-upgrade snapshot is the rollback path if anything looks wrong.

## What it does

- A **Stop hook** ingests every turn into a local SQLite DB the moment a session ends — no daemon, no background polling.
- The CLI **searches** your history two ways at once: FTS5 full-text and semantic vectors (Nomic Embed Text v1.5, run locally via llama.cpp).
- A **`recall` skill** is dropped into Claude Code so the agent discovers and invokes it on its own — you rarely type `recall` yourself.
- Works in **any project**. Claude Code sessions are indexed automatically; Codex transcripts are searchable too via `recall backfill --vendor codex`.

## How an agent uses it

Two steps. First, search for the relevant session:

```bash
recall "the thing you're trying to remember"
```

That returns a table of matching sessions. Then read one, centered on the match:

```bash
recall <session-id> <message-id>
```

Search and list default to the **current directory's project** — from inside one
repo you only see that repo's sessions. Add `--all` to search across every
indexed project (use it for cross-repo questions, or when a scoped search comes
back thin), or `--project <path>` to target a specific repo regardless of where
you are:

```bash
recall --all "the thing you're trying to remember"
```

The skill's frontmatter teaches Claude *when* to reach for this (before
non-trivial tasks, architectural decisions, or work with obvious prior
history), so in practice the agent calls it for you. (Inside the installed skill
the command is written out as `node ~/.recall/bin/recall.js` so it works even
when `recall` isn't on the agent's `PATH` — `$RECALL_BIN` in the skill source is
a placeholder the installer substitutes, not an environment variable you set.)

## Commands

| Command | What it does |
|---|---|
| `recall "<query>" [--all] [--project <path>]` | Search past sessions (FTS5 + semantic). Defaults to the current project; `--all` searches every indexed project, `--project` targets one. |
| `recall <session-id> [<message-id>]` | Read a session, optionally centered on a matched message. |
| `recall install` | One-time setup: scaffold `~/.recall/`, wire the Stop hook, install the skill. |
| `recall uninstall` | Reverse the install (skill, hook, CLAUDE.md block). `--purge` also removes `~/.recall/`. |
| `recall status` | DB size, message count, last ingest, embedding gap, active backfill PID, GPU/CPU backend. |
| `recall doctor` | Read-only health check (the install pre-flight suite). `--integrity` runs DB + FTS5 checks. |
| `recall repair --fts \| --vectors \| --full` | Rebuild the FTS index, re-embed vectors, or full reingest from JSONL. |
| `recall backfill [--auto-embed] [--vendor <v>] [--detach]` | Index historical transcripts. |

Add `--json` to `install`/`uninstall`/`status`/`doctor` for machine-readable
output. `recall install` also takes `--offline` (use a pre-staged binary +
model instead of downloading) and `--no-backfill` / `--auto-backfill` to control
the initial history index. Run `recall --help` for the full flag set.

### Commit attribution (`--commit` / `--blame`)

Find the session(s) that produced a commit, or the session(s) responsible for
the current state of a file or line. Matching is structural — session
Edit/Write/MultiEdit tool calls are compared against the commit's diff via
tri-gram intersection, not clock proximity. `--blame` is HEAD-relative: it runs
`git blame` to find the commits behind the current file (or line range) and
attributes each; sessions overwritten by a later commit won't appear. Results
list top-level sessions and subagent leaves chronologically (oldest first).

```bash
recall --commit 25dd0f8                          # sessions that produced a commit
recall --blame src/paths.ts:82-84                # sessions behind a line range
recall --blame src/foo.ts:42 src/bar.ts:10-20 --limit 20   # union of specs
```

## Where things live

- `~/.recall/` — the DB, model, binary, logs, and `config.json` (the resolved GPU/CPU embedder mode).
- `~/.claude/skills/recall/SKILL.md` — the auto-discovered skill.
- A hook entry in `~/.claude/settings.json`.

`recall uninstall` reverses all three. `recall uninstall --purge` also removes `~/.recall/`.

## Privacy

Everything is local. No telemetry. The only data transfer is the one-time
binary + model download at install (from llama.cpp's GitHub releases and
HuggingFace); `recall install` and `recall doctor` also send lightweight
reachability probes to those two hosts. Nothing else leaves your machine. The DB
is plain SQLite — open it with any SQLite browser if you want to poke around.

## Troubleshooting

Run `recall doctor` — it reports platform, harness, runtime, disk, network, and
the resolved embedding backend, with remediation hints for anything off.

## Attribution

Lifted and adapted from the recall subsystem of
[Crispy](https://github.com/TheSylvester/crispy), the Claude Code / Codex GUI.

## License

MIT — see [LICENSE](./LICENSE).
