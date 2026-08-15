import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAuditRetentionDays } from '../services/auditRetention';

test('audit retention defaults and clamps unsafe values', () => {
  assert.equal(normalizeAuditRetentionDays(undefined), 180);
  assert.equal(normalizeAuditRetentionDays('invalid'), 180);
  assert.equal(normalizeAuditRetentionDays('7'), 30);
  assert.equal(normalizeAuditRetentionDays('365'), 365);
  assert.equal(normalizeAuditRetentionDays('99999'), 3650);
});
