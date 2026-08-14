import type { SyncDirection } from './syncAudit';

export interface BackfillDirectionContext {
  direction: SyncDirection;
  sourceCalendarId: string;
  targetCalendarId: string;
  sourceGoogleAccountId: string;
  targetGoogleAccountId: string;
}

export interface BackfillSyncContext {
  googleAccountId: string;
  sourceGoogleAccountId?: string | null;
  targetGoogleAccountId?: string | null;
  sourceCalendarId: string;
  targetCalendarId: string;
  isTwoWay: boolean;
}

export function buildBackfillDirectionContexts(
  sync: BackfillSyncContext
): BackfillDirectionContext[] {
  const sourceAccountId = sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetAccountId = sync.targetGoogleAccountId || sync.googleAccountId;
  const contexts: BackfillDirectionContext[] = [
    {
      direction: 'source_to_target',
      sourceCalendarId: sync.sourceCalendarId,
      targetCalendarId: sync.targetCalendarId,
      sourceGoogleAccountId: sourceAccountId,
      targetGoogleAccountId: targetAccountId,
    },
  ];

  if (sync.isTwoWay) {
    contexts.push({
      direction: 'target_to_source',
      sourceCalendarId: sync.targetCalendarId,
      targetCalendarId: sync.sourceCalendarId,
      sourceGoogleAccountId: targetAccountId,
      targetGoogleAccountId: sourceAccountId,
    });
  }

  return contexts;
}

export function isBackfillRunStale(startedAt: Date | null, now: Date, staleAfterMs: number) {
  return !startedAt || now.getTime() - startedAt.getTime() >= staleAfterMs;
}

export function buildDestinationAccountUpdate(
  direction: SyncDirection,
  accountId: string | null
): { sourceGoogleAccountId?: string | null; targetGoogleAccountId?: string | null } {
  return direction === 'target_to_source'
    ? { sourceGoogleAccountId: accountId }
    : { targetGoogleAccountId: accountId };
}
