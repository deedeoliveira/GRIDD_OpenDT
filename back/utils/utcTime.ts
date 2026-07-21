/**
 * MySQL DATETIME has no timezone. In this application every new DATETIME is
 * serialized as UTC and every value read from MySQL is parsed as UTC. Never
 * let the Node process timezone reinterpret an evidence or reservation time.
 */
export function toMysqlUtc(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error('Invalid UTC date.');
  return value.toISOString().replace('T', ' ').replace('Z', '');
}

export function fromMysqlUtc(value: unknown): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'string') throw new Error('Invalid MySQL UTC datetime.');
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid MySQL UTC datetime.');
  return date;
}

export function utcNow(): Date { return new Date(); }
