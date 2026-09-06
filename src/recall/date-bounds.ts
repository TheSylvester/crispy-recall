/** ISO date-only bounds are UTC days; timestamps retain their explicit offset. */
export function parseDateBounds(since?: string, until?: string): { createdFrom?: number; createdTo?: number } {
  const parse = (value: string | undefined, flag: 'since' | 'until'): number | undefined => {
    if (!value) return undefined;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = Date.parse(dateOnly ? value + (flag === 'until' ? 'T23:59:59.999Z' : 'T00:00:00.000Z') : value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid --${flag} date: "${value}" (expected ISO-8601)`);
    return parsed;
  };
  return { createdFrom: parse(since, 'since'), createdTo: parse(until, 'until') };
}
