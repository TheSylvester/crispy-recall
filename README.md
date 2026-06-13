# crispy-recall

Searchable memory for your Claude Code and Codex sessions. Local, fast, no daemon.

**Status:** in development.

A standalone spin-off of the recall feature from [Crispy](https://github.com/TheSylvester/crispy). See the parent project for the broader multi-agent orchestration GUI.

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

Prerequisites: Node ≥ 20 and Claude Code installed. If Codex is detected
(`~/.codex/` exists), recall installs the `recall` skill into Codex (so the
agent can search) and you can index your Codex history with
`recall backfill --vendor codex`. Real-time per-turn Codex indexing is **not
yet** supported.

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
