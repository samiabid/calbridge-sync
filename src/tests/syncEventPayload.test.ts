import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTargetEventRequestBody,
  type TargetEventCopySettings,
} from '../services/syncEventPayload';

function settings(
  overrides: Partial<TargetEventCopySettings> = {}
): TargetEventCopySettings {
  return {
    syncEventTitles: true,
    syncEventDescription: true,
    syncEventLocation: true,
    syncMeetingLinks: true,
    markEventPrivate: false,
    disableRemindersForClones: false,
    eventIdentifier: null,
    cloneColorId: null,
    ...overrides,
  };
}

const sourceEvent = {
  id: 'source-event-1',
  summary: 'Client Strategy Meeting',
  description: 'Review the launch plan.',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  location: 'Studio 2',
  colorId: '7',
  visibility: 'default',
  reminders: { useDefault: true },
  start: { dateTime: '2026-08-14T10:00:00Z' },
  end: { dateTime: '2026-08-14T11:00:00Z' },
};

test('identifier is appended to a copied source title and never enters the description', () => {
  const body = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ eventIdentifier: '  (Solvaa)  ' })
  );

  assert.equal(body.summary, 'Client Strategy Meeting (Solvaa)');
  assert.equal(
    body.description,
    'Review the launch plan.\n\nMeeting Link: https://meet.google.com/abc-defg-hij'
  );
  assert.doesNotMatch(body.description || '', /Solvaa/);
});

test('identifier becomes the custom title when source title syncing is disabled', () => {
  const body = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ syncEventTitles: false, eventIdentifier: '(Solvaa)' })
  );

  assert.equal(body.summary, '(Solvaa)');
});

test('all four title and identifier combinations have stable behavior', () => {
  const titleAndIdentifier = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ syncEventTitles: true, eventIdentifier: '(Solvaa)' })
  );
  const titleOnly = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ syncEventTitles: true, eventIdentifier: null })
  );
  const identifierOnly = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ syncEventTitles: false, eventIdentifier: '(Solvaa)' })
  );
  const busyOnly = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ syncEventTitles: false, eventIdentifier: null })
  );

  assert.equal(titleAndIdentifier.summary, 'Client Strategy Meeting (Solvaa)');
  assert.equal(titleOnly.summary, 'Client Strategy Meeting');
  assert.equal(identifierOnly.summary, '(Solvaa)');
  assert.equal(busyOnly.summary, 'Busy');
});

test('description, meeting link, and location settings remain independent of the identifier', () => {
  const body = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({
      eventIdentifier: '(Solvaa)',
      syncEventDescription: false,
      syncMeetingLinks: true,
    })
  );

  assert.equal(body.description, 'Meeting Link: https://meet.google.com/abc-defg-hij');
  assert.equal(body.location, 'Studio 2');
});

test('blank identifiers preserve source-title and Busy fallback behavior', () => {
  const copiedTitle = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ eventIdentifier: '   ' })
  );
  const hiddenTitle = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ syncEventTitles: false, eventIdentifier: '   ' })
  );
  const missingTitle = buildTargetEventRequestBody(
    'sync-1',
    { ...sourceEvent, summary: '  ' },
    settings({ eventIdentifier: null })
  );
  const missingTitleWithIdentifier = buildTargetEventRequestBody(
    'sync-1',
    { ...sourceEvent, summary: '  ' },
    settings({ eventIdentifier: '(Solvaa)' })
  );

  assert.equal(copiedTitle.summary, 'Client Strategy Meeting');
  assert.equal(hiddenTitle.summary, 'Busy');
  assert.equal(missingTitle.summary, 'Busy');
  assert.equal(missingTitleWithIdentifier.summary, 'Busy (Solvaa)');
});

test('target payload preserves event fields and sync metadata for create and update paths', () => {
  const body = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ eventIdentifier: '(Solvaa)', markEventPrivate: true })
  );

  assert.deepEqual(body.start, sourceEvent.start);
  assert.deepEqual(body.end, sourceEvent.end);
  assert.equal(body.colorId, '7');
  assert.equal(body.visibility, 'private');
  assert.deepEqual(body.reminders, sourceEvent.reminders);
  assert.deepEqual(body.extendedProperties.private, {
    syncId: 'sync-1',
    originalEventId: 'source-event-1',
  });
});

test('configured clone color overrides the source event color', () => {
  const body = buildTargetEventRequestBody(
    'sync-1',
    { ...sourceEvent, colorId: '2' },
    settings({ cloneColorId: '10' })
  );

  assert.equal(body.colorId, '10');
});

test('blank or invalid clone colors preserve the source event color', () => {
  const blankColor = buildTargetEventRequestBody(
    'sync-1',
    { ...sourceEvent, colorId: '2' },
    settings({ cloneColorId: '  ' })
  );
  const invalidColor = buildTargetEventRequestBody(
    'sync-1',
    { ...sourceEvent, colorId: '2' },
    settings({ cloneColorId: '99' })
  );

  assert.equal(blankColor.colorId, '2');
  assert.equal(invalidColor.colorId, '2');
});
