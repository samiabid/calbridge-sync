import { PrismaClient } from '@prisma/client';
import { getAuthenticatedCalendar } from './calendar';
import { withRateLimitRetry } from './rateLimit';
import { handleEventDeletion, syncEvent } from './sync';
import { recordSyncAudit, type SyncDirection } from './syncAudit';
import {
  buildRepairWindow,
  classifyOrphanCandidate,
  getOrphanReasonMessage,
  getOriginalEventIdFromTargetEvent,
  getTargetEventSyncId,
  type OrphanReason,
} from './syncRepairLogic';

const prisma = new PrismaClient();

interface RepairOptions {
  daysBack?: unknown;
  daysForward?: unknown;
}

interface DirectionContext {
  direction: SyncDirection;
  sourceCalendarId: string;
  targetCalendarId: string;
  sourceGoogleAccountId: string;
  targetGoogleAccountId: string;
}

export interface ReconciliationDirectionResult {
  direction: SyncDirection;
  processed: number;
  synced: number;
  deleted: number;
  failed: number;
}

export interface ReconciliationResult {
  syncId: string;
  window: ReturnType<typeof buildRepairWindow>;
  directions: ReconciliationDirectionResult[];
}

export interface OrphanCandidate {
  direction: SyncDirection;
  reason: OrphanReason;
  reasonMessage: string;
  targetEventId: string;
  targetCalendarId: string;
  targetSummary: string | null;
  sourceEventId: string | null;
}

export interface OrphanScanResult {
  syncId: string;
  window: ReturnType<typeof buildRepairWindow>;
  scannedTargetEvents: number;
  candidates: OrphanCandidate[];
}

function getDirectionContexts(sync: any): DirectionContext[] {
  const sourceGoogleAccountId = sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetGoogleAccountId = sync.targetGoogleAccountId || sync.googleAccountId;

  const contexts: DirectionContext[] = [
    {
      direction: 'source_to_target',
      sourceCalendarId: sync.sourceCalendarId,
      targetCalendarId: sync.targetCalendarId,
      sourceGoogleAccountId,
      targetGoogleAccountId,
    },
  ];

  if (sync.isTwoWay) {
    contexts.push({
      direction: 'target_to_source',
      sourceCalendarId: sync.targetCalendarId,
      targetCalendarId: sync.sourceCalendarId,
      sourceGoogleAccountId: targetGoogleAccountId,
      targetGoogleAccountId: sourceGoogleAccountId,
    });
  }

  return contexts;
}

async function getSyncOrThrow(syncId: string, userId: string) {
  const sync = await prisma.sync.findFirst({
    where: {
      id: syncId,
      userId,
    },
  });

  if (!sync) {
    throw new Error('Sync not found');
  }

  if (!sync.isActive) {
    throw new Error('Sync must be active before running repair tools');
  }

  return sync;
}

async function listEventsInWindow(
  calendar: any,
  calendarId: string,
  options: {
    timeMin: string;
    timeMax: string;
    showDeleted: boolean;
    privateExtendedProperty?: string[];
  },
  context: string
) {
  const events: any[] = [];
  let pageToken: string | undefined;

  do {
    const response: any = await withRateLimitRetry(
      () =>
        calendar.events.list({
          calendarId,
          timeMin: options.timeMin,
          timeMax: options.timeMax,
          showDeleted: options.showDeleted,
          singleEvents: true,
          maxResults: 2500,
          pageToken,
          privateExtendedProperty: options.privateExtendedProperty,
        } as any),
      context
    );

    if (Array.isArray(response.data.items)) {
      events.push(...response.data.items);
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return events;
}

async function checkSourceEventExists(calendar: any, calendarId: string, eventId: string) {
  try {
    const response: any = await withRateLimitRetry(
      () =>
        calendar.events.get({
          calendarId,
          eventId,
        }),
      `verifying source event ${eventId} during orphan scan`
    );

    return Boolean(response.data?.id) && response.data?.status !== 'cancelled';
  } catch (error: any) {
    const status = error?.code || error?.response?.status;
    if (status === 404) {
      return false;
    }
    throw error;
  }
}

export async function runSyncReconciliation(
  syncId: string,
  userId: string,
  options: RepairOptions = {}
): Promise<ReconciliationResult> {
  const sync = await getSyncOrThrow(syncId, userId);
  const window = buildRepairWindow(options.daysBack, options.daysForward);
  const contexts = getDirectionContexts(sync);
  const directions: ReconciliationDirectionResult[] = [];

  for (const context of contexts) {
    const sourceCalendar = await getAuthenticatedCalendar(userId, context.sourceGoogleAccountId);
    const sourceEvents = await listEventsInWindow(
      sourceCalendar,
      context.sourceCalendarId,
      {
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        showDeleted: true,
      },
      `listing events for reconciliation on sync ${syncId}`
    );

    const result: ReconciliationDirectionResult = {
      direction: context.direction,
      processed: 0,
      synced: 0,
      deleted: 0,
      failed: 0,
    };

    for (const event of sourceEvents) {
      if (!event?.id) continue;
      result.processed += 1;

      try {
        if (event.status === 'cancelled') {
          await handleEventDeletion(
            sync.id,
            userId,
            event.id,
            context.sourceCalendarId,
            context.targetGoogleAccountId,
            undefined,
            context.direction
          );
          result.deleted += 1;
        } else {
          await syncEvent(
            sync.id,
            userId,
            event,
            context.sourceCalendarId,
            context.targetCalendarId,
            context.targetGoogleAccountId,
            false,
            context.sourceGoogleAccountId,
            context.direction
          );
          result.synced += 1;
        }
      } catch (error: any) {
        result.failed += 1;
        console.error(
          `Reconciliation failed for sync ${syncId} (${context.direction}) event ${event.id}:`,
          error
        );
      }
    }

    directions.push(result);
    await recordSyncAudit({
      syncId: sync.id,
      userId,
      direction: context.direction,
      action: 'reconcile',
      result: result.failed > 0 ? 'failure' : 'success',
      reasonMessage: `Reconciliation window ${window.daysBack}d back / ${window.daysForward}d forward: processed=${result.processed}, synced=${result.synced}, deleted=${result.deleted}, failed=${result.failed}`,
    });
  }

  return {
    syncId: sync.id,
    window,
    directions,
  };
}

export async function scanSyncOrphanClones(
  syncId: string,
  userId: string,
  options: RepairOptions = {}
): Promise<OrphanScanResult> {
  const sync = await getSyncOrThrow(syncId, userId);
  const window = buildRepairWindow(options.daysBack, options.daysForward);
  const contexts = getDirectionContexts(sync);
  const candidates: OrphanCandidate[] = [];
  let scannedTargetEvents = 0;

  for (const context of contexts) {
    const targetCalendar = await getAuthenticatedCalendar(userId, context.targetGoogleAccountId);
    const sourceCalendar = await getAuthenticatedCalendar(userId, context.sourceGoogleAccountId);
    const targetEvents = await listEventsInWindow(
      targetCalendar,
      context.targetCalendarId,
      {
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        showDeleted: false,
        privateExtendedProperty: [`syncId=${sync.id}`],
      },
      `scanning sync-tagged target events for sync ${syncId}`
    );

    scannedTargetEvents += targetEvents.length;

    const targetEventIds = targetEvents
      .map((event) => (typeof event?.id === 'string' ? event.id : null))
      .filter((eventId): eventId is string => Boolean(eventId));

    const mappings = targetEventIds.length
      ? await prisma.syncedEvent.findMany({
          where: {
            syncId: sync.id,
            targetCalendarId: context.targetCalendarId,
            targetEventId: { in: targetEventIds },
          },
        })
      : [];

    const mappingByTargetEventId = new Map(mappings.map((mapping) => [mapping.targetEventId, mapping]));

    for (const targetEvent of targetEvents) {
      if (!targetEvent?.id) continue;
      if (getTargetEventSyncId(targetEvent) !== sync.id) continue;

      const originalEventId = getOriginalEventIdFromTargetEvent(targetEvent);
      const mapping = mappingByTargetEventId.get(targetEvent.id);
      let sourceExists: boolean | null | undefined = undefined;

      if (originalEventId && mapping && (!mapping.sourceEventId || mapping.sourceEventId === originalEventId)) {
        sourceExists = await checkSourceEventExists(
          sourceCalendar,
          context.sourceCalendarId,
          originalEventId
        );
      }

      const reason = classifyOrphanCandidate({
        originalEventId,
        hasMapping: Boolean(mapping),
        mappingSourceEventId: mapping?.sourceEventId || null,
        sourceExists,
      });

      if (!reason) continue;

      candidates.push({
        direction: context.direction,
        reason,
        reasonMessage: getOrphanReasonMessage(reason),
        targetEventId: targetEvent.id,
        targetCalendarId: context.targetCalendarId,
        targetSummary:
          typeof targetEvent.summary === 'string' && targetEvent.summary.trim().length > 0
            ? targetEvent.summary
            : null,
        sourceEventId: originalEventId,
      });
    }
  }

  return {
    syncId: sync.id,
    window,
    scannedTargetEvents,
    candidates,
  };
}

export async function cleanupSyncOrphanClone(
  syncId: string,
  userId: string,
  input: {
    direction: SyncDirection;
    targetEventId: string;
    targetCalendarId?: string;
    sourceEventId?: string | null;
    eventSummary?: string | null;
  }
) {
  if (!input.targetEventId) {
    throw new Error('Target event ID is required');
  }

  const sync = await getSyncOrThrow(syncId, userId);
  const context = getDirectionContexts(sync).find((item) => item.direction === input.direction);

  if (!context) {
    throw new Error('Invalid cleanup direction');
  }

  if (input.targetCalendarId && input.targetCalendarId !== context.targetCalendarId) {
    throw new Error('Target calendar does not match this sync direction');
  }

  const calendar = await getAuthenticatedCalendar(userId, context.targetGoogleAccountId);
  let targetSummary = input.eventSummary || null;
  let sourceEventId = input.sourceEventId || null;

  try {
    const response = await withRateLimitRetry(
      () =>
        calendar.events.get({
          calendarId: context.targetCalendarId,
          eventId: input.targetEventId,
        }),
      `loading orphan target event ${input.targetEventId}`
    );

    const targetEvent = response.data;
    if (getTargetEventSyncId(targetEvent) !== sync.id) {
      throw new Error('Target event is not tagged for this sync');
    }

    targetSummary =
      typeof targetEvent.summary === 'string' && targetEvent.summary.trim().length > 0
        ? targetEvent.summary
        : targetSummary;
    sourceEventId = getOriginalEventIdFromTargetEvent(targetEvent) || sourceEventId;

    await withRateLimitRetry(
      () =>
        calendar.events.delete({
          calendarId: context.targetCalendarId,
          eventId: input.targetEventId,
        }),
      `deleting orphan target event ${input.targetEventId}`
    );
  } catch (error: any) {
    const status = error?.code || error?.response?.status;
    if (status !== 404) {
      throw error;
    }
  }

  await prisma.syncedEvent.deleteMany({
    where: {
      syncId: sync.id,
      targetCalendarId: context.targetCalendarId,
      targetEventId: input.targetEventId,
    },
  });

  await recordSyncAudit({
    syncId: sync.id,
    userId,
    direction: input.direction,
    action: 'cleanup',
    result: 'success',
    sourceEventId,
    sourceCalendarId: context.sourceCalendarId,
    targetEventId: input.targetEventId,
    targetCalendarId: context.targetCalendarId,
    eventSummary: targetSummary,
    reasonCode: 'orphan_cleanup',
    reasonMessage: 'Scoped orphan clone cleanup succeeded',
  });

  return {
    success: true,
  };
}
