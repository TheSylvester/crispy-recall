# Changelog

## 0.4.0-sat.6 (experimental, unreleased)

- Preserve foreign commands and prompt hooks grouped beside recall during install, migration, and uninstall; retain user wrapper commands.
- Bound failed embedding retries, sanitize NUL input, and report stalled messages in status/doctor. Unreadable transcripts now fail visibly without advancing watermarks or purging existing history.
- Report actual inserted rows; preserve copied Claude fork messages; repair sequence ordering and missed turns with non-destructive `recall repair --messages`.
- Apply search dates before both candidate limits; use consistent UTC date-only bounds in search and lists.
- Attribute local Codex patches (including moves) and Windows paths; reuse transcript parsing across blame commits.
- Fail open on malformed hook payloads, retry transient hook database contention, and require consistent migration snapshots before upgrades proceed.
- Share Codex child classification between live ingest and migration; preserve role/nickname metadata; decode retained chunked readers safely across UTF-8 boundaries.
- Mark multi-machine support experimental and document tested platforms and recovery steps. This package is not published as a stable release.
- Narrow `engines.node` to `>=20.0.0 <21 || >=22.0.0 <23 || >=24.0.0`. Node 21 and Node 23 are excluded: `better-sqlite3` publishes no prebuild for ABI 120 or 131, so npm would fall into a source compile there. `recall install` refuses both roles on those majors.
- Document the Node 20 satellite toolchain requirement. Node 20 (ABI 115) also has no prebuilt binding, so npm compiles `better-sqlite3` from source even though a satellite never loads it: python3, make and a C/C++ compiler must be present. Node 22 or 24+ installs from a prebuild.
- Add a Linux CI workflow that runs the full test suite on Node 22 and 24, asserts `npm ci` uses a prebuild rather than a node-gyp compile, and exercises the Node 20 satellite floor. The macOS vitest job became a required gate on push instead of a dispatch-only, never-blocking one. The prebuild guard checks every documented OS/architecture pair (Linux x64/arm64, macOS x64/arm64, Windows x64) for each hub major in its known table (Node 20–26), reports satellite-only source builds separately, fails on any admitted major it does not know, and states that majors beyond the table are not evaluated until the table is extended.
- Package through an explicit `files` allowlist (the five bundles and the skill template) instead of `dist/` plus a prepack `rm` of `dist/better_sqlite3.node`. Packing and publishing no longer delete the working-tree binding at any point, and `scripts/ci/assert-tarball.mjs` asserts the published tarball's exact file set (no `.node` or `.wasm` sidecar).


## 0.4.0 (unreleased)

Satellite mode: one hub keeps the database and the model, and any number of
satellite machines push their transcripts to it and forward their queries there.

### Added

- **Satellite mode.** `recall install --hub <url> --token <t>|-` registers a
  machine as a satellite: it stages no database, no model and no native addon.
  Its Stop hook spawns a detached push, and every query is forwarded to the hub
  and printed byte-identically, exit code included. `recall push [--full]`
  pushes pending transcripts on demand.
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
- **Codex `session_meta` read bound raised to 256 KB**, so child rollouts
  classify correctly again instead of leaking in as top-level sessions.
- **`engines.node` widened to `>=20.0.0 <21 || >=22.0.0 <23 || >=24.0.0`.** The
  HUB still needs Node 22.16+ or 24+, and `recall install` enforces that floor;
  the wider range is what lets a satellite run on Node 20. Node 21 and Node 23
  are excluded from both roles — `better-sqlite3` publishes no prebuild for
  their ABIs. On Node 20 there is likewise no prebuild, so npm compiles
  `better-sqlite3` from source: a Node 20 satellite needs python3, make and a
  C/C++ compiler installed even though it never loads the binding.
- **`recall --version` prints the real version from a staged bundle.** Hooks,
  the daemon and the satellite CLI reported `unknown` before.
- **On Windows, non-git directories that differ only in path casing now scope
  together**, through the project-key half of the filter; `project_id` itself is
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
