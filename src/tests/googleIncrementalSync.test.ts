import test from 'node:test';
import assert from 'node:assert/strict';
import {
  establishSyncToken,
  listIncrementalChanges,
  listRecurringInstances,
} from '../services/webhook';

test('sync-token baseline uses unexpanded masters and paginates to the final token', async () => {
  const requests: any[] = [];
  const calendar = {
    events: {
      list: async (request: any) => {
        requests.push(request);
        return requests.length === 1
          ? { data: { nextPageToken: 'page-2' } }
          : { data: { nextSyncToken: 'baseline-token' } };
      },
    },
  };

  assert.equal(await establishSyncToken(calendar, 'calendar-1', 'sync-1'), 'baseline-token');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].singleEvents, false);
  assert.equal(requests[0].showDeleted, true);
  assert.equal(requests[1].pageToken, 'page-2');
});

test('incremental request uses only sync-token-compatible filters', async () => {
  let request: any;
  const calendar = {
    events: {
      list: async (value: any) => {
        request = value;
        return { data: { items: [{ id: 'event-1' }], nextSyncToken: 'next-token' } };
      },
    },
  };

  const result = await listIncrementalChanges(calendar, 'calendar-1', 'token-1', 'sync-1');
  assert.equal(result.nextSyncToken, 'next-token');
  assert.deepEqual(result.events.map((event) => event.id), ['event-1']);
  assert.equal(request.syncToken, 'token-1');
  assert.equal(request.singleEvents, false);
  assert.equal(request.timeMin, undefined);
  assert.equal(request.timeMax, undefined);
  assert.equal(request.updatedMin, undefined);
  assert.equal(request.orderBy, undefined);
});

test('changed recurring masters expand through the bounded instances endpoint', async () => {
  let request: any;
  const calendar = {
    events: {
      instances: async (value: any) => {
        request = value;
        return { data: { items: [{ id: 'instance-1', recurringEventId: 'series-1' }] } };
      },
    },
  };
  const events = await listRecurringInstances(
    calendar,
    'calendar-1',
    'series-1',
    new Date('2026-06-01T00:00:00Z'),
    new Date('2027-08-01T00:00:00Z'),
    'sync-1'
  );

  assert.equal(events.length, 1);
  assert.equal(request.eventId, 'series-1');
  assert.equal(request.showDeleted, true);
  assert.equal(request.timeMin, '2026-06-01T00:00:00.000Z');
  assert.equal(request.timeMax, '2027-08-01T00:00:00.000Z');
});
