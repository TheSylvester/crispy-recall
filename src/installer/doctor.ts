/**
 * doctor — read-only health report (the same pre-flight suite install runs)
 * plus the persisted embedder backend, and an optional DB integrity check.
 *
 * `recall doctor`            → PreflightReport (table or --json)
 * `recall doctor --integrity` → PRAGMA integrity_check + FTS5 self-check
 *
 * @module installer/doctor
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { runPreflight, claudeSettingsPath, type PreflightReport } from './preflight.js';
import { readConfig } from './config.js';
import { integrityCheck } from './repair.js';
import { detectStatusline } from './statusline-suggest.js';
import { isBindingLoadError, CODEX_REKEY_MIGRATION_KEY, LEGACY_CODEX_ID_SQL } from '../db.js';
import { binDir, dbPath, remoteRoot, statuslineScript } from '../paths.js';
import { EMBED_VERSION } from '../recall/embed-config.js';
import { META_RESIDUE_SQL } from '../recall/purge-meta.js';
import { mirrorHostSummary, mirrorHosts } from '../hub/mirror.js';
import { hubDaemonAlive, readHostRecords } from '../hub/runtime.js';
import { classifyBind } from '../hub/server.js';

export interface DoctorOptions {
  json?: boolean;
  integrity?: boolean;
  offline?: boolean;
}

/**
 * Native-binding + WAL drift health. Read-only: it opens the DB `readonly` and
 * only READS `journal_mode` — it never runs `journal_mode = WAL`, so it can
 * never implicitly convert the live DB (that is an attended, separate event).
 */
export interface BindingHealth {
  installed: boolean;        // recall bundles staged at all?
  markerPresent: boolean;    // .binding-info.json (absent = pre-migration wasm-era install)
  abiOk: boolean | null;     // staged ABI matches current Node (null if no marker)
  pinnedNodeOk: boolean | null; // pinned node path still exists (null if no marker)
  bindingLoads: boolean;     // better_sqlite3.node loads under this Node
  journalMode: string | null;   // current mode on the live DB (null if DB absent/unreadable)
  /** Fraction of vectors at EMBED_VERSION (null if DB absent / no vectors table).
   *  `< 1` surfaces an in-progress embed_version re-embed — read on the SAME
   *  readonly connection as journalMode, so doctor never flips the live DB. */
  embedCoverage: number | null;
  /** Residual meta-boilerplate rows still indexed (null if DB absent /
   *  pre-migration schema). Non-zero → warn to run `recall backfill
   *  --purge-meta`; whitelisted rows (task notifications) are not counted. */
  metaResidue: number | null;
  /** True when a `messages` table exists but the project_key backfill marker
   *  is not 'complete' (null when there is no DB / no messages table). WARN
   *  only — it never enters `problems` and never flips the exit code. */
  projectKeyBackfillPending: boolean | null;
  /** Codex message-id re-key pending (null if DB absent / pre-migration schema).
   *  True → normal commands fail closed until `recall install` or
   *  `recall repair --rekey-codex` runs it. */
  codexRekeyPending: boolean | null;
  /** Sessions still carrying legacy 8-hex Codex ids AFTER the migration: the
   *  transcript was missing, unreadable, emptied, or the session reclassified
   *  to another canonical id. Informational, never a problem. */
  legacyCodexSessions: number | null;
  /** Hot messages with no vector at all (null if DB absent / pre-migration
   *  schema). embedCoverage cannot serve: its denominator counts only rows
   *  that HAVE a vector, so a vector purge leaves coverage at 1.0. */
  embedGap: number | null;
  problems: string[];
}

/** Returns a process exit code (0 = healthy, 1 = problems found). */
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  if (opts.integrity) return printIntegrity(opts.json ?? false);

  const report = await runPreflight({ ...(opts.offline ? { offline: true } : {}) });
  const embedder = readConfig()?.embedder ?? null;
  const binding = checkBindingHealth();
  const statusline = checkStatuslineHealth();
  const hub = checkHubHealth();

  if (opts.json) {
    console.log(JSON.stringify({ ...report, embedder, binding, statusline, hub }, null, 2));
  } else {
    printTable(report, embedder?.mode ?? 'cpu', embedder?.fallbackReason);
    printBinding(binding);
    printStatusline(statusline);
    printHub(hub);
  }
  const bindingFailed = binding.installed && binding.problems.length > 0;
  // Statusline coverage is WARN-only — it never affects the exit code.
  return report.failures.length > 0 || bindingFailed ? 1 : 0;
}

/** Opt-in statusLine coverage. All findings are WARN — never exit-1. Gated on
 *  a persisted `statusline.installed`; reports nothing when the feature is off. */
export interface StatuslineHealth { installed: boolean; warnings: string[] }

export function checkStatuslineHealth(): StatuslineHealth {
  const s = readConfig()?.statusline;
  if (!s?.installed) return { installed: false, warnings: [] };
  const warnings: string[] = [];

  // (a) still wired / not clobbered — is the live command still recall's?
  const detected = detectStatusline(claudeSettingsPath());
  if (detected.kind !== 'recall') {
    warnings.push(
      'recall statusline was configured but settings.json now points elsewhere (you edited it) — ' +
        'recall will leave it alone; the next `recall install` clears this record, ' +
        'or re-run `recall install --statusline` to re-enable',
    );
    return { installed: true, warnings };
  }

  // Wired and ours — check the two things the command depends on AS WRITTEN in
  // settings.json (not staging-area proxies like .binding-info.json, which every
  // install rewrites to the CURRENT node and so can vouch for a stale pin).
  // (b) the wired script exists.
  const script = detected.scriptPath ?? statuslineScript();
  if (!existsSync(script)) {
    warnings.push(`statusline command points at a missing script (${script}) — run \`recall install\``);
  }

  // (c) the Node pinned INSIDE the wired command still exists (the command is
  // `"<node>" "<script>"`; only an absolute first token is checkable).
  const pinnedNode = /^\s*"([^"]+)"/.exec(detected.command ?? '')?.[1];
  if (pinnedNode && isAbsolute(pinnedNode) && !existsSync(pinnedNode)) {
    warnings.push(`statusline pinned Node path missing (${pinnedNode}) — run \`recall install\``);
  }

  return { installed: true, warnings };
}

function printStatusline(h: StatuslineHealth): void {
  if (!h.installed) return;
  console.log('\nStatusline (opt-in)');
  console.log('-------------------');
  if (h.warnings.length === 0) {
    console.log('Session id shown in the Claude Code status bar: OK');
  } else {
    for (const w of h.warnings) console.log(`  ⚠ ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Hub (spec §2.5) — WARN only, never exit-1
// ---------------------------------------------------------------------------

export interface HubHostHealth {
  host: string;
  files: number;
  lastPush: string | null;
  sidecarless: number;
}

export interface HubHealth {
  /** Configured bind (null = no hub record in config.json). */
  bind: string | null;
  bindIsAny: boolean;
  daemonAlive: boolean;
  daemonPid: number | null;
  hosts: HubHostHealth[];
  /** `agent` sessions whose provenance names more than one transcript path. */
  collisions: Array<{ sessionId: string; paths: string[] }>;
  warnings: string[];
}

/**
 * Hub-side findings: a mirror with no live daemon, an all-interfaces bind,
 * per-host mirror facts, and the cross-host session-id collision check. All
 * WARN — none of it enters `problems` or moves the exit code.
 */
export function checkHubHealth(): HubHealth {
  const warnings: string[] = [];
  const hubConfig = readConfig()?.hub ?? null;
  const bind = hubConfig ? (hubConfig.bind ?? null) : null;
  // An absent `bind` key on an existing hub record is ANY (§2.2).
  const bindIsAny = !!hubConfig && classifyBind(hubConfig.bind) === 'any';
  if (bindIsAny) {
    warnings.push(`hub bind is ${bind === null || bind === '' ? 'absent/empty' : bind} (every interface) — set config.json hub.bind to 127.0.0.1 or your Tailscale address`);
  }

  const { alive, record } = hubDaemonAlive();
  const records = readHostRecords();
  const hosts: HubHostHealth[] = mirrorHosts().map((host) => {
    const s = mirrorHostSummary(host);
    return { host, files: s.files, lastPush: records[host]?.lastPushAt ?? null, sidecarless: s.sidecarless };
  });
  if (hosts.length > 0 && !alive) {
    warnings.push(`${remoteRoot()} holds ${hosts.length} satellite host(s) but no hub daemon is running — run \`recall hub serve\` (or \`recall hub install-service\`)`);
  }
  for (const h of hosts) {
    if (h.sidecarless > 0) warnings.push(`host ${h.host}: ${h.sidecarless} mirror file(s) without a sidecar (project key will be NULL for them)`);
  }

  const collisions: Array<{ sessionId: string; paths: string[] }> = [];
  const dbFile = dbPath();
  if (existsSync(dbFile)) {
    try {
      const localBinding = stagedBindingPath();
      const raw = existsSync(localBinding)
        ? new Database(dbFile, { readonly: true, fileMustExist: true, nativeBinding: localBinding })
        : new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        const rows = raw.prepare(
          `SELECT session_id, COUNT(DISTINCT transcript_path) c FROM session_provenance
           WHERE kind='agent' GROUP BY session_id HAVING c > 1`,
        ).all() as Array<{ session_id: string; c: number }>;
        for (const r of rows) {
          const paths = (raw.prepare(
            `SELECT DISTINCT transcript_path p FROM session_provenance WHERE session_id = ?`,
          ).all(r.session_id) as Array<{ p: string | null }>).map((x) => x.p ?? '(null)');
          collisions.push({ sessionId: r.session_id, paths });
        }
      } finally {
        raw.close();
      }
    } catch { /* pre-migration schema or unreadable DB — the binding section reports that */ }
  }
  for (const c of collisions) {
    warnings.push(`session-id collision: ${c.sessionId} → ${c.paths.join(' | ')}`);
  }

  return { bind, bindIsAny, daemonAlive: alive, daemonPid: record?.pid ?? null, hosts, collisions, warnings };
}

function printHub(h: HubHealth): void {
  if (h.bind === null && h.hosts.length === 0 && !h.daemonAlive && h.collisions.length === 0) return;
  console.log('\nHub (satellite mode)');
  console.log('--------------------');
  console.log(`Bind:           ${h.bind === null ? 'not configured' : (h.bind === '' ? "'' (ANY)" : h.bind)}${h.bindIsAny ? '  [ANY]' : ''}`);
  console.log(`Daemon:         ${h.daemonAlive ? `alive (pid ${h.daemonPid})` : 'not running'}`);
  for (const host of h.hosts) {
    console.log(`Host ${host.host}: files ${host.files}, last push ${host.lastPush ?? 'never'}, sidecar-less ${host.sidecarless}, daemon alive ${h.daemonAlive ? 'yes' : 'no'}`);
  }
  for (const w of h.warnings) console.log(`  ⚠ ${w}`);
}

/** Path to the staged addon (beside the bundles). */
function stagedBindingPath(): string {
  return join(binDir(), 'better_sqlite3.node');
}

export function checkBindingHealth(): BindingHealth {
  const problems: string[] = [];
  const installed = existsSync(join(binDir(), 'recall.js'));
  if (!installed) {
    return {
      installed: false, markerPresent: false, abiOk: null, pinnedNodeOk: null,
      bindingLoads: false, journalMode: null, embedCoverage: null, metaResidue: null,
      projectKeyBackfillPending: null,
      codexRekeyPending: null, legacyCodexSessions: null, embedGap: null,
      problems: ['recall is not installed — run `recall install`'],
    };
  }

  // --- ABI marker ---
  const markerPath = join(binDir(), '.binding-info.json');
  const markerPresent = existsSync(markerPath);
  let abiOk: boolean | null = null;
  let pinnedNodeOk: boolean | null = null;
  if (!markerPresent) {
    problems.push('no .binding-info.json marker — pre-migration (wasm-era) install; run `recall install`');
  } else {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
        nodeModuleVersion?: string; nodePath?: string;
      };
      abiOk = String(marker.nodeModuleVersion) === String(process.versions.modules);
      if (!abiOk) {
        problems.push(
          `binding ABI mismatch (staged for NODE_MODULE_VERSION ${marker.nodeModuleVersion}, ` +
            `current ${process.versions.modules}) — run \`recall install\``,
        );
      }
      pinnedNodeOk = !!marker.nodePath && existsSync(marker.nodePath);
      if (!pinnedNodeOk) {
        problems.push(`pinned Node path missing (${marker.nodePath ?? 'unset'}) — run \`recall install\``);
      }
    } catch {
      problems.push('unreadable .binding-info.json marker — run `recall install`');
    }
  }

  // --- Binding load + WAL drift (read-only) ---
  let bindingLoads = false;
  let journalMode: string | null = null;
  let embedCoverage: number | null = null;
  let metaResidue: number | null = null;
  let projectKeyBackfillPending: boolean | null = null;
  let codexRekeyPending: boolean | null = null;
  let legacyCodexSessions: number | null = null;
  let embedGap: number | null = null;
  const localBinding = stagedBindingPath();
  const dbFile = dbPath();
  if (existsSync(dbFile)) {
    try {
      const raw = existsSync(localBinding)
        ? new Database(dbFile, { readonly: true, fileMustExist: true, nativeBinding: localBinding })
        : new Database(dbFile, { readonly: true, fileMustExist: true });
      bindingLoads = true;
      journalMode = String(raw.pragma('journal_mode', { simple: true }));
      // Embed-version coverage on the SAME readonly connection (never flips
      // WAL). HOT-only join: agent-leaf rows are excluded from embedding, so
      // they must not distort the coverage denominator doctor reports.
      try {
        const row = raw
          .prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN mv.embed_version = ? THEN 1 ELSE 0 END), 0) AS current
             FROM message_vectors mv
             JOIN messages m ON m.message_id = mv.message_id
             WHERE m.retrieval_class = 'hot'`,
          )
          .get(EMBED_VERSION) as { total: number; current: number } | undefined;
        const total = row ? Number(row.total) : 0;
        const current = row ? Number(row.current ?? 0) : 0;
        embedCoverage = total === 0 ? null : current / total;
      } catch {
        embedCoverage = null; // no vectors table / pre-migration schema
      }
      // Residual meta boilerplate on the SAME readonly connection. Prefix-
      // anchored LIKEs only — a full table scan is seconds on ~350K rows.
      try {
        const row = raw.prepare(META_RESIDUE_SQL).get() as { n: number } | undefined;
        metaResidue = row ? Number(row.n) : null;
      } catch {
        metaResidue = null; // pre-migration schema without messages table
      }
      // Pending retrieval-class migration (read-only detection): a messages
      // table without the schema_meta 'complete' marker means normal commands
      // fail closed until `recall install` finishes the migration.
      try {
        const hasMessages = raw
          .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='messages'`)
          .get();
        if (hasMessages) {
          let complete = false;
          try {
            const marker = raw
              .prepare(`SELECT value FROM schema_meta WHERE key='retrieval_class_migration'`)
              .get() as { value?: string } | undefined;
            complete = marker?.value === 'complete';
          } catch {
            complete = false; // no schema_meta table at all
          }
          if (!complete) {
            problems.push('retrieval-class schema migration pending — run `recall install` to finish it');
          }
          // Project-key backfill (spec §4.3): WARN only, never a problem —
          // unkeyed rows still match through the project_id half of the
          // filter, so search is correct, just not repo-unified.
          try {
            const pk = raw
              .prepare(`SELECT value FROM schema_meta WHERE key='project_key_backfill'`)
              .get() as { value?: string } | undefined;
            projectKeyBackfillPending = pk?.value !== 'complete';
          } catch {
            projectKeyBackfillPending = true; // no schema_meta table at all
          }
          // Codex message-id re-key (same readonly handle, same shape).
          let codexComplete = false;
          try {
            const marker = raw
              .prepare(`SELECT value FROM schema_meta WHERE key='${CODEX_REKEY_MIGRATION_KEY}'`)
              .get() as { value?: string } | undefined;
            codexComplete = marker?.value === 'complete';
          } catch {
            codexComplete = false; // no schema_meta table at all
          }
          codexRekeyPending = !codexComplete;
          if (!codexComplete) {
            problems.push('codex message-id migration pending — run `recall install` (or `recall repair --rekey-codex`) to finish it');
          } else {
            const row = raw
              .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM messages WHERE ${LEGACY_CODEX_ID_SQL}`)
              .get() as { n: number } | undefined;
            legacyCodexSessions = row ? Number(row.n) : null;
          }
        }
      } catch { /* detection is best-effort */ }
      // Embed drain gap on the SAME readonly connection: hot rows with NO
      // vector at all. This is what a re-key's vector purge opens up, and what
      // `recall backfill --auto-embed` closes.
      try {
        const row = raw
          .prepare(
            `SELECT COUNT(*) AS n FROM messages m
             WHERE m.retrieval_class = 'hot' AND m.message_text != ''
               AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id = m.message_id)`,
          )
          .get() as { n: number } | undefined;
        embedGap = row ? Number(row.n) : null;
      } catch {
        embedGap = null; // pre-migration schema
      }
      raw.close();
      if (journalMode !== 'wal') {
        problems.push(
          `live DB journal_mode is '${journalMode}', not 'wal' — a native build on a non-WAL DB is drift ` +
            `(the WAL conversion is a separate attended step; do not restage over a delete-mode DB blindly)`,
        );
      }
    } catch (e) {
      if (isBindingLoadError(e)) {
        problems.push('better_sqlite3.node failed to load (ABI/dlopen) — run `recall install`');
      } else {
        problems.push(`could not read live DB journal_mode: ${(e as Error).message}`);
      }
    }
  } else {
    // No DB yet — prove the binding at least loads against an in-memory DB.
    try {
      const raw = existsSync(localBinding)
        ? new Database(':memory:', { nativeBinding: localBinding })
        : new Database(':memory:');
      bindingLoads = true;
      raw.close();
    } catch (e) {
      problems.push(
        isBindingLoadError(e)
          ? 'better_sqlite3.node failed to load (ABI/dlopen) — run `recall install`'
          : `binding self-test failed: ${(e as Error).message}`,
      );
    }
  }

  return {
    installed, markerPresent, abiOk, pinnedNodeOk, bindingLoads, journalMode,
    embedCoverage, metaResidue, projectKeyBackfillPending, codexRekeyPending, legacyCodexSessions, embedGap, problems,
  };
}

export function printBinding(b: BindingHealth): void {
  const ok = (v: boolean) => (v ? 'OK' : 'FAIL');
  console.log('\nSQLite binding (better-sqlite3, native WAL)');
  console.log('------------------------------------------');
  if (!b.installed) {
    console.log('  not installed — run `recall install`');
    return;
  }
  console.log(`Binding loads:  ${ok(b.bindingLoads)}`);
  console.log(`ABI marker:     ${b.markerPresent ? (b.abiOk ? 'OK' : 'MISMATCH') : 'absent (wasm-era)'}`);
  console.log(`Pinned Node:    ${b.pinnedNodeOk === null ? 'n/a' : ok(b.pinnedNodeOk)}`);
  console.log(`journal_mode:   ${b.journalMode ?? 'no DB yet'}${b.journalMode && b.journalMode !== 'wal' ? '  [DRIFT]' : ''}`);
  if (b.embedCoverage !== null && b.embedCoverage < 1) {
    console.log(`Embed migration: re-embedding to v${EMBED_VERSION} (${Math.round(b.embedCoverage * 100)}%) — semantic search stays available`);
  }
  if (b.metaResidue !== null) {
    console.log(
      b.metaResidue === 0
        ? 'Meta residue:   none'
        : `Meta residue:   ⚠ ${b.metaResidue} boilerplate rows indexed — run: recall backfill --purge-meta`,
    );
  }
  if (b.projectKeyBackfillPending) {
    console.log('Project keys: backfill pending — run: recall repair --rekey-projects');
  }
  if (b.legacyCodexSessions !== null && b.legacyCodexSessions > 0) {
    console.log(
      `Legacy codex ids: ${b.legacyCodexSessions} sessions not re-keyed ` +
      '(transcript missing, unreadable, emptied, or reclassified)',
    );
  }
  if (b.embedGap !== null && b.embedGap > 0) {
    console.log(`Embed gap:      ${b.embedGap} messages awaiting vectors — run: recall backfill --auto-embed`);
  }
  if (b.problems.length) {
    console.log('  Issues:');
    for (const p of b.problems) console.log(`   ✖ ${p}`);
  }
}

function printIntegrity(json: boolean): number {
  const r = integrityCheck();
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`Main DB integrity_check: ${r.mainOk ? 'ok' : r.mainDetail}`);
    console.log(`FTS5 self-check:         ${r.ftsOk ? 'ok' : `FAILED (${r.ftsError})`}`);
    if (!r.mainOk) console.log('  → serious corruption — run `recall repair --full`.');
    else if (!r.ftsOk) console.log('  → run `recall repair --fts`.');
  }
  return r.mainOk && r.ftsOk ? 0 : 1;
}

function printTable(report: PreflightReport, embedderMode: 'gpu' | 'cpu', fallbackReason?: string): void {
  const ok = (b: boolean) => (b ? 'OK' : 'FAIL');
  console.log('recall doctor');
  console.log('=============');
  console.log(`Platform:   ${report.platform.os}/${report.platform.arch}${report.platform.isWsl ? ' (WSL)' : ''}  [${ok(report.platform.ok)}]`);
  console.log(`Claude:     ${report.claude.status}  hooks=${report.claude.existingHooks}  install=${report.claude.existingInstall}  [${ok(report.claude.ok)}]`);
  console.log(`Codex:      ${report.codex ? `${report.codex.status} [${ok(report.codex.ok)}]` : 'not detected'}`);
  console.log(`Node:       ${report.runtime.node}`);
  console.log(`Disk:       ${report.runtime.disk}`);
  console.log(`Network:    ${report.runtime.network}`);
  console.log(`Arch:       ${report.runtime.binaryArch}`);
  const g = report.runtime.gpu;
  console.log(`GPU:        detected=${g.detected} vendor=${g.vendor}${g.vram ? ` vram=${g.vram}` : ''} cuda=${g.cudaAvailable} planned=${g.plannedMode}`);
  console.log(`Embedder:   ${embedderMode.toUpperCase()} (persisted)${fallbackReason ? ` — fell back: ${fallbackReason}` : ''}`);

  if (report.warnings.length) {
    console.log('\nWarnings:');
    for (const w of report.warnings) console.log(`  • ${w.check}: ${w.message}`);
  }
  if (report.failures.length) {
    console.log('\nFailures:');
    for (const f of report.failures) console.log(`  ✖ ${f.check}: ${f.message}${f.remediation ? `\n     → ${f.remediation}` : ''}`);
  }
  if (!report.warnings.length && !report.failures.length) console.log('\nAll checks passed.');
}
