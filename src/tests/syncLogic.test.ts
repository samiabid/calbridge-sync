import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCancellationState,
  computeNextWebhookWatermark,
  eventHasAnyCopyableDetails,
  getRecurringSeriesIdFromEventId,
  isDetailPlaceholderSummary,
  needsReadableSourceDetails,
  normalizeRsvpStatuses,
  resolveSyncAccounts,
  shouldAttemptAccountDetection,
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

test('loop prevention allows safe multi-hop syncs but blocks repeated paths', () => {
  const clone = {
    extendedProperties: {
      private: {
        syncId: 'sync-1',
        syncLineage: '["sync-1"]',
        calendarLineage: '["calendar-a","calendar-b"]',
      },
    },
  };
  const excludedColors: string[] = [];
  const excludedKeywords: string[] = [];
  const rsvpStatuses = ['accepted'];

  assert.equal(
    shouldSkipEvent(clone, excludedColors, excludedKeywords, true, rsvpStatuses, { syncId: 'sync-2', targetCalendarId: 'calendar-c' }),
    false
  );
  assert.equal(
    shouldSkipEvent(clone, excludedColors, excludedKeywords, true, rsvpStatuses, { syncId: 'sync-1', targetCalendarId: 'calendar-c' }),
    true
  );
  assert.equal(
    shouldSkipEvent(clone, excludedColors, excludedKeywords, true, rsvpStatuses, { syncId: 'sync-2', targetCalendarId: 'calendar-a' }),
    true
  );
  assert.equal(
    shouldSkipEvent(
      { extendedProperties: { private: { syncId: 'legacy-sync' } } },
      excludedColors,
      excludedKeywords,
      true,
      rsvpStatuses,
      { syncId: 'sync-2', targetCalendarId: 'calendar-c' }
    ),
    true
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

test('multiple cancelled instances never imply that the whole series was cancelled', () => {
  const state = buildCancellationState([
    { id: 'series123_20260312T120000Z', status: 'cancelled', recurringEventId: 'series123' },
    { id: 'series123_20260319T120000Z', status: 'cancelled', recurringEventId: 'series123' },
  ]);

  assert.equal(
    shouldSkipActiveEventDueToCancellation(
      { id: 'series123_20260326T120000Z', status: 'confirmed', recurringEventId: 'series123' },
      state
    ),
    false
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

test('watermark never advances past fetch start', () => {
  const overlapMs = 2 * 60 * 1000;
  const fetchStart = new Date('2026-07-01T12:00:00.000Z');

  // Event updated during processing (after fetch start): clamp to fetch start.
  const lateChange = new Date('2026-07-01T12:05:00.000Z');
  assert.deepEqual(
    computeNextWebhookWatermark(fetchStart, lateChange, overlapMs),
    new Date(fetchStart.getTime() - overlapMs)
  );

  // Older detected change keeps the extra overlap.
  const earlyChange = new Date('2026-07-01T11:30:00.000Z');
  assert.deepEqual(
    computeNextWebhookWatermark(fetchStart, earlyChange, overlapMs),
    new Date(earlyChange.getTime() - overlapMs)
  );

  // No detected change: fetch start minus overlap.
  assert.deepEqual(
    computeNextWebhookWatermark(fetchStart, null, overlapMs),
    new Date(fetchStart.getTime() - overlapMs)
  );
});

test('account detection re-opens after the cooldown', () => {
  const now = new Date('2026-07-01T12:00:00.000Z');
  const sixHoursMs = 6 * 60 * 60 * 1000;

  assert.deepEqual(shouldAttemptAccountDetection(0, null, now), {
    attempt: true,
    isCooldownRetry: false,
  });
  assert.deepEqual(shouldAttemptAccountDetection(2, new Date(now.getTime() - 1000), now), {
    attempt: true,
    isCooldownRetry: false,
  });

  // Exhausted and recent: blocked.
  assert.deepEqual(shouldAttemptAccountDetection(3, new Date(now.getTime() - 1000), now), {
    attempt: false,
    isCooldownRetry: false,
  });

  // Exhausted but cooled down: retry.
  assert.deepEqual(shouldAttemptAccountDetection(3, new Date(now.getTime() - sixHoursMs), now), {
    attempt: true,
    isCooldownRetry: true,
  });

  // Exhausted with no recorded attempt time (pre-migration rows): retry.
  assert.deepEqual(shouldAttemptAccountDetection(3, null, now), {
    attempt: true,
    isCooldownRetry: true,
  });
});

test('recurring series id extraction from bare event ids', () => {
  assert.equal(getRecurringSeriesIdFromEventId('series123_20260326T120000Z'), 'series123');
  assert.equal(getRecurringSeriesIdFromEventId('plainEvent'), undefined);
  // Imported events can have ids starting with an underscore.
  assert.equal(getRecurringSeriesIdFromEventId('_abc123'), undefined);
  assert.equal(getRecurringSeriesIdFromEventId(undefined), undefined);
  assert.equal(getRecurringSeriesIdFromEventId(42 as any), undefined);
});

test('resolveSyncAccounts falls back to the legacy account id', () => {
  assert.deepEqual(
    resolveSyncAccounts({
      googleAccountId: 'legacy',
      sourceGoogleAccountId: null,
      targetGoogleAccountId: 'target',
    }),
    { sourceAccountId: 'legacy', targetAccountId: 'target' }
  );
  assert.deepEqual(
    resolveSyncAccounts({ googleAccountId: 'legacy' }),
    { sourceAccountId: 'legacy', targetAccountId: 'legacy' }
  );
});
