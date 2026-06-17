import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SYNC_FUTURE_DAYS,
  getSyncFutureWindowEnd,
  normalizeSyncFutureDays,
} from '../services/syncWindow';

test('sync future window defaults to one year and clamps unsafe values', () => {
  assert.equal(normalizeSyncFutureDays(undefined), DEFAULT_SYNC_FUTURE_DAYS);
  assert.equal(normalizeSyncFutureDays('45'), 45);
  assert.equal(normalizeSyncFutureDays(0), 1);
  assert.equal(normalizeSyncFutureDays(-10), 1);
  assert.equal(normalizeSyncFutureDays(9999), 730);
});

test('sync future window end is computed in UTC days', () => {
  const now = new Date('2026-03-15T12:00:00.000Z');
  assert.equal(getSyncFutureWindowEnd(now, '30').toISOString(), '2026-04-14T12:00:00.000Z');
});
