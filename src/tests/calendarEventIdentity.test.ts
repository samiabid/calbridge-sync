import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNativeOccurrenceIndex,
  getCalendarEventOccurrenceIdentity,
  isDuplicateCalendarOccurrence,
} from '../services/calendarEventIdentity';

test('non-recurring events deduplicate by iCalUID', () => {
  const source = { id: 'source', iCalUID: 'invite@example.com' };
  const destination = { id: 'destination', iCalUID: 'invite@example.com' };
  const index = buildNativeOccurrenceIndex([destination]);

  assert.equal(isDuplicateCalendarOccurrence(source, index), true);
  assert.equal(getCalendarEventOccurrenceIdentity(source)?.key, 'ical:invite@example.com');
});

test('recurring events deduplicate only against the same normalized occurrence', () => {
  const source = {
    iCalUID: 'series@example.com',
    recurringEventId: 'series-source',
    originalStartTime: { dateTime: '2026-08-17T19:00:00+03:00' },
  };
  const sameInstant = {
    iCalUID: 'series@example.com',
    recurringEventId: 'series-destination',
    originalStartTime: { dateTime: '2026-08-17T16:00:00Z' },
  };
  const differentOccurrence = {
    iCalUID: 'series@example.com',
    recurringEventId: 'series-destination',
    originalStartTime: { dateTime: '2026-08-24T16:00:00Z' },
  };

  assert.equal(isDuplicateCalendarOccurrence(source, buildNativeOccurrenceIndex([sameInstant])), true);
  assert.equal(
    isDuplicateCalendarOccurrence(source, buildNativeOccurrenceIndex([differentOccurrence])),
    false
  );
});

test('sync-created clones and events without iCalUID are not native duplicate candidates', () => {
  const source = { iCalUID: 'invite@example.com' };
  const clone = {
    iCalUID: 'invite@example.com',
    extendedProperties: { private: { syncId: 'sync-1' } },
  };

  assert.equal(buildNativeOccurrenceIndex([clone]).size, 0);
  assert.equal(getCalendarEventOccurrenceIdentity({ id: 'no-uid' }), null);
  assert.equal(isDuplicateCalendarOccurrence(source, buildNativeOccurrenceIndex([clone])), false);
});
