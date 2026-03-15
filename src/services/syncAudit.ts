import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export type SyncDirection = 'source_to_target' | 'target_to_source';
export type SyncAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'skip'
  | 'reconcile'
  | 'retry'
  | 'force_resync'
  | 'cleanup';
export type SyncResult = 'success' | 'failure' | 'skipped';

interface AuditRecordInput {
  syncId: string;
  userId: string;
  direction: SyncDirection;
  action: SyncAction;
  result: SyncResult;
  sourceEventId?: string | null;
  sourceCalendarId?: string | null;
  targetEventId?: string | null;
  targetCalendarId?: string | null;
  eventSummary?: string | null;
  reasonCode?: string | null;
  reasonMessage?: string | null;
}

interface FailureRecordInput {
  syncId: string;
  userId: string;
  direction: SyncDirection;
  action: Extract<SyncAction, 'create' | 'update' | 'delete' | 'retry' | 'force_resync' | 'cleanup'>;
  sourceEventId?: string | null;
  sourceCalendarId?: string | null;
  targetEventId?: string | null;
  targetCalendarId?: string | null;
  eventSummary?: string | null;
  errorCode?: string | null;
  errorMessage: string;
}

function normalizeOptional(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function buildFailureDedupeKey(input: FailureRecordInput): string {
  return [
    input.syncId,
    input.direction,
    input.action,
    normalizeOptional(input.sourceEventId) || '',
    normalizeOptional(input.targetEventId) || '',
  ].join(':');
}

export async function recordSyncAudit(input: AuditRecordInput) {
  await prisma.syncEventAudit.create({
    data: {
      syncId: input.syncId,
      userId: input.userId,
      direction: input.direction,
      action: input.action,
      result: input.result,
      sourceEventId: normalizeOptional(input.sourceEventId),
      sourceCalendarId: normalizeOptional(input.sourceCalendarId),
      targetEventId: normalizeOptional(input.targetEventId),
      targetCalendarId: normalizeOptional(input.targetCalendarId),
      eventSummary: normalizeOptional(input.eventSummary),
      reasonCode: normalizeOptional(input.reasonCode),
      reasonMessage: normalizeOptional(input.reasonMessage),
    },
  });
}

export async function recordSyncFailure(input: FailureRecordInput) {
  const dedupeKey = buildFailureDedupeKey(input);

  await prisma.syncFailure.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      syncId: input.syncId,
      userId: input.userId,
      direction: input.direction,
      action: input.action,
      status: 'open',
      sourceEventId: normalizeOptional(input.sourceEventId),
      sourceCalendarId: normalizeOptional(input.sourceCalendarId),
      targetEventId: normalizeOptional(input.targetEventId),
      targetCalendarId: normalizeOptional(input.targetCalendarId),
      eventSummary: normalizeOptional(input.eventSummary),
      errorCode: normalizeOptional(input.errorCode),
      errorMessage: input.errorMessage.slice(0, 2000),
    },
    update: {
      status: 'open',
      sourceEventId: normalizeOptional(input.sourceEventId),
      sourceCalendarId: normalizeOptional(input.sourceCalendarId),
      targetEventId: normalizeOptional(input.targetEventId),
      targetCalendarId: normalizeOptional(input.targetCalendarId),
      eventSummary: normalizeOptional(input.eventSummary),
      errorCode: normalizeOptional(input.errorCode),
      errorMessage: input.errorMessage.slice(0, 2000),
      lastFailedAt: new Date(),
      resolvedAt: null,
      resolutionNote: null,
      failureCount: {
        increment: 1,
      },
    },
  });

  await recordSyncAudit({
    syncId: input.syncId,
    userId: input.userId,
    direction: input.direction,
    action: input.action,
    result: 'failure',
    sourceEventId: input.sourceEventId,
    sourceCalendarId: input.sourceCalendarId,
    targetEventId: input.targetEventId,
    targetCalendarId: input.targetCalendarId,
    eventSummary: input.eventSummary,
    reasonCode: input.errorCode,
    reasonMessage: input.errorMessage,
  });
}

interface ResolveFailureInput {
  syncId: string;
  direction: SyncDirection;
  action: Extract<SyncAction, 'create' | 'update' | 'delete' | 'retry' | 'force_resync' | 'cleanup'>;
  sourceEventId?: string | null;
  targetEventId?: string | null;
  resolutionNote?: string | null;
}

export async function resolveSyncFailureByContext(input: ResolveFailureInput) {
  const dedupeKey = buildFailureDedupeKey({
    syncId: input.syncId,
    userId: '',
    direction: input.direction,
    action: input.action,
    sourceEventId: input.sourceEventId,
    targetEventId: input.targetEventId,
    errorMessage: '',
  });

  await prisma.syncFailure.updateMany({
    where: {
      dedupeKey,
      status: 'open',
    },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      resolutionNote: normalizeOptional(input.resolutionNote) || 'Resolved automatically after successful processing',
    },
  });
}

export async function resolveSyncFailureById(failureId: string, userId: string, resolutionNote?: string | null) {
  return prisma.syncFailure.updateMany({
    where: {
      id: failureId,
      userId,
    },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      resolutionNote: normalizeOptional(resolutionNote) || 'Resolved manually',
    },
  });
}

export async function resolveOpenFailuresForSourceEvent(
  syncId: string,
  userId: string,
  direction: SyncDirection,
  sourceEventId: string,
  resolutionNote?: string | null
) {
  return prisma.syncFailure.updateMany({
    where: {
      syncId,
      userId,
      direction,
      sourceEventId,
      status: 'open',
    },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      resolutionNote:
        normalizeOptional(resolutionNote) || 'Resolved automatically after manual force sync',
    },
  });
}

export async function incrementFailureRetryCount(failureId: string, userId: string) {
  return prisma.syncFailure.updateMany({
    where: {
      id: failureId,
      userId,
    },
    data: {
      retryCount: {
        increment: 1,
      },
      lastAttemptedAt: new Date(),
    },
  });
}

export async function refreshSyncFailureAfterManualAttempt(
  failureId: string,
  userId: string,
  errorCode: string | null,
  errorMessage: string
) {
  return prisma.syncFailure.updateMany({
    where: {
      id: failureId,
      userId,
    },
    data: {
      status: 'open',
      errorCode: normalizeOptional(errorCode),
      errorMessage: errorMessage.slice(0, 2000),
      lastFailedAt: new Date(),
      failureCount: {
        increment: 1,
      },
    },
  });
}

export async function getOpenSyncFailures(userId: string, limit: number = 50) {
  return prisma.syncFailure.findMany({
    where: {
      userId,
      status: 'open',
    },
    include: {
      sync: {
        select: {
          id: true,
          sourceCalendarName: true,
          targetCalendarName: true,
          lastSyncStatus: true,
        },
      },
    },
    orderBy: [
      { lastFailedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    take: limit,
  });
}
