import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMappingOriginalStart,
  getRecurrenceIdentity,
  isOriginalStartInWindow,
  mappingBelongsToSeries,
  shouldExpandChangedEvent,
} from '../services/recurrenceLogic';

test('recurrence identity uses parent id and immutable original occurrence start', () => {
  assert.deepEqual(
    getRecurrenceIdentity({
      recurringEventId: 'series-1',
      originalStartTime: { dateTime: '2026-08-17T18:00:00+03:00' },
      start: { dateTime: '2026-08-18T18:00:00+03:00' },
    }),
    {
      recurringEventId: 'series-1',
      originalStart: '2026-08-17T18:00:00+03:00',
    }
  );
});

test('only an active recurring master is expanded', () => {
  assert.equal(shouldExpandChangedEvent({ id: 'series', recurrence: ['RRULE:FREQ=WEEKLY'] }), true);
  assert.equal(
    shouldExpandChangedEvent({
      id: 'instance',
      recurringEventId: 'series',
      recurrence: ['RRULE:FREQ=WEEKLY'],
    }),
    false
  );
  assert.equal(
    shouldExpandChangedEvent({ id: 'series', status: 'cancelled', recurrence: ['RRULE:FREQ=WEEKLY'] }),
    false
  );
});

test('series membership prefers persisted metadata and safely supports legacy Google ids', () => {
  assert.equal(
    mappingBelongsToSeries(
      { sourceEventId: 'unrelated', sourceRecurringEventId: 'series-1' },
      'series-1'
    ),
    true
  );
  assert.equal(
    mappingBelongsToSeries({ sourceEventId: 'series-1_20260817T150000Z' }, 'series-1'),
    true
  );
  assert.equal(
    mappingBelongsToSeries(
      { sourceEventId: 'series-1_20260817T150000Z', sourceRecurringEventId: 'series-2' },
      'series-1'
    ),
    false
  );
});

test('legacy instance ids provide a bounded reconciliation start time', () => {
  const originalStart = getMappingOriginalStart({
    sourceEventId: 'series-1_20260817T150000Z',
  });
  assert.equal(originalStart, '2026-08-17T15:00:00Z');
  assert.equal(
    isOriginalStartInWindow(
      originalStart,
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z')
    ),
    true
  );
  assert.equal(
    isOriginalStartInWindow(null, new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z')),
    false
  );
});
