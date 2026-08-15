import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFailureDedupeKey, type FailureRecordInput } from '../services/syncAudit';

function makeInput(overrides: Partial<FailureRecordInput> = {}): FailureRecordInput {
  return {
    syncId: 'sync-1',
    userId: 'user-1',
    direction: 'source_to_target',
    action: 'update',
    errorMessage: 'something failed',
    ...overrides,
  };
}

test('event-scoped failures keep a stable dedupe key regardless of error', () => {
  const first = buildFailureDedupeKey(
    makeInput({ sourceEventId: 'evt-1', errorMessage: 'error A' })
  );
  const second = buildFailureDedupeKey(
    makeInput({ sourceEventId: 'evt-1', errorMessage: 'error B' })
  );
  assert.equal(first, second);
});

test('failures without event ids are discriminated by error code', () => {
  const gap = buildFailureDedupeKey(makeInput({ errorCode: 'watermark_gap' }));
  const other = buildFailureDedupeKey(makeInput({ errorCode: 'quota_exceeded' }));
  assert.notEqual(gap, other);
});

test('failures without event ids or error code are discriminated by message', () => {
  const first = buildFailureDedupeKey(makeInput({ errorMessage: 'error A' }));
  const second = buildFailureDedupeKey(makeInput({ errorMessage: 'error B' }));
  assert.notEqual(first, second);

  const repeat = buildFailureDedupeKey(makeInput({ errorMessage: 'error A' }));
  assert.equal(first, repeat);
});

test('different actions with null event ids never collide', () => {
  const update = buildFailureDedupeKey(makeInput({ action: 'update' }));
  const del = buildFailureDedupeKey(makeInput({ action: 'delete' }));
  assert.notEqual(update, del);
});
