import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncEventsDashboardService } from '../services/syncEventsDashboard';

function buildSyncRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sync-1',
    userId: 'user-1',
    googleAccountId: 'acct-primary',
    sourceGoogleAccountId: 'acct-source',
    targetGoogleAccountId: 'acct-target',
    sourceCalendarId: 'source-cal',
    sourceCalendarName: 'Source',
    targetCalendarId: 'target-cal',
    targetCalendarName: 'Target',
    isTwoWay: true,
    isActive: true,
    excludedColors: [],
    excludedKeywords: ['private'],
    syncEventTitles: true,
    syncEventDescription: true,
    syncEventLocation: true,
    syncMeetingLinks: true,
    syncFreeEvents: true,
    copyRsvpStatuses: ['accepted', 'tentative', 'needsAction', 'declined'],
    ...overrides,
  };
}

test('event list combines directions and computes failed/synced/skipped/not_synced status', async () => {
  const sync = buildSyncRecord();
  const failures = [
    {
      id: 'failure-1',
      syncId: sync.id,
      userId: sync.userId,
      status: 'open',
      direction: 'source_to_target',
      sourceEventId: 'event-a',
      sourceCalendarId: 'source-cal',
      errorMessage: 'Create failed',
      lastFailedAt: new Date('2026-03-15T09:00:00.000Z'),
    },
  ];
  const mappings = [
    {
      syncId: sync.id,
      sourceEventId: 'event-b',
      sourceCalendarId: 'source-cal',
      targetEventId: 'target-b',
      targetCalendarId: 'target-cal',
      lastSyncedAt: new Date('2026-03-15T08:00:00.000Z'),
    },
  ];

  const calendarByAccount = {
    'acct-source': {
      events: {
        list: async ({ calendarId }: any) => ({
          data: {
            items:
              calendarId === 'source-cal'
                ? [
                    {
                      id: 'event-a',
                      summary: 'Failed item',
                      start: { dateTime: '2026-03-16T10:00:00.000Z' },
                      end: { dateTime: '2026-03-16T11:00:00.000Z' },
                    },
                    {
                      id: 'event-b',
                      summary: 'Synced item',
                      start: { dateTime: '2026-03-16T12:00:00.000Z' },
                      end: { dateTime: '2026-03-16T13:00:00.000Z' },
                    },
                    {
                      id: 'event-d',
                      summary: 'Needs sync',
                      start: { dateTime: '2026-03-18T12:00:00.000Z' },
                      end: { dateTime: '2026-03-18T13:00:00.000Z' },
                    },
                  ]
                : [],
          },
        }),
      },
    },
    'acct-target': {
      events: {
        list: async ({ calendarId }: any) => ({
          data: {
            items:
              calendarId === 'target-cal'
                ? [
                    {
                      id: 'event-c',
                      summary: 'Private catchup',
                      start: { dateTime: '2026-03-17T10:00:00.000Z' },
                      end: { dateTime: '2026-03-17T11:00:00.000Z' },
                    },
                  ]
                : [],
          },
        }),
      },
    },
  } as Record<string, any>;

  const service = buildSyncEventsDashboardService({
    prisma: {
      sync: {
        findFirst: async () => sync,
      },
      syncFailure: {
        findMany: async () => failures,
      },
      syncedEvent: {
        findMany: async () => mappings,
      },
    },
    getCalendar: (async (_userId: string, accountId?: string) =>
      calendarByAccount[accountId as string]) as any,
    rateLimitRetry: async (fn) => fn(),
  });

  const result = await service.listSyncDashboardEvents(sync.id, sync.userId, {
    direction: 'all',
    pageSize: 10,
  });

  assert.equal(result.direction, 'all');
  assert.equal(result.total, 4);
  assert.deepEqual(
    result.items.map((item) => [item.sourceEventId, item.direction, item.status]),
    [
      ['event-a', 'source_to_target', 'failed'],
      ['event-b', 'source_to_target', 'synced'],
      ['event-c', 'target_to_source', 'skipped'],
      ['event-d', 'source_to_target', 'not_synced'],
    ]
  );
});

test('force sync loads the source event and returns skipped for filtered events', async () => {
  const sync = buildSyncRecord({ isTwoWay: false });
  const getCalls: any[] = [];
  const runSyncCalls: any[] = [];
  const resolvedFailures: any[] = [];

  const service = buildSyncEventsDashboardService({
    prisma: {
      sync: {
        findFirst: async () => sync,
      },
      syncFailure: {
        findMany: async () => [],
      },
      syncedEvent: {
        findMany: async () => [],
      },
    },
    getCalendar: (async () => ({
      events: {
        get: async (input: any) => {
          getCalls.push(input);
          return {
            data: {
              id: 'event-filtered',
              summary: 'Private review',
              start: { dateTime: '2026-03-16T10:00:00.000Z' },
              end: { dateTime: '2026-03-16T11:00:00.000Z' },
            },
          };
        },
      },
    })) as any,
    rateLimitRetry: async (fn) => fn(),
    runSyncEvent: async (...args: any[]) => {
      runSyncCalls.push(args);
    },
    recordAudit: async () => undefined,
    resolveFailuresForSourceEvent: async (...args: any[]) => {
      resolvedFailures.push(args);
      return { count: 1 };
    },
  });

  const result = await service.forceSyncDashboardEvent(sync.id, sync.userId, {
    direction: 'source_to_target',
    sourceEventId: 'event-filtered',
    sourceCalendarId: 'source-cal',
  });

  assert.equal(getCalls.length, 1);
  assert.equal(runSyncCalls.length, 1);
  assert.equal(result.item.status, 'skipped');
  assert.match(result.item.statusReason, /excluded keyword/i);
  assert.equal(resolvedFailures.length, 1);
});

test('force sync returns synced after a successful run updates the mapping state', async () => {
  const sync = buildSyncRecord({ isTwoWay: false, excludedKeywords: [] });
  const mappings: any[] = [];

  const service = buildSyncEventsDashboardService({
    prisma: {
      sync: {
        findFirst: async () => sync,
      },
      syncFailure: {
        findMany: async () => [],
      },
      syncedEvent: {
        findMany: async () => mappings,
      },
    },
    getCalendar: (async () => ({
      events: {
        get: async () => ({
          data: {
            id: 'event-success',
            summary: 'Client review',
            start: { dateTime: '2026-03-16T12:00:00.000Z' },
            end: { dateTime: '2026-03-16T13:00:00.000Z' },
          },
        }),
      },
    })) as any,
    rateLimitRetry: async (fn) => fn(),
    runSyncEvent: async () => {
      mappings.splice(0, mappings.length, {
        syncId: sync.id,
        sourceEventId: 'event-success',
        sourceCalendarId: 'source-cal',
        targetEventId: 'target-success',
        targetCalendarId: 'target-cal',
        lastSyncedAt: new Date('2026-03-15T10:30:00.000Z'),
      });
    },
    recordAudit: async () => undefined,
    resolveFailuresForSourceEvent: async () => ({ count: 1 }),
  });

  const result = await service.forceSyncDashboardEvent(sync.id, sync.userId, {
    direction: 'source_to_target',
    sourceEventId: 'event-success',
    sourceCalendarId: 'source-cal',
  });

  assert.equal(result.item.status, 'synced');
  assert.equal(result.item.targetEventId, 'target-success');
  assert.match(result.item.statusReason, /target-success/i);
});
