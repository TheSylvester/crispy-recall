# Changelog

## 0.4.0 — 2026-09-11

Satellite mode: one hub keeps the database and the model, and any number of
satellite machines push their transcripts to it and forward their queries there.

### Added

- **Experimental satellite mode.** `recall install --hub <url> --token <t>|-`
  registers a machine as a satellite: it stages no database, no model and no
  native addon.
  Its Stop hook spawns a detached push, and every query is forwarded to the hub
  and printed byte-identically, exit code included. `recall push [--full]`
  pushes pending transcripts on demand. Tested platforms and recovery steps are
  documented.
- **Hub daemon.** `recall hub serve [--bind <addr>] [--port <n>] [--detach]`
  mirrors satellite transcripts under `~/.recall/remote/<host>/` and answers
  their queries. `recall hub token --host <name>` issues a bearer token (one per
  host, stored hashed) and `--revoke <name>` withdraws it with no restart.
  `recall hub status` reports the daemon and per-host state. `recall hub
  install-service` registers a systemd user unit on Linux.
- **Wire handshake.** Every authenticated request carries `X-Recall-Wire`;
  a mismatch is refused with 426, so an old satellite fails loudly instead of
  silently.
- **`--project-key K`** scopes a search by an already-derived repo key
  (`git:`/`origin:`/`path:`) and skips derivation.
- **`recall repair --rekey-codex`** and **`recall repair --rekey-projects
  [--force]`** run the two one-time migrations attended.
- **Message repair.** `recall repair --messages` non-destructively repairs
  sequence ordering and recovers missed turns.
- **Stalled-message diagnostics.** `recall status` and `recall doctor` report
  stalled messages.
- **Local change attribution.** Local Codex patches, including moves, and
  Windows paths are supported for attribution.

### Changed

- **Default scoped search now returns every worktree, clone and subdirectory
  session of the same repo.** Project identity is a repo-derived key —
  `git:<root-commit>`, `origin:<normalized-url>` or `path:<dir>` — stored beside
  the old path. Forks that share a root commit merge into one scope.
- **Codex message ids are full session UUIDs.** The one-time attended migration
  (run by `recall install`, or `recall repair --rekey-codex`) re-ingests and
  re-embeds every Codex session whose rollout is still on disk and parses;
  sessions whose rollout is gone or empty keep their old ids and are reported by
  `recall doctor`.
- **Supported Node.js versions.** `engines.node` is
  `>=20.0.0 <21 || >=22.0.0 <23 || >=24.0.0` to admit Node 20 satellites
  while excluding Node 21 and 23, for whose ABIs `better-sqlite3` publishes no
  prebuild. The hub requires Node 22.16+ or 24+, and `recall install` enforces
  that floor and refuses both roles on Node 21 and 23. Node 20 also has no
  prebuilt binding, so npm compiles `better-sqlite3` from source: a Node 20
  satellite needs python3, make and a C/C++ compiler even though it never loads
  the binding. Node 22 or 24+ installs from a prebuild.
- **Shared blame parsing.** Transcript parsing is reused across blame commits.
- **Consistent migration snapshots.** Upgrades require consistent migration
  snapshots before proceeding.
- **Required CI gates.** A Linux workflow runs the full test suite on Node 22
  and 24, asserts that `npm ci` uses a prebuild rather than a node-gyp compile,
  and exercises the Node 20 satellite floor. The macOS Vitest job is now a
  required push gate instead of a dispatch-only, non-blocking job. The prebuild
  guard checks every documented OS/architecture pair (Linux x64/arm64, macOS
  x64/arm64 and Windows x64) for each hub major in its Node 20–26 table. It
  reports satellite-only source builds separately, fails on any admitted major
  it does not know, and states that later majors are not evaluated until the
  table is extended.
- **Explicit package contents.** A `files` allowlist includes the five bundles
  and the skill template, replacing the broad `dist/` inclusion and prepack
  removal of `dist/better_sqlite3.node`. Packing and publishing preserve the
  working-tree binding, and `scripts/ci/assert-tarball.mjs` asserts the exact
  published file set, with no `.node` or `.wasm` sidecar.

### Fixed

- **User hook preservation.** Install, migration and uninstall preserve foreign
  commands and prompt hooks grouped beside Recall, including user wrapper
  commands.
- **Embedding and transcript failures.** Failed embedding retries are bounded
  and NUL input is sanitized. Unreadable transcripts fail visibly without
  advancing watermarks or purging existing history.
- **Ingest accounting and fork history.** Ingest reports actual inserted rows
  and preserves copied Claude fork messages.
- **Search date filtering.** Search applies dates before both candidate limits,
  and search and lists use consistent UTC date-only bounds.
- **Hook resilience.** Hooks fail open on malformed payloads and retry transient
  database contention.
- **Codex child classification and metadata.** Live ingest and migration share
  child classification and preserve role/nickname metadata. The `session_meta`
  read bound is raised to 256 KB so child rollouts classify correctly instead
  of leaking in as top-level sessions.
- **Chunked transcript decoding.** Retained chunked readers decode safely
  across UTF-8 boundaries.
- **Staged bundle versions.** `recall --version` prints the real version from a
  staged bundle. Hooks, the daemon and the satellite CLI previously reported
  `unknown`.
- **Windows path scoping.** Non-git directories that differ only in path casing
  scope together through the project-key half of the filter. `project_id` is
  still stored with its original casing.

### Known limitations

- On a satellite, `recall --commit` and `recall --blame` see local sessions
  only. They read local git and local transcripts, never the hub index.
- A repo keyed `git:` on one machine and `origin:` on another — a shallow clone,
  for instance — does not unify until both machines agree on the key.
- The hub speaks plain HTTP. There is no TLS in v1; put the port on a private
  network.
- A hub token grants read of the whole hub index, and write only to that host's
  mirror. There is no per-host read scoping.
- A session id that already exists on the hub from a different transcript path
  is refused at ingest, never merged — the bytes are mirrored and `recall
  doctor` / `recall hub status` report the refusal count per host
  (`agent-<7hex>` subagent basenames are the known case).
