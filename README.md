# crispy-recall

Local session transcript memory for Claude Code and Codex — search past sessions with FTS5 + semantic vectors.

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
Claude Code (and Codex, if detected) so your transcripts are indexed
automatically as sessions end, and installs the `recall` skill. After that,
recall runs passively — you only invoke `recall` directly for `status`,
`doctor`, `repair`, or `uninstall`.

Run it in the environment where you actually use Claude Code: **WSL and
Windows-native are separate installs.** If you use both, run the install in each
— the installer only configures the environment it is invoked in.

> **Don't install via `npx`.** recall must stay resident. `npx` runs from an
> ephemeral cache and leaves no `recall` command on your PATH, so follow-up
> commands (`recall status` / `doctor` / `repair` / `uninstall`) and the
> installed skill's command contract have nothing to call. Use the global
> install above.

## License

MIT — see [LICENSE](./LICENSE).
