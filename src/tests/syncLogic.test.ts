import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCancellationState,
  eventHasAnyCopyableDetails,
  isDetailPlaceholderSummary,
  needsReadableSourceDetails,
  normalizeRsvpStatuses,
  shouldSkipActiveEventDueToCancellation,
  shouldSkipEvent,
} from '../services/syncLogic';

test('placeholder summaries are recognized correctly', () => {
  assert.equal(isDetailPlaceholderSummary('Busy'), true);
  assert.equal(isDetailPlaceholderSummary('(no title)'), true);
  assert.equal(isDetailPlaceholderSummary('Untitled'), true);
  assert.equal(isDetailPlaceholderSummary('Actual Meeting'), false);
});

test('readable source details are required only when copyable fields are enabled', () => {
  assert.equal(
    needsReadableSourceDetails({
      syncEventTitles: false,
      syncEventDescription: false,
      syncEventLocation: false,
      syncMeetingLinks: false,
    }),
    false
  );

  assert.equal(
    needsReadableSourceDetails({
      syncEventTitles: true,
      syncEventDescription: false,
      syncEventLocation: false,
      syncMeetingLinks: false,
    }),
    true
  );
});

test('copyable details ignore placeholder titles but accept description/location/meeting links', () => {
  assert.equal(eventHasAnyCopyableDetails({ summary: 'Busy' }), false);
  assert.equal(eventHasAnyCopyableDetails({ summary: 'Busy', description: 'Agenda' }), true);
  assert.equal(eventHasAnyCopyableDetails({ summary: '(untitled)', location: 'Office' }), true);
  assert.equal(
    eventHasAnyCopyableDetails({
      summary: '(no title)',
      conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/abc-defg-hij' }] },
    }),
    true
  );
});

test('skip rules cover filters, free events, loop prevention, and RSVP', () => {
  assert.equal(
    shouldSkipEvent({ colorId: '1' }, ['1'], [], true, ['accepted']),
    true
  );
  assert.equal(
    shouldSkipEvent({ summary: 'Private catchup' }, [], ['private'], true, ['accepted']),
    true
  );
  assert.equal(
    shouldSkipEvent(
      { extendedProperties: { private: { syncId: 'sync-1' } } },
      [],
      [],
      true,
      ['accepted']
    ),
    true
  );
  assert.equal(
    shouldSkipEvent({ transparency: 'transparent' }, [], [], false, ['accepted']),
    true
  );
  assert.equal(
    shouldSkipEvent(
      {
        attendees: [{ self: true, responseStatus: 'declined' }],
      },
      [],
      [],
      true,
      ['accepted']
    ),
    true
  );
  assert.equal(
    shouldSkipEvent(
      {
        summary: 'Work review',
        attendees: [{ self: true, responseStatus: 'accepted' }],
      },
      [],
      [],
      true,
      ['accepted']
    ),
    false
  );
});

test('normalizeRsvpStatuses falls back to all statuses when input is invalid or empty', () => {
  assert.deepEqual(normalizeRsvpStatuses(undefined), [
    'accepted',
    'tentative',
    'needsAction',
    'declined',
  ]);
  assert.deepEqual(normalizeRsvpStatuses(['invalid']), [
    'accepted',
    'tentative',
    'needsAction',
    'declined',
  ]);
  assert.deepEqual(normalizeRsvpStatuses(['accepted', 'accepted', 'declined']), [
    'accepted',
    'declined',
  ]);
});

test('active event is skipped when the same event id is cancelled in the same delta window', () => {
  const eventId = 'series123_20260312T120000Z';
  const state = buildCancellationState([
    { id: eventId, status: 'cancelled', recurringEventId: 'series123' },
  ]);

  assert.equal(
    shouldSkipActiveEventDueToCancellation(
      { id: eventId, status: 'confirmed', recurringEventId: 'series123' },
      state
    ),
    true
  );
});

test('bulk series cancellation skips remaining active instances from the same series', () => {
  const state = buildCancellationState([
    { id: 'series123_20260312T120000Z', status: 'cancelled', recurringEventId: 'series123' },
    { id: 'series123_20260319T120000Z', status: 'cancelled', recurringEventId: 'series123' },
  ]);

  assert.equal(
    shouldSkipActiveEventDueToCancellation(
      { id: 'series123_20260326T120000Z', status: 'confirmed', recurringEventId: 'series123' },
      state
    ),
    true
  );

  assert.equal(
    shouldSkipActiveEventDueToCancellation(
      { id: 'otherSeries_20260326T120000Z', status: 'confirmed', recurringEventId: 'otherSeries' },
      state
    ),
    false
  );
});

test('single cancelled recurring instance does not suppress unrelated active instances in the series', () => {
  const state = buildCancellationState([
    { id: 'series123_20260312T120000Z', status: 'cancelled', recurringEventId: 'series123' },
  ]);

  assert.equal(
    shouldSkipActiveEventDueToCancellation(
      { id: 'series123_20260319T120000Z', status: 'confirmed', recurringEventId: 'series123' },
      state
    ),
    false
  );
});
