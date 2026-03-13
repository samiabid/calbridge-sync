import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepairWindow,
  classifyOrphanCandidate,
  getOriginalEventIdFromTargetEvent,
  getOrphanReasonMessage,
  getTargetEventSyncId,
  normalizeRepairDays,
} from '../services/syncRepairLogic';

test('normalizeRepairDays clamps invalid and oversized values', () => {
  assert.equal(normalizeRepairDays(undefined, 30), 30);
  assert.equal(normalizeRepairDays('14', 30), 14);
  assert.equal(normalizeRepairDays(-10, 30), 0);
  assert.equal(normalizeRepairDays(9999, 30), 730);
});

test('buildRepairWindow uses bounded backward and forward ranges', () => {
  const now = new Date('2026-03-14T12:00:00.000Z');
  const window = buildRepairWindow('7', '21', now);

  assert.equal(window.daysBack, 7);
  assert.equal(window.daysForward, 21);
  assert.equal(window.timeMin, '2026-03-07T12:00:00.000Z');
  assert.equal(window.timeMax, '2026-04-04T12:00:00.000Z');
});

test('target sync metadata is extracted safely', () => {
  const event = {
    extendedProperties: {
      private: {
        syncId: 'sync-123',
        originalEventId: 'source-456',
      },
    },
  };

  assert.equal(getTargetEventSyncId(event), 'sync-123');
  assert.equal(getOriginalEventIdFromTargetEvent(event), 'source-456');
  assert.equal(getTargetEventSyncId({}), null);
  assert.equal(getOriginalEventIdFromTargetEvent({}), null);
});

test('orphan classification distinguishes mapping and source problems', () => {
  assert.equal(
    classifyOrphanCandidate({
      originalEventId: null,
      hasMapping: false,
    }),
    'missing_original_event_id'
  );

  assert.equal(
    classifyOrphanCandidate({
      originalEventId: 'source-1',
      hasMapping: false,
    }),
    'missing_mapping'
  );

  assert.equal(
    classifyOrphanCandidate({
      originalEventId: 'source-1',
      hasMapping: true,
      mappingSourceEventId: 'source-2',
    }),
    'mapping_mismatch'
  );

  assert.equal(
    classifyOrphanCandidate({
      originalEventId: 'source-1',
      hasMapping: true,
      mappingSourceEventId: 'source-1',
      sourceExists: false,
    }),
    'missing_source'
  );

  assert.equal(
    classifyOrphanCandidate({
      originalEventId: 'source-1',
      hasMapping: true,
      mappingSourceEventId: 'source-1',
      sourceExists: true,
    }),
    null
  );
});

test('orphan reason messages are stable and user-facing', () => {
  assert.match(getOrphanReasonMessage('missing_mapping'), /mapping is missing/i);
  assert.match(getOrphanReasonMessage('missing_source'), /no longer exists/i);
});
