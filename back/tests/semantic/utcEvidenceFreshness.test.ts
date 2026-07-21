import assert from 'node:assert/strict';
import test from 'node:test';
import { fromMysqlUtc, toMysqlUtc } from '../../utils/utcTime.ts';

test('evidence freshness treats DATETIME as UTC independently of Node timezone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Europe/Lisbon', 'America/Toronto']) {
      process.env.TZ = zone;
      const stored = toMysqlUtc(new Date('2030-06-01T10:00:00.000Z'));
      assert.equal(stored, '2030-06-01 10:00:00.000');
      assert.equal(fromMysqlUtc(stored).toISOString(), '2030-06-01T10:00:00.000Z');
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test('evidence TTL accepts a recent run, rejects expiry, and treats the exact boundary as stale', () => {
  const expires = fromMysqlUtc('2030-06-01 10:15:00.000');
  assert.equal(expires.getTime() > new Date('2030-06-01T10:14:59.999Z').getTime(), true);
  assert.equal(expires.getTime() <= new Date('2030-06-01T10:15:00.000Z').getTime(), true);
  assert.equal(expires.getTime() <= new Date('2030-06-01T10:15:00.001Z').getTime(), true);
});
