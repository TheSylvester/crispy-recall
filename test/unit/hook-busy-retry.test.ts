import { expect, it, vi } from 'vitest';
import { retryBusyIngest } from '../../src/hooks/stop-hook.js';

it('recovers first-open throws and soft insert lock failures', async () => {
  const operation = vi.fn()
    .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
    .mockResolvedValueOnce({ error: 'database is locked' })
    .mockResolvedValueOnce({ chunksCreated: 2 });
  expect(await retryBusyIngest(operation)).toEqual({ chunksCreated: 2 });
  expect(operation).toHaveBeenCalledTimes(3);
});

it('bounds persistent contention and preserves the failure for hook logging', async () => {
  const operation = vi.fn().mockResolvedValue({ error: 'database is locked' });
  expect(await retryBusyIngest(operation)).toEqual({ error: 'database is locked' });
  expect(operation).toHaveBeenCalledTimes(3);
});

it('does not retry migration, permission or malformed-input failures', async () => {
  const operation = vi.fn().mockRejectedValue(new Error('migration pending'));
  await expect(retryBusyIngest(operation)).rejects.toThrow('migration pending');
  expect(operation).toHaveBeenCalledTimes(1);
});
