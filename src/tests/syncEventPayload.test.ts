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

test('identifier exactly replaces a copied source title and never enters the description', () => {
  const body = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ eventIdentifier: '  (Solvaa)  ' })
  );

  assert.equal(body.summary, '(Solvaa)');
  assert.equal(
    body.description,
    'Review the launch plan.\n\nMeeting Link: https://meet.google.com/abc-defg-hij'
  );
  assert.doesNotMatch(body.description || '', /Solvaa/);
});

test('identifier replaces the title even when source title syncing is disabled', () => {
  const body = buildTargetEventRequestBody(
    'sync-1',
    sourceEvent,
    settings({ syncEventTitles: false, eventIdentifier: '(Solvaa)' })
  );

  assert.equal(body.summary, '(Solvaa)');
});

test('source description and meeting link settings remain independent of the identifier', () => {
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

  assert.equal(copiedTitle.summary, 'Client Strategy Meeting');
  assert.equal(hiddenTitle.summary, 'Busy');
  assert.equal(missingTitle.summary, 'Busy');
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
