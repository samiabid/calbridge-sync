import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSyncEventsWindow,
  computeSyncEventStatus,
  getRequestedDirections,
  normalizeEventsPageSize,
  normalizeForceSyncDirection,
  normalizeSyncEventDirection,
  paginateSyncEventRows,
} from '../services/syncEventsDashboardLogic';

test('event dashboard direction defaults follow sync mode', () => {
  assert.equal(normalizeSyncEventDirection(undefined, false), 'source_to_target');
  assert.equal(normalizeSyncEventDirection(undefined, true), 'all');
  assert.equal(normalizeSyncEventDirection('target_to_source', true), 'target_to_source');
  assert.equal(normalizeSyncEventDirection('target_to_source', false), 'source_to_target');
  assert.deepEqual(getRequestedDirections('all', true), ['source_to_target', 'target_to_source']);
  assert.deepEqual(getRequestedDirections('source_to_target', true), ['source_to_target']);
  assert.equal(normalizeForceSyncDirection('source_to_target', true), 'source_to_target');
  assert.throws(() => normalizeForceSyncDirection('all', true), /invalid sync direction/i);
});

test('event dashboard window and paging are bounded', () => {
  const window = buildSyncEventsWindow('14', '45', new Date('2026-03-15T12:00:00.000Z'));
  assert.equal(window.daysBack, 14);
  assert.equal(window.daysForward, 45);
  assert.equal(window.timeMin, '2026-03-01T12:00:00.000Z');
  assert.equal(window.timeMax, '2026-04-29T12:00:00.000Z');
  assert.equal(normalizeEventsPageSize(999), 100);

  const paginated = paginateSyncEventRows([
    { id: '1' },
    { id: '2' },
    { id: '3' },
  ], '2', '2');
  assert.equal(paginated.page, 2);
  assert.equal(paginated.pageSize, 2);
  assert.equal(paginated.total, 3);
  assert.equal(paginated.totalPages, 2);
  assert.deepEqual(paginated.items, [{ id: '3' }]);
});

test('event dashboard status precedence is failed over synced over skipped over not_synced', () => {
  assert.equal(
    computeSyncEventStatus({
      failure: {
        id: 'failure-1',
        errorMessage: 'Create failed',
        lastFailedAt: '2026-03-15T09:00:00.000Z',
      },
      mapping: {
        targetEventId: 'target-1',
        lastSyncedAt: '2026-03-15T08:00:00.000Z',
      },
      skipReason: {
        code: 'excluded_keyword',
        message: 'Filtered by keyword',
      },
    }).status,
    'failed'
  );

  assert.equal(
    computeSyncEventStatus({
      mapping: {
        targetEventId: 'target-1',
        lastSyncedAt: '2026-03-15T08:00:00.000Z',
      },
      skipReason: {
        code: 'excluded_keyword',
        message: 'Filtered by keyword',
      },
    }).status,
    'synced'
  );

  const skipped = computeSyncEventStatus({
    skipReason: {
      code: 'no_readable_details',
      message: 'Source event has no readable details.',
    },
  });
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.statusReason, /no readable details/i);

  assert.equal(computeSyncEventStatus({}).status, 'not_synced');
});
