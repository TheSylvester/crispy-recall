/**
 * `recall hub install-service` (spec §2.1) — systemd user unit, Linux only.
 *
 * Split in three so it is testable without touching the developer's login
 * session: `renderHubUnit()` (pure text), `hubUnitPath()` (honours
 * `XDG_CONFIG_HOME`) and `runInstallService({apply})`, which writes the unit
 * and ONLY THEN, when `apply !== false`, runs `systemctl --user`.
 *
 * @module hub/service
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { binDir } from '../paths.js';

export function hubUnitPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', 'recall-hub.service');
}

export function renderHubUnit(): string {
  return [
    '[Unit]',
    'Description=recall hub daemon (satellite transcript mirror + proxied queries)',
    // network-online, not network.target: the daemon binds a Tailscale
    // address that does not exist yet at network.target. StartLimitIntervalSec=0
    // removes systemd's 5-failures-in-10s limit, which left the unit `failed`
    // for good after a reboot race with tailscale0.
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart="${process.execPath}" "${join(binDir(), 'recall.js')}" hub serve`,
    'Restart=on-failure',
    'RestartSec=10',
    'TimeoutStopSec=15',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export interface InstallServiceResult {
  /** Written unit path (null when the platform prints instructions only). */
  unitPath: string | null;
  applied: boolean;
  messages: string[];
  code: number;
}

export function runInstallService(opts: { apply?: boolean; platform?: NodeJS.Platform } = {}): InstallServiceResult {
  const platform = opts.platform ?? process.platform;
  const messages: string[] = [];
  if (platform !== 'linux') {
    messages.push(
      'recall hub install-service registers a systemd user unit and is Linux-only in v1.',
      platform === 'darwin'
        ? 'macOS: create a launchd agent that runs: ' + `"${process.execPath}" "${join(binDir(), 'recall.js')}" hub serve`
        : 'Windows: register a scheduled task (at logon) that runs: ' + `"${process.execPath}" "${join(binDir(), 'recall.js')}" hub serve`,
      'Or run `recall hub serve --detach` from your shell.',
    );
    return { unitPath: null, applied: false, messages, code: 0 };
  }

  const unitPath = hubUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, renderHubUnit());
  messages.push(`wrote ${unitPath}`);
  if (opts.apply === false) return { unitPath, applied: false, messages, code: 0 };

  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('systemctl', args, { encoding: 'utf8', windowsHide: true });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  };
  const reload = run(['--user', 'daemon-reload']);
  if (reload.status !== 0) {
    messages.push(`systemctl --user daemon-reload failed: ${reload.out || 'no systemd user session'}`);
    return { unitPath, applied: false, messages, code: 1 };
  }
  const enable = run(['--user', 'enable', '--now', 'recall-hub']);
  if (enable.status !== 0) {
    messages.push(`systemctl --user enable --now recall-hub failed: ${enable.out}`);
    return { unitPath, applied: false, messages, code: 1 };
  }
  messages.push('recall-hub.service enabled and started');

  const user = process.env['USER'] ?? '';
  const linger = spawnSync('loginctl', ['show-user', user, '-p', 'Linger'], { encoding: 'utf8', windowsHide: true });
  if (linger.status !== 0 || !/^Linger=yes\s*$/m.test(linger.stdout ?? '')) {
    messages.push(`hint: run \`loginctl enable-linger ${user || '$USER'}\` so the hub survives logout.`);
  }
  return { unitPath, applied: true, messages, code: 0 };
}
