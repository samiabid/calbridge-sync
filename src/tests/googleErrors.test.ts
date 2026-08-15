import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGoogleErrorStatus,
  isGoogleCalendarEventGoneError,
} from '../services/googleErrors';

test('Google calendar event gone errors include 404 and 410 statuses', () => {
  assert.equal(isGoogleCalendarEventGoneError({ code: 404 }), true);
  assert.equal(isGoogleCalendarEventGoneError({ status: 410 }), true);
  assert.equal(isGoogleCalendarEventGoneError({ response: { status: 404 } }), true);
  assert.equal(isGoogleCalendarEventGoneError({ response: { status: 410 } }), true);
});

test('Google error status ignores non-numeric codes', () => {
  assert.equal(getGoogleErrorStatus({ code: '410' }), undefined);
  assert.equal(isGoogleCalendarEventGoneError({ code: 403 }), false);
  assert.equal(isGoogleCalendarEventGoneError({}), false);
});
