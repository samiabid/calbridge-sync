import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionDiagnosticsService } from '../services/productionDiagnostics';

test('production diagnostics reports duplicate mappings, webhook issues, failures, and accounts', async () => {
  const now = new Date('2026-06-02T12:00:00.000Z');
  const service = buildProductionDiagnosticsService({
    now: () => now,
    prisma: {
      syncedEvent: {
        findMany: async () => [
          {
            syncId: 'sync-1',
            sourceCalendarId: 'source-cal',
            sourceEventId: 'event-1',
            targetEventId: 'target-a',
          },
          {
            syncId: 'sync-1',
            sourceCalendarId: 'source-cal',
            sourceEventId: 'event-1',
            targetEventId: 'target-b',
          },
          {
            syncId: 'sync-1',
            sourceCalendarId: 'source-cal',
            sourceEventId: 'event-2',
            targetEventId: 'target-c',
          },
        ],
      },
      sync: {
        findMany: async () => [
          {
            id: 'sync-1',
            isTwoWay: true,
            sourceCalendarId: 'source-cal',
            targetCalendarId: 'target-cal',
            sourceChannelId: null,
            sourceResourceId: 'resource-source',
            sourceExpiration: null,
            targetChannelId: 'target-channel',
            targetResourceId: 'target-resource',
            targetExpiration: new Date('2026-06-02T10:00:00.000Z'),
            sourceSyncToken: null,
            targetSyncToken: 'target-token',
            sourceRecurrenceHorizon: new Date('2026-06-01T00:00:00.000Z'),
            targetRecurrenceHorizon: new Date('2027-06-01T00:00:00.000Z'),
          },
        ],
      },
      syncFailure: {
        count: async () => 1,
        findMany: async () => [
          {
            id: 'failure-1',
            syncId: 'sync-1',
            direction: 'source_to_target',
            action: 'create',
            sourceEventId: 'event-1',
            targetEventId: null,
            errorCode: '500',
            errorMessage: 'Create failed',
            lastFailedAt: new Date('2026-06-02T11:00:00.000Z'),
          },
        ],
      },
      googleAccount: {
        findMany: async () => [
          { id: 'acct-ok', displayName: 'hello@pointillist.org' },
          { id: 'acct-bad', displayName: 'sami@solvaa.co.uk' },
        ],
      },
    },
    getCalendar: async (_userId: string, accountId?: string) => {
      if (accountId === 'acct-bad') {
        throw new Error('invalid_grant');
      }
      return {
        calendarList: {
          list: async () => ({ data: { items: [] } }),
        },
      } as any;
    },
  });

  const result = await service.getProductionDiagnostics('user-1');

  assert.equal(result.generatedAt, now.toISOString());
  assert.equal(result.duplicateMappings.length, 1);
  assert.equal(result.duplicateMappings[0].sourceEventId, 'event-1');
  assert.deepEqual(result.duplicateMappings[0].targetEventIds, ['target-a', 'target-b']);
  assert.deepEqual(
    result.webhookIssues.map((issue) => issue.issue).sort(),
    ['expired', 'missing_channel', 'missing_expiration']
  );
  assert.deepEqual(
    result.incrementalSyncIssues.map((issue) => issue.issue).sort(),
    ['expired_recurrence_horizon', 'missing_sync_token']
  );
  assert.equal(result.openFailures.count, 1);
  assert.equal(result.openFailures.recent[0].lastFailedAt, '2026-06-02T11:00:00.000Z');
  assert.equal(result.accountIssues.find((account) => account.accountId === 'acct-ok')?.status, 'connected');
  assert.equal(result.accountIssues.find((account) => account.accountId === 'acct-bad')?.status, 'disconnected');
});
