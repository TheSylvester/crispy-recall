import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { freemem, platform } from 'node:os';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:os', () => ({ freemem: vi.fn(), platform: vi.fn() }));

const MB = 1024 ** 2;
const vmStat = (pageSize = 16384, free = 1000, inactive = 100000, purgeable = 2000) =>
  `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)\nPages free: ${free}.\nPages inactive: ${inactive}.\nPages purgeable: ${purgeable}.\nPages active: 900000.\n`;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.mocked(platform).mockReturnValue('darwin');
  vi.mocked(freemem).mockReturnValue(87 * MB);
});
afterEach(() => vi.restoreAllMocks());

describe('available memory', () => {
  it.each([4096, 16384])('uses vm_stat page size %i and only free+inactive+purgeable', async (pageSize) => {
    const { parseDarwinAvailableMemory } = await import('../../src/recall/available-memory.js');
    expect(parseDarwinAvailableMemory(vmStat(pageSize))).toBe(103000 * pageSize);
  });

  it('recognizes reclaimable memory above the guard despite little wholly free RAM', async () => {
    vi.mocked(execFileSync).mockReturnValue(vmStat());
    const { availableMemory } = await import('../../src/recall/available-memory.js');
    expect(availableMemory()).toBeGreaterThan(1024 * MB);
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/vm_stat', {
      encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024,
    });
  });

  it('still reports genuine low memory below the guard', async () => {
    vi.mocked(execFileSync).mockReturnValue(vmStat(16384, 100, 200, 300));
    const { availableMemory } = await import('../../src/recall/available-memory.js');
    expect(availableMemory()).toBe(87 * MB);
    expect(availableMemory()).toBeLessThan(1024 * MB);
  });

  it.each(['', 'page size of 16384 bytes\nPages free: 1.', vmStat().replace('2000.', '-1.'), vmStat(1e20)])(
    'falls back to current free memory on malformed vm_stat output %#', async (output) => {
      vi.mocked(execFileSync).mockReturnValue(output);
      const { availableMemory } = await import('../../src/recall/available-memory.js');
      expect(availableMemory()).toBe(87 * MB);
    },
  );

  it('falls back conservatively on command timeout', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    const { availableMemory } = await import('../../src/recall/available-memory.js');
    expect(availableMemory()).toBe(87 * MB);
    expect(availableMemory()).toBe(87 * MB);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cached sample after one second, including falling memory', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.mocked(execFileSync).mockReturnValueOnce(vmStat()).mockReturnValueOnce(vmStat(4096, 1, 1, 1));
    const { availableMemory } = await import('../../src/recall/available-memory.js');
    expect(availableMemory()).toBeGreaterThan(1024 * MB);
    clock.mockReturnValue(1999);
    expect(availableMemory()).toBeGreaterThan(1024 * MB);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(2000);
    expect(availableMemory()).toBe(87 * MB);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('leaves Linux free-memory behavior unchanged without running vm_stat', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    const { availableMemory } = await import('../../src/recall/available-memory.js');
    expect(availableMemory()).toBe(87 * MB);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
