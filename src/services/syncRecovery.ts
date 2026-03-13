import { PrismaClient } from '@prisma/client';
import { getAuthenticatedCalendar } from './calendar';
import { withRateLimitRetry } from './rateLimit';
import { handleEventDeletion, syncEvent } from './sync';
import {
  incrementFailureRetryCount,
  recordSyncAudit,
  refreshSyncFailureAfterManualAttempt,
  resolveSyncFailureById,
  type SyncDirection,
} from './syncAudit';

const prisma = new PrismaClient();

function getDirectionContext(sync: any, direction: SyncDirection) {
  if (direction === 'source_to_target') {
    return {
      sourceCalendarId: sync.sourceCalendarId,
      targetCalendarId: sync.targetCalendarId,
      sourceGoogleAccountId: sync.sourceGoogleAccountId || sync.googleAccountId,
      targetGoogleAccountId: sync.targetGoogleAccountId || sync.googleAccountId,
    };
  }

  return {
    sourceCalendarId: sync.targetCalendarId,
    targetCalendarId: sync.sourceCalendarId,
    sourceGoogleAccountId: sync.targetGoogleAccountId || sync.googleAccountId,
    targetGoogleAccountId: sync.sourceGoogleAccountId || sync.googleAccountId,
  };
}

async function getFailureOrThrow(failureId: string, userId: string) {
  const failure = await prisma.syncFailure.findFirst({
    where: {
      id: failureId,
      userId,
    },
    include: {
      sync: true,
    },
  });

  if (!failure) {
    throw new Error('Failed event not found');
  }

  if (!failure.sync || !failure.sync.isActive) {
    throw new Error('Sync is missing or inactive');
  }

  return failure;
}

export async function retrySyncFailure(failureId: string, userId: string) {
  const failure = await getFailureOrThrow(failureId, userId);
  const direction = failure.direction as SyncDirection;
  const context = getDirectionContext(failure.sync, direction);

  await incrementFailureRetryCount(failureId, userId);

  try {
    if (failure.action === 'delete') {
      if (!failure.sourceEventId) {
        throw new Error('Cannot retry delete without source event ID');
      }

      await handleEventDeletion(
        failure.syncId,
        userId,
        failure.sourceEventId,
        failure.sourceCalendarId || context.sourceCalendarId,
        context.targetGoogleAccountId,
        undefined,
        direction
      );
    } else {
      if (!failure.sourceEventId) {
        throw new Error('Cannot retry sync without source event ID');
      }

      const sourceCalendar = await getAuthenticatedCalendar(userId, context.sourceGoogleAccountId);
      const response = await withRateLimitRetry(
        () =>
          sourceCalendar.events.get({
            calendarId: failure.sourceCalendarId || context.sourceCalendarId,
            eventId: failure.sourceEventId!,
          }),
        `retrying failed event ${failure.sourceEventId}`
      );

      if (!response.data?.id) {
        throw new Error('Source event could not be loaded for retry');
      }

      await syncEvent(
        failure.syncId,
        userId,
        response.data,
        failure.sourceCalendarId || context.sourceCalendarId,
        failure.targetCalendarId || context.targetCalendarId,
        context.targetGoogleAccountId,
        false,
        context.sourceGoogleAccountId,
        direction
      );
    }

    await resolveSyncFailureById(failureId, userId, 'Recovered manually via retry');
    await recordSyncAudit({
      syncId: failure.syncId,
      userId,
      direction,
      action: 'retry',
      result: 'success',
      sourceEventId: failure.sourceEventId,
      sourceCalendarId: failure.sourceCalendarId,
      targetEventId: failure.targetEventId,
      targetCalendarId: failure.targetCalendarId,
      eventSummary: failure.eventSummary,
      reasonMessage: 'Manual retry succeeded',
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    await refreshSyncFailureAfterManualAttempt(
      failureId,
      userId,
      String(error?.code || error?.response?.status || ''),
      message
    );
    await recordSyncAudit({
      syncId: failure.syncId,
      userId,
      direction,
      action: 'retry',
      result: 'failure',
      sourceEventId: failure.sourceEventId,
      sourceCalendarId: failure.sourceCalendarId,
      targetEventId: failure.targetEventId,
      targetCalendarId: failure.targetCalendarId,
      eventSummary: failure.eventSummary,
      reasonCode: String(error?.code || error?.response?.status || ''),
      reasonMessage: message,
    });
    throw error;
  }
}

export async function forceResyncFailureEvent(failureId: string, userId: string) {
  const failure = await getFailureOrThrow(failureId, userId);
  const direction = failure.direction as SyncDirection;
  const context = getDirectionContext(failure.sync, direction);

  if (!failure.sourceEventId) {
    throw new Error('Cannot force re-sync without source event ID');
  }

  await incrementFailureRetryCount(failureId, userId);

  try {
    const sourceCalendar = await getAuthenticatedCalendar(userId, context.sourceGoogleAccountId);
    const response = await withRateLimitRetry(
      () =>
        sourceCalendar.events.get({
          calendarId: failure.sourceCalendarId || context.sourceCalendarId,
          eventId: failure.sourceEventId!,
        }),
      `force re-syncing event ${failure.sourceEventId}`
    );

    if (!response.data?.id) {
      throw new Error('Source event could not be loaded for force re-sync');
    }

    await syncEvent(
      failure.syncId,
      userId,
      response.data,
      failure.sourceCalendarId || context.sourceCalendarId,
      failure.targetCalendarId || context.targetCalendarId,
      context.targetGoogleAccountId,
      false,
      context.sourceGoogleAccountId,
      direction
    );

    await resolveSyncFailureById(failureId, userId, 'Recovered manually via force re-sync');
    await recordSyncAudit({
      syncId: failure.syncId,
      userId,
      direction,
      action: 'force_resync',
      result: 'success',
      sourceEventId: failure.sourceEventId,
      sourceCalendarId: failure.sourceCalendarId,
      targetEventId: failure.targetEventId,
      targetCalendarId: failure.targetCalendarId,
      eventSummary: failure.eventSummary,
      reasonMessage: 'Manual force re-sync succeeded',
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    await refreshSyncFailureAfterManualAttempt(
      failureId,
      userId,
      String(error?.code || error?.response?.status || ''),
      message
    );
    await recordSyncAudit({
      syncId: failure.syncId,
      userId,
      direction,
      action: 'force_resync',
      result: 'failure',
      sourceEventId: failure.sourceEventId,
      sourceCalendarId: failure.sourceCalendarId,
      targetEventId: failure.targetEventId,
      targetCalendarId: failure.targetCalendarId,
      eventSummary: failure.eventSummary,
      reasonCode: String(error?.code || error?.response?.status || ''),
      reasonMessage: message,
    });
    throw error;
  }
}

export async function deleteStaleTargetClone(failureId: string, userId: string) {
  const failure = await getFailureOrThrow(failureId, userId);
  const direction = failure.direction as SyncDirection;
  const context = getDirectionContext(failure.sync, direction);

  if (!failure.targetEventId || !failure.targetCalendarId) {
    throw new Error('No target clone is available to delete');
  }

  await incrementFailureRetryCount(failureId, userId);

  try {
    const calendar = await getAuthenticatedCalendar(userId, context.targetGoogleAccountId);
    try {
      await withRateLimitRetry(
        () =>
          calendar.events.delete({
            calendarId: failure.targetCalendarId!,
            eventId: failure.targetEventId!,
          }),
        `deleting stale target clone ${failure.targetEventId}`
      );
    } catch (error: any) {
      const status = error?.code || error?.response?.status;
      if (status !== 404) {
        throw error;
      }
    }

    await resolveSyncFailureById(failureId, userId, 'Stale target clone deleted manually');
    await recordSyncAudit({
      syncId: failure.syncId,
      userId,
      direction,
      action: 'cleanup',
      result: 'success',
      sourceEventId: failure.sourceEventId,
      sourceCalendarId: failure.sourceCalendarId,
      targetEventId: failure.targetEventId,
      targetCalendarId: failure.targetCalendarId,
      eventSummary: failure.eventSummary,
      reasonMessage: 'Manual stale target cleanup succeeded',
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    await refreshSyncFailureAfterManualAttempt(
      failureId,
      userId,
      String(error?.code || error?.response?.status || ''),
      message
    );
    await recordSyncAudit({
      syncId: failure.syncId,
      userId,
      direction,
      action: 'cleanup',
      result: 'failure',
      sourceEventId: failure.sourceEventId,
      sourceCalendarId: failure.sourceCalendarId,
      targetEventId: failure.targetEventId,
      targetCalendarId: failure.targetCalendarId,
      eventSummary: failure.eventSummary,
      reasonCode: String(error?.code || error?.response?.status || ''),
      reasonMessage: message,
    });
    throw error;
  }
}
