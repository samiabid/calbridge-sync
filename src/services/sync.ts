import crypto from 'crypto';
import { getAuthenticatedCalendar } from './calendar';
import { setupWebhook, stopWebhook } from './webhook';
import { isRateLimitError, sleepMs, withRateLimitRetry } from './rateLimit';
import { getSyncFutureWindowEnd, normalizeSyncFutureDays } from './syncWindow';
import {
  recordSyncAudit,
  recordSyncFailure,
  resolveSyncFailureByContext,
  type SyncDirection,
} from './syncAudit';
import { sendAlert } from './alerts';
import { logError, logInfo, logWarn } from './logger';
import {
  ALLOWED_RSVP_STATUSES,
  eventHasAnyCopyableDetails,
  getEventSelfResponseStatus,
  getRecurringSeriesIdFromEventId,
  isDetailPlaceholderSummary,
  needsReadableSourceDetails,
  normalizeRsvpStatuses,
  shouldAttemptAccountDetection,
  shouldSkipEvent,
} from './syncLogic';
import { buildTargetEventRequestBody } from './syncEventPayload';
import { prisma } from './prisma';
import {
  buildNativeOccurrenceIndex,
  getCalendarEventOccurrenceIdentity,
  isDuplicateCalendarOccurrence,
} from './calendarEventIdentity';
import {
  buildDestinationAccountUpdate,
  buildBackfillDirectionContexts,
  type BackfillDirectionContext,
} from './backfillLogic';
import { getRecurrenceIdentity } from './recurrenceLogic';

const MAX_INVALID_GRANT_FAILURES = 200;
const INITIAL_SYNC_PAST_MONTHS = 2;
const BACKFILL_PER_EVENT_DELAY_MS = 200;
const BACKFILL_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
type RsvpStatus = (typeof ALLOWED_RSVP_STATUSES)[number];

export type SyncStartMode = 'new_only' | 'past_3mo_recurring';

export interface SyncEventOutcome {
  status: 'synced' | 'skipped' | 'duplicate';
  reasonCode?: string;
  reasonMessage?: string;
  targetEventId?: string;
}

interface SyncEventOptions {
  destinationOccurrenceKeys?: ReadonlySet<string>;
}

export interface BackfillDirectionSummary {
  direction: SyncDirection;
  scanned: number;
  synced: number;
  skipped: number;
  duplicate: number;
  failed: number;
  skippedWindow: number;
  error: string | null;
}

export interface BackfillRunSummary {
  syncId: string;
  status: 'success' | 'partial' | 'failed';
  directions: BackfillDirectionSummary[];
  aggregate: Omit<BackfillDirectionSummary, 'direction' | 'error'>;
}

interface SyncCopySettings {
  syncEventTitles: boolean;
  syncEventDescription: boolean;
  syncEventLocation: boolean;
  syncMeetingLinks: boolean;
  markEventPrivate: boolean;
  disableRemindersForClones: boolean;
  eventIdentifier: string | null;
  cloneColorId: string | null;
  copyRsvpStatuses: string[];
  syncFreeEvents: boolean;
}

interface CreateSyncParams {
  userId: string;
  sourceGoogleAccountId?: string;
  targetGoogleAccountId?: string;
  sourceCalendarId: string;
  sourceCalendarName: string;
  targetCalendarId: string;
  targetCalendarName: string;
  isTwoWay: boolean;
  syncStartMode: SyncStartMode;
  excludedColors: string[];
  excludedKeywords: string[];
  syncEventTitles: boolean;
  syncEventDescription: boolean;
  syncEventLocation: boolean;
  syncMeetingLinks: boolean;
  markEventPrivate: boolean;
  disableRemindersForClones: boolean;
  eventIdentifier: string | null;
  cloneColorId: string | null;
  copyRsvpStatuses: string[];
  syncFreeEvents: boolean;
}

function getErrorCode(error: any): string | null {
  const code = error?.code || error?.status || error?.response?.status;
  return code === undefined || code === null ? null : String(code);
}

function getErrorStatus(error: any): number | undefined {
  const status = error?.code || error?.status || error?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function isInvalidGrantError(error: any): boolean {
  const tokenError = error?.response?.data?.error;
  const message = String(error?.message || '').toLowerCase();
  return tokenError === 'invalid_grant' || message.includes('invalid_grant');
}

function createSyncMissingError(syncId: string): Error & { code: string } {
  const error = new Error(`Sync ${syncId} no longer exists or is inactive`) as Error & {
    code: string;
  };
  error.code = 'SYNC_MISSING';
  return error;
}

function isSyncMissingError(error: any): boolean {
  return error?.code === 'SYNC_MISSING' || error?.code === 'P2025';
}

function isCredentialOrAccessError(error: any): boolean {
  if (isSyncMissingError(error)) return false;
  if (isRateLimitError(error)) return false;
  if (isInvalidGrantError(error)) return true;
  const status = getErrorStatus(error);
  return status === 401 || status === 403 || status === 404;
}

async function updateSyncIfExists(
  syncId: string,
  data: Record<string, any>,
  throwIfMissing: boolean = false
): Promise<boolean> {
  const result = await prisma.sync.updateMany({
    where: { id: syncId },
    data,
  });

  if (result.count === 0 && throwIfMissing) {
    throw createSyncMissingError(syncId);
  }

  return result.count > 0;
}

async function recordInvalidGrantFailure(syncId: string, context: string): Promise<boolean> {
  try {
    const sync = await prisma.sync.update({
      where: { id: syncId },
      data: { invalidGrantFailures: { increment: 1 } },
      select: { id: true, isActive: true, invalidGrantFailures: true },
    });

    const reachedThreshold = sync.invalidGrantFailures >= MAX_INVALID_GRANT_FAILURES;
    if (reachedThreshold) {
      if (sync.isActive) {
        await prisma.sync.update({
          where: { id: syncId },
          data: { isActive: false },
        });
        logError('sync_invalid_grant_threshold_reached', {
          syncId,
          invalidGrantFailures: sync.invalidGrantFailures,
          context,
        });
        await sendAlert({
          severity: 'error',
          key: `invalid_grant_disabled:${syncId}`,
          message: `Sync ${syncId} was disabled after repeated invalid_grant failures.`,
          details: {
            syncId,
            invalidGrantFailures: sync.invalidGrantFailures,
            context,
          },
          cooldownMs: 6 * 60 * 60 * 1000,
        });
      }
      return true;
    }

    logWarn('sync_invalid_grant_recorded', {
      syncId,
      invalidGrantFailures: sync.invalidGrantFailures,
      maxInvalidGrantFailures: MAX_INVALID_GRANT_FAILURES,
      context,
    });
    if (sync.invalidGrantFailures === 1) {
      await sendAlert({
        severity: 'warn',
        key: `invalid_grant_warning:${syncId}`,
        message: `Sync ${syncId} hit an invalid_grant error and may need re-authentication.`,
        details: {
          syncId,
          invalidGrantFailures: sync.invalidGrantFailures,
          context,
        },
        cooldownMs: 6 * 60 * 60 * 1000,
      });
    }
    return false;
  } catch (error: any) {
    if (error?.code !== 'P2025') {
      logError('sync_invalid_grant_record_failed', {
        syncId,
        context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
}

async function clearInvalidGrantFailures(syncId: string) {
  await prisma.sync.updateMany({
    where: { id: syncId, invalidGrantFailures: { gt: 0 } },
    data: { invalidGrantFailures: 0 },
  });
}


function getDeterministicTargetEventId(
  syncId: string,
  sourceCalendarId: string,
  sourceEventId: string,
  targetCalendarId: string
): string {
  // Google Calendar event IDs allow base32hex characters; hex is safely within that alphabet.
  const digest = crypto
    .createHash('sha256')
    .update(`${syncId}:${sourceCalendarId}:${sourceEventId}:${targetCalendarId}`)
    .digest('hex')
    .slice(0, 48);
  return `cs${digest}`;
}

async function replaceSyncedEventMapping(
  syncId: string,
  sourceEventId: string,
  sourceCalendarId: string,
  targetEventId: string,
  targetCalendarId: string,
  sourceEvent?: any
) {
  const lockKey = `${syncId}:${sourceCalendarId}:${sourceEventId}`;
  const recurrence = getRecurrenceIdentity(sourceEvent);

  await prisma.$transaction(async (tx) => {
    // Serialize mapping replacement per source event to avoid duplicate mappings during concurrent webhooks.
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', lockKey);

    const existingMappings = await tx.syncedEvent.findMany({
      where: {
        syncId,
        sourceEventId,
        sourceCalendarId,
      },
      orderBy: [{ lastSyncedAt: 'desc' }, { createdAt: 'desc' }],
    });

    const [primaryMapping, ...staleMappings] = existingMappings;
    if (primaryMapping) {
      await tx.syncedEvent.update({
        where: { id: primaryMapping.id },
        data: {
          targetEventId,
          targetCalendarId,
          sourceRecurringEventId: recurrence.recurringEventId,
          sourceOriginalStart: recurrence.originalStart,
          lastSyncedAt: new Date(),
        },
      });
    } else {
      await tx.syncedEvent.create({
        data: {
          syncId,
          sourceEventId,
          sourceCalendarId,
          targetEventId,
          targetCalendarId,
          sourceRecurringEventId: recurrence.recurringEventId,
          sourceOriginalStart: recurrence.originalStart,
        },
      });
    }

    if (staleMappings.length > 0) {
      await tx.syncedEvent.deleteMany({
        where: {
          id: { in: staleMappings.map((mapping) => mapping.id) },
        },
      });
    }
  });
}

async function assertCalendarAccess(
  userId: string,
  googleAccountId: string,
  calendarId: string,
  role: 'Source' | 'Target'
) {
  try {
    const calendar = await getAuthenticatedCalendar(userId, googleAccountId);
    const listEntry = await withRateLimitRetry(
      () => calendar.calendarList.get({ calendarId }),
      `verifying ${role.toLowerCase()} calendar access`
    );
    const accessRole = listEntry.data.accessRole;

    if (role === 'Source') {
      if (accessRole === 'freeBusyReader') {
        throw new Error(
          'Source calendar is shared as free/busy only for the selected account. Choose an account with full event visibility (Reader/Writer/Owner) to copy titles, descriptions, and meeting links.'
        );
      }
      return;
    }

    if (accessRole !== 'writer' && accessRole !== 'owner') {
      throw new Error(
        'Target calendar must be writable with the selected account. Choose an account with Writer or Owner access.'
      );
    }
  } catch (error: any) {
    if (isInvalidGrantError(error)) {
      throw new Error(
        `${role} account authorization expired. Reconnect this Google account and try again.`
      );
    }

    const status = getErrorStatus(error);
    if (status === 403 || status === 404) {
      throw new Error(`${role} calendar is not accessible with the selected account.`);
    }

    throw error;
  }
}

function createBackfillAlreadyRunningError(): Error & { code: string } {
  const error = new Error('A backfill is already running for this sync.') as Error & { code: string };
  error.code = 'BACKFILL_ALREADY_RUNNING';
  return error;
}

async function acquireBackfillRun(syncId: string, userId: string) {
  const runId = crypto.randomUUID();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - BACKFILL_STALE_AFTER_MS);
  const acquired = await prisma.sync.updateMany({
    where: {
      id: syncId,
      userId,
      isActive: true,
      OR: [
        { backfillStatus: { not: 'running' } },
        { backfillStartedAt: null },
        { backfillStartedAt: { lt: staleBefore } },
      ],
    },
    data: {
      backfillRunId: runId,
      backfillStatus: 'running',
      backfillStartedAt: now,
      backfillCompletedAt: null,
      backfillLastError: null,
    },
  });

  if (acquired.count > 0) return { runId, startedAt: now };

  const sync = await prisma.sync.findFirst({
    where: { id: syncId, userId },
    select: { isActive: true, backfillStatus: true, backfillStartedAt: true },
  });
  if (!sync) throw new Error('Sync not found');
  if (!sync.isActive) throw new Error('Sync is paused. Resume it before re-running backfill.');
  throw createBackfillAlreadyRunningError();
}

async function completeBackfillRun(
  syncId: string,
  runId: string,
  summary: BackfillRunSummary
) {
  const errors = summary.directions
    .map((item) => item.error)
    .filter((item): item is string => Boolean(item));
  await prisma.sync.updateMany({
    where: { id: syncId, backfillRunId: runId },
    data: {
      backfillStatus: summary.status,
      backfillCompletedAt: new Date(),
      backfillLastError: errors.length > 0 ? errors.join(' | ').slice(0, 1000) : null,
    },
  });
}

async function failBackfillRun(syncId: string, runId: string, message: string) {
  await prisma.sync.updateMany({
    where: { id: syncId, backfillRunId: runId },
    data: {
      backfillStatus: 'failed',
      backfillCompletedAt: new Date(),
      backfillLastError: message.slice(0, 1000),
    },
  });
}

async function startInitialBackfillInBackground(
  syncId: string,
  userId: string,
  sourceAccountId: string,
  targetAccountId: string
) {
  const { runId, startedAt } = await acquireBackfillRun(syncId, userId);
  logInfo('initial_backfill_started', {
    syncId,
    runId,
    startedAt: startedAt.toISOString(),
    sourceAccountId,
    targetAccountId,
  });
  void (async () => {
    try {
      const summary = await performInitialSync(
        syncId,
        userId,
        sourceAccountId,
        targetAccountId,
        'past_3mo_recurring'
      );
      await completeBackfillRun(syncId, runId, summary);
      logInfo('initial_backfill_run_completed', {
        syncId,
        runId,
        status: summary.status,
        directions: JSON.stringify(summary.directions),
        aggregate: JSON.stringify(summary.aggregate),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failBackfillRun(syncId, runId, message);
      logError('initial_backfill_failed', {
        syncId,
        runId,
        error: message,
      });
      await sendAlert({
        severity: 'error',
        key: `initial_backfill_failed:${syncId}`,
        message: `Initial backfill failed for sync ${syncId}.`,
        details: {
          syncId,
          error: message,
        },
        cooldownMs: 60 * 60 * 1000,
      });
      await updateSyncIfExists(
        syncId,
        {
          lastSyncStatus: 'error',
          lastSyncError: `Initial sync failed: ${message}`.slice(0, 1000),
        },
        true
      );
    }
  })();

  return { runId, status: 'running' as const, startedAt };
}

export async function createSync(params: CreateSyncParams) {
  const {
    userId,
    sourceGoogleAccountId,
    targetGoogleAccountId,
    sourceCalendarId,
    sourceCalendarName,
    targetCalendarId,
    targetCalendarName,
    isTwoWay,
    syncStartMode,
    excludedColors,
    excludedKeywords,
    syncEventTitles,
    syncEventDescription,
    syncEventLocation,
    syncMeetingLinks,
    markEventPrivate,
    disableRemindersForClones,
    eventIdentifier,
    cloneColorId,
    copyRsvpStatuses,
    syncFreeEvents,
  } = params;

  // Determine which Google accounts to use
  let sourceAccountId = sourceGoogleAccountId;
  let targetAccountId = targetGoogleAccountId || sourceGoogleAccountId;

  if (!sourceAccountId) {
    // Find primary account or first account
    const account = await prisma.googleAccount.findFirst({
      where: { userId },
      orderBy: { isPrimary: 'desc' },
    });
    if (!account) {
      throw new Error('No Google account found. Please connect a Google account first.');
    }
    sourceAccountId = account.id;
    targetAccountId = account.id;
  }

  if (!targetAccountId) {
    targetAccountId = sourceAccountId;
  }

  const allowedAccounts = await prisma.googleAccount.findMany({
    where: {
      userId,
      id: { in: [sourceAccountId, targetAccountId].filter(Boolean) as string[] },
    },
    select: { id: true },
  });
  const allowedAccountIds = new Set(allowedAccounts.map((account) => account.id));

  if (!allowedAccountIds.has(sourceAccountId)) {
    throw new Error('Invalid source Google account');
  }
  if (!allowedAccountIds.has(targetAccountId)) {
    throw new Error('Invalid target Google account');
  }

  if (!sourceCalendarId || !targetCalendarId) {
    throw new Error('Source and target calendars are required');
  }

  if (sourceCalendarId === targetCalendarId && sourceAccountId === targetAccountId) {
    throw new Error('Source and target calendars must be different');
  }

  if (syncStartMode !== 'new_only' && syncStartMode !== 'past_3mo_recurring') {
    throw new Error('Invalid sync start mode');
  }

  const normalizedRsvpStatuses = normalizeRsvpStatuses(copyRsvpStatuses);

  // Verify both calendars are accessible with the selected accounts before creating sync.
  await assertCalendarAccess(userId, sourceAccountId, sourceCalendarId, 'Source');
  await assertCalendarAccess(userId, targetAccountId, targetCalendarId, 'Target');

  const now = new Date();

  // Create sync record
  let sync;
  try {
    sync = await prisma.sync.create({
      data: {
        userId,
        googleAccountId: sourceAccountId,
        sourceGoogleAccountId: sourceAccountId,
        targetGoogleAccountId: targetAccountId,
        sourceCalendarId,
        sourceCalendarName,
        targetCalendarId,
        targetCalendarName,
        isTwoWay,
        excludedColors,
        excludedKeywords,
        syncEventTitles,
        syncEventDescription,
        syncEventLocation,
        syncMeetingLinks,
        markEventPrivate,
        disableRemindersForClones,
        eventIdentifier,
        cloneColorId,
        copyRsvpStatuses: normalizedRsvpStatuses,
        syncFreeEvents,
        lastSyncStatus: 'success',
        lastSyncError: null,
        sourceUpdatedMin: now,
        targetUpdatedMin: now,
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      throw new Error('This sync already exists');
    }
    throw error;
  }

  // Webhook setup is required for a healthy sync.
  try {
    await setupWebhook(sync.id, userId, sourceAccountId, sourceCalendarId, 'source');

    if (isTwoWay) {
      await setupWebhook(sync.id, userId, targetAccountId, targetCalendarId, 'target');
    } else {
      logInfo('sync_target_webhook_skipped_one_way', {
        syncId: sync.id,
      });
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    logError('sync_webhook_setup_failed', {
      syncId: sync.id,
      error: message,
    });
    await sendAlert({
      severity: 'error',
      key: `sync_webhook_setup_failed:${sync.id}`,
      message: `Webhook setup failed for sync ${sync.id}.`,
      details: {
        syncId: sync.id,
        error: message,
      },
      cooldownMs: 60 * 60 * 1000,
    });

    // Roll back partially-created syncs so users don't end up with broken setups.
    try {
      await deleteSync(sync.id, userId, false);
    } catch (cleanupError) {
      logError('sync_webhook_setup_cleanup_failed', {
        syncId: sync.id,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    if (isInvalidGrantError(error)) {
      throw new Error(
        'Google account authorization expired while setting up webhooks. Reconnect your account and try again.'
      );
    }
    throw new Error('Failed to set up calendar webhooks. Sync was not created.');
  }

  // Optional initial sync based on setup choice.
  // Run this in the background so sync creation request can return quickly.
  if (syncStartMode === 'past_3mo_recurring') {
    await startInitialBackfillInBackground(sync.id, userId, sourceAccountId, targetAccountId);
  } else {
    logInfo('initial_backfill_skipped', { syncId: sync.id, reason: 'new_events_only_mode' });
  }

  return sync;
}

export async function getSyncs(userId: string) {
  return prisma.sync.findMany({
    where: { userId },
    include: {
      syncedEvents: {
        take: 5,
        orderBy: { lastSyncedAt: 'desc' },
      },
    },
  });
}

export async function rerunMissedBackfill(syncId: string, userId: string) {
  const sync = await prisma.sync.findFirst({
    where: { id: syncId, userId },
    select: {
      id: true,
      isActive: true,
      sourceGoogleAccountId: true,
      targetGoogleAccountId: true,
      googleAccountId: true,
    },
  });

  if (!sync) {
    throw new Error('Sync not found');
  }

  if (!sync.isActive) {
    throw new Error('Sync is paused. Resume it before re-running backfill.');
  }

  // A manual backfill re-run is an explicit fresh start; let account
  // detection retry too.
  await updateSyncIfExists(sync.id, { accountDetectionAttempts: 0 });

  const sourceAccountId = sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetAccountId = sync.targetGoogleAccountId || sync.googleAccountId;
  return startInitialBackfillInBackground(sync.id, userId, sourceAccountId, targetAccountId);
}

export async function deleteSync(
  syncId: string,
  userId: string,
  deleteSyncedEvents: boolean = false
) {
  const sync = await prisma.sync.findFirst({
    where: { id: syncId, userId },
    include: { syncedEvents: true },
  });

  if (!sync) throw new Error('Sync not found');

  // Stop webhooks
  try {
    if (sync.sourceChannelId) {
      await stopWebhook(
        userId,
        sync.sourceGoogleAccountId || sync.googleAccountId,
        sync.sourceChannelId,
        sync.sourceResourceId!
      );
    }
    if (sync.targetChannelId && sync.isTwoWay) {
      await stopWebhook(
        userId,
        sync.targetGoogleAccountId || sync.googleAccountId,
        sync.targetChannelId,
        sync.targetResourceId!
      );
    }
  } catch (error) {
    logError('webhook_stop_failed', {
      syncId: sync.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Delete synced events from calendar if requested
  if (deleteSyncedEvents) {
    const targetAccountId = sync.targetGoogleAccountId || sync.googleAccountId;
    const targetCalendar = await getAuthenticatedCalendar(userId, targetAccountId);
    const destinationMappedEvents = sync.syncedEvents.filter(
      (syncedEvent) => syncedEvent.targetCalendarId === sync.targetCalendarId
    );
    const skippedNonDestinationEvents = sync.syncedEvents.length - destinationMappedEvents.length;

    // ONLY delete from target calendar - never touch the source calendar
    // The source calendar is read-only in the sync relationship
    for (const syncedEvent of destinationMappedEvents) {
      try {
        await withRateLimitRetry(
          () =>
            targetCalendar.events.delete({
              calendarId: sync.targetCalendarId,
              eventId: syncedEvent.targetEventId,
            }),
          `deleting synced event ${syncedEvent.targetEventId} while removing sync ${sync.id}`
        );

        logInfo('synced_event_deleted', {
          syncId: sync.id,
          targetEventId: syncedEvent.targetEventId,
          targetCalendarId: sync.targetCalendarId,
        });
      } catch (error: any) {
        if (error.code !== 404) {
          logError('synced_event_delete_failed', {
            syncId: sync.id,
            targetEventId: syncedEvent.targetEventId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (skippedNonDestinationEvents > 0) {
      logInfo('delete_sync_skipped_non_destination_mappings', {
        syncId: sync.id,
        targetCalendarId: sync.targetCalendarId,
        skippedCount: skippedNonDestinationEvents,
      });
    }
  }

  // Delete sync and all related synced events from database
  await prisma.sync.delete({ where: { id: syncId } });
}

export async function performInitialSync(
  syncId: string,
  userId: string,
  sourceGoogleAccountId?: string,
  targetGoogleAccountId?: string,
  syncStartMode: SyncStartMode = 'past_3mo_recurring'
) {
  if (syncStartMode === 'new_only') {
    logInfo('initial_sync_skipped', { syncId, reason: 'new_events_only_mode' });
    return {
      syncId,
      status: 'success',
      directions: [],
      aggregate: {
        scanned: 0,
        synced: 0,
        skipped: 0,
        duplicate: 0,
        failed: 0,
        skippedWindow: 0,
      },
    } satisfies BackfillRunSummary;
  }

  const sync = await prisma.sync.findUnique({ where: { id: syncId } });
  if (!sync) throw new Error('Sync not found');

  const directionContexts = buildBackfillDirectionContexts({
    ...sync,
    sourceGoogleAccountId: sourceGoogleAccountId || sync.sourceGoogleAccountId,
    targetGoogleAccountId: targetGoogleAccountId || sync.targetGoogleAccountId,
  });
  await updateSyncIfExists(
    syncId,
    {
      lastSyncStatus: 'success',
      lastSyncError: null,
    },
    true
  );
  const now = new Date();
  const historyStart = new Date(now);
  historyStart.setMonth(historyStart.getMonth() - INITIAL_SYNC_PAST_MONTHS);
  const futureWindowEnd = getSyncFutureWindowEnd(now);
  const futureWindowDays = normalizeSyncFutureDays(process.env.SYNC_FUTURE_DAYS);
  const directions: BackfillDirectionSummary[] = [];

  for (const context of directionContexts) {
    try {
      const summary = await performBackfillDirection(
        syncId,
        userId,
        context,
        now,
        historyStart,
        futureWindowEnd
      );
      directions.push(summary);
      const horizonField =
        context.direction === 'source_to_target'
          ? 'sourceRecurrenceHorizon'
          : 'targetRecurrenceHorizon';
      if (summary.failed === 0) {
        await updateSyncIfExists(syncId, { [horizonField]: futureWindowEnd });
      }
      logInfo('initial_sync_direction_completed', {
        syncId,
        mode: syncStartMode,
        historyMonths: INITIAL_SYNC_PAST_MONTHS,
        futureDays: futureWindowDays,
        ...summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary: BackfillDirectionSummary = {
        direction: context.direction,
        scanned: 0,
        synced: 0,
        skipped: 0,
        duplicate: 0,
        failed: 1,
        skippedWindow: 0,
        error: message,
      };
      directions.push(summary);
      logError('initial_sync_direction_failed', { syncId, ...summary });
    }
  }

  const aggregate = directions.reduce(
    (total, item) => ({
      scanned: total.scanned + item.scanned,
      synced: total.synced + item.synced,
      skipped: total.skipped + item.skipped,
      duplicate: total.duplicate + item.duplicate,
      failed: total.failed + item.failed,
      skippedWindow: total.skippedWindow + item.skippedWindow,
    }),
    { scanned: 0, synced: 0, skipped: 0, duplicate: 0, failed: 0, skippedWindow: 0 }
  );
  const fatallyFailedDirections = directions.filter(
    (item) =>
      item.error &&
      item.scanned === 0 &&
      item.synced === 0 &&
      item.skipped === 0 &&
      item.duplicate === 0
  ).length;
  const status: BackfillRunSummary['status'] =
    fatallyFailedDirections === directions.length
      ? 'failed'
      : fatallyFailedDirections > 0 || aggregate.failed > 0
        ? 'partial'
        : 'success';
  const result: BackfillRunSummary = { syncId, status, directions, aggregate };

  logInfo('initial_sync_completed', {
    syncId,
    status,
    mode: syncStartMode,
    historyMonths: INITIAL_SYNC_PAST_MONTHS,
    futureDays: futureWindowDays,
    directions: JSON.stringify(directions),
    aggregate: JSON.stringify(aggregate),
  });
  return result;
}

async function listEventsForBackfill(
  calendar: Awaited<ReturnType<typeof getAuthenticatedCalendar>>,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  context: string
) {
  const events: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await withRateLimitRetry(
      () =>
        calendar.events.list({
          calendarId,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          maxResults: 250,
          singleEvents: true,
          orderBy: 'startTime',
          showDeleted: false,
          pageToken,
        }),
      context
    );
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return events;
}

async function performBackfillDirection(
  syncId: string,
  userId: string,
  context: BackfillDirectionContext,
  now: Date,
  historyStart: Date,
  futureWindowEnd: Date
): Promise<BackfillDirectionSummary> {
  const [sourceCalendar, targetCalendar] = await Promise.all([
    getAuthenticatedCalendar(userId, context.sourceGoogleAccountId),
    getAuthenticatedCalendar(userId, context.targetGoogleAccountId),
  ]);
  const destinationEvents = await listEventsForBackfill(
    targetCalendar,
    context.targetCalendarId,
    historyStart,
    futureWindowEnd,
    `preloading destination events for ${context.direction} backfill on sync ${syncId}`
  );
  const destinationOccurrenceKeys = buildNativeOccurrenceIndex(destinationEvents);
  const sourceEvents = await listEventsForBackfill(
    sourceCalendar,
    context.sourceCalendarId,
    historyStart,
    futureWindowEnd,
    `listing ${context.direction} backfill events for sync ${syncId}`
  );
  const summary: BackfillDirectionSummary = {
    direction: context.direction,
    scanned: 0,
    synced: 0,
    skipped: 0,
    duplicate: 0,
    failed: 0,
    skippedWindow: 0,
    error: null,
  };

  for (const event of sourceEvents) {
    if (!event.id) continue;
    summary.scanned += 1;
    if (shouldSkipInitialBackfillEvent(event, now)) {
      summary.skippedWindow += 1;
      summary.skipped += 1;
      continue;
    }

    try {
      const outcome = await syncEvent(
        syncId,
        userId,
        event,
        context.sourceCalendarId,
        context.targetCalendarId,
        context.targetGoogleAccountId,
        false,
        context.sourceGoogleAccountId,
        context.direction,
        { destinationOccurrenceKeys }
      );
      summary[outcome.status] += 1;
      if (outcome.status === 'synced' && BACKFILL_PER_EVENT_DELAY_MS > 0) {
        await sleepMs(BACKFILL_PER_EVENT_DELAY_MS);
      }
    } catch (error) {
      summary.failed += 1;
      summary.error = error instanceof Error ? error.message : String(error);
      logError('initial_sync_event_failed', {
        syncId,
        direction: context.direction,
        eventId: event.id,
        error: summary.error,
      });
    }
  }

  return summary;
}

export interface RecurrenceHorizonMaintenanceSummary {
  checkedDirections: number;
  extendedDirections: number;
  failedDirections: number;
}

export async function runRecurrenceHorizonMaintenance(
  now: Date = new Date()
): Promise<RecurrenceHorizonMaintenanceSummary> {
  const threshold = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const nextHorizon = getSyncFutureWindowEnd(now);
  const syncs = await prisma.sync.findMany({
    where: {
      isActive: true,
      OR: [
        { sourceRecurrenceHorizon: { lte: threshold } },
        { isTwoWay: true, targetRecurrenceHorizon: { lte: threshold } },
      ],
    },
  });
  const summary: RecurrenceHorizonMaintenanceSummary = {
    checkedDirections: 0,
    extendedDirections: 0,
    failedDirections: 0,
  };

  for (const sync of syncs) {
    const contexts = buildBackfillDirectionContexts(sync);
    for (const context of contexts) {
      const horizonField =
        context.direction === 'source_to_target'
          ? 'sourceRecurrenceHorizon'
          : 'targetRecurrenceHorizon';
      const currentHorizon = (sync as any)[horizonField] as Date | null;
      if (!currentHorizon || currentHorizon > threshold) continue;

      summary.checkedDirections += 1;
      const overlapStart = new Date(currentHorizon.getTime() - 24 * 60 * 60 * 1000);
      try {
        const directionSummary = await performBackfillDirection(
          sync.id,
          sync.userId,
          context,
          now,
          overlapStart,
          nextHorizon
        );
        if (directionSummary.failed > 0) {
          throw new Error(directionSummary.error || `${directionSummary.failed} event(s) failed`);
        }
        await updateSyncIfExists(sync.id, { [horizonField]: nextHorizon });
        summary.extendedDirections += 1;
        logInfo('recurrence_horizon_extended', {
          syncId: sync.id,
          direction: context.direction,
          previousHorizon: currentHorizon.toISOString(),
          nextHorizon: nextHorizon.toISOString(),
          scanned: directionSummary.scanned,
          synced: directionSummary.synced,
        });
      } catch (error) {
        summary.failedDirections += 1;
        logError('recurrence_horizon_extension_failed', {
          syncId: sync.id,
          direction: context.direction,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return summary;
}

function getEventStartDate(event: any): Date | null {
  const rawStart = event?.start?.dateTime || event?.start?.date;
  if (!rawStart) return null;

  const parsed = new Date(rawStart);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getEventEndDate(event: any): Date | null {
  const rawEnd = event?.end?.dateTime || event?.end?.date;
  if (!rawEnd) return null;

  const parsed = new Date(rawEnd);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecurringEvent(event: any): boolean {
  return Boolean(event?.recurringEventId || (event?.recurrence && event.recurrence.length > 0));
}

function shouldSkipInitialBackfillEvent(event: any, now: Date): boolean {
  const eventStart = getEventStartDate(event);
  if (!eventStart) return false;

  // Keep all present/future events.
  if (eventStart >= now) {
    return false;
  }

  // For past items, only backfill recurring instances.
  if (isRecurringEvent(event)) {
    return false;
  }

  // Keep ongoing events as "present" even when they started before now.
  const eventEnd = getEventEndDate(event);
  if (eventEnd && eventEnd >= now) {
    return false;
  }

  return true;
}

async function hasNativeDestinationDuplicate(
  calendar: Awaited<ReturnType<typeof getAuthenticatedCalendar>>,
  targetCalendarId: string,
  event: any,
  destinationOccurrenceKeys?: ReadonlySet<string>
): Promise<boolean> {
  const identity = getCalendarEventOccurrenceIdentity(event);
  if (!identity) return false;
  if (destinationOccurrenceKeys) {
    return isDuplicateCalendarOccurrence(event, destinationOccurrenceKeys);
  }

  const rawOccurrenceStart =
    event?.originalStartTime?.dateTime ||
    event?.originalStartTime?.date ||
    event?.start?.dateTime ||
    event?.start?.date;
  const occurrenceStart = rawOccurrenceStart ? new Date(rawOccurrenceStart) : null;
  const hasOccurrenceWindow =
    identity.occurrence !== null && occurrenceStart && !Number.isNaN(occurrenceStart.getTime());
  const timeMin = hasOccurrenceWindow
    ? new Date(occurrenceStart.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  const timeMax = hasOccurrenceWindow
    ? new Date(occurrenceStart.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  let pageToken: string | undefined;

  do {
    const response = await withRateLimitRetry(
      () =>
        calendar.events.list({
          calendarId: targetCalendarId,
          iCalUID: identity.iCalUID,
          singleEvents: true,
          showDeleted: false,
          maxResults: 250,
          timeMin,
          timeMax,
          pageToken,
        }),
      `checking destination invite identity for event ${event.id || identity.iCalUID}`
    );
    const nativeKeys = buildNativeOccurrenceIndex(response.data.items || []);
    if (nativeKeys.has(identity.key)) return true;
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return false;
}

export async function syncEvent(
  syncId: string,
  userId: string,
  event: any,
  sourceCalendarId: string,
  targetCalendarId: string,
  targetGoogleAccountId?: string,
  hasRetriedWithAutoDetection: boolean = false,
  sourceGoogleAccountId?: string,
  direction: SyncDirection = 'source_to_target',
  options: SyncEventOptions = {}
): Promise<SyncEventOutcome> {
  let calendar: Awaited<ReturnType<typeof getAuthenticatedCalendar>> | null = null;
  let selectedAccountId = targetGoogleAccountId;
  const syncRecord = await prisma.sync.findUnique({
    where: { id: syncId },
    select: {
      id: true,
      isActive: true,
      accountDetectionAttempts: true,
      excludedColors: true,
      excludedKeywords: true,
      syncEventTitles: true,
      syncEventDescription: true,
      syncEventLocation: true,
      syncMeetingLinks: true,
      markEventPrivate: true,
      disableRemindersForClones: true,
      eventIdentifier: true,
      cloneColorId: true,
      copyRsvpStatuses: true,
      syncFreeEvents: true,
    },
  });

  if (!syncRecord || !syncRecord.isActive) {
    throw createSyncMissingError(syncId);
  }

  const copySettings: SyncCopySettings = {
    syncEventTitles: syncRecord.syncEventTitles,
    syncEventDescription: syncRecord.syncEventDescription,
    syncEventLocation: syncRecord.syncEventLocation,
    syncMeetingLinks: syncRecord.syncMeetingLinks,
    markEventPrivate: syncRecord.markEventPrivate,
    disableRemindersForClones: syncRecord.disableRemindersForClones,
    eventIdentifier: syncRecord.eventIdentifier,
    cloneColorId: syncRecord.cloneColorId,
    copyRsvpStatuses: normalizeRsvpStatuses(syncRecord.copyRsvpStatuses),
    syncFreeEvents: syncRecord.syncFreeEvents,
  };

  logInfo('sync_event_started', {
    syncId,
    sourceGoogleAccountId: sourceGoogleAccountId || null,
    targetGoogleAccountId: targetGoogleAccountId || null,
    targetCalendarId,
  });

  // If targetGoogleAccountId is not provided (old syncs), try to find the account that has access
  // But limit attempts to prevent excessive API calls
  if (!selectedAccountId) {
    const detectionGate = shouldAttemptAccountDetection(
      syncRecord.accountDetectionAttempts,
      (syncRecord as any).lastAccountDetectionAt || null,
      new Date()
    );

    if (detectionGate.attempt) {
      const accounts = await prisma.googleAccount.findMany({
        where: { userId },
        orderBy: { isPrimary: 'desc' }, // Try primary first
      });

      // Try each account until one works
      for (const account of accounts) {
        try {
          const candidateCalendar = await getAuthenticatedCalendar(userId, account.id);
          const listEntry = await withRateLimitRetry(
            () => candidateCalendar.calendarList.get({ calendarId: targetCalendarId }),
            `detecting writable account for target calendar ${targetCalendarId}`
          );
          if (listEntry.data.accessRole !== 'writer' && listEntry.data.accessRole !== 'owner') {
            throw new Error('Account does not have write access to target calendar');
          }
          calendar = candidateCalendar;
          selectedAccountId = account.id;

          // Update the sync with the working account ID for future syncs
          await updateSyncIfExists(
            syncId,
            {
              ...buildDestinationAccountUpdate(direction, account.id),
              accountDetectionAttempts: 0,
              lastAccountDetectionAt: new Date(),
            },
            true
          );

          logInfo('account_detection_succeeded', {
            syncId,
            accountDisplayName: account.displayName,
            targetCalendarId,
          });
          break;
        } catch (error: any) {
          // This account doesn't have access, try next
          logInfo('account_detection_candidate_rejected', {
            syncId,
            accountDisplayName: account.displayName,
            targetCalendarId,
            error: error.message,
          });
          continue;
        }
      }

      // Record the failed attempt. After the cooldown re-opens the gate the
      // counter restarts at 1; otherwise use an atomic increment so
      // concurrent webhook runs don't clobber each other with stale reads.
      if (!selectedAccountId) {
        logWarn('account_detection_failed', {
          syncId,
          attempts: syncRecord.accountDetectionAttempts || 0,
        });
        await updateSyncIfExists(
          syncId,
          detectionGate.isCooldownRetry
            ? { accountDetectionAttempts: 1, lastAccountDetectionAt: new Date() }
            : {
                accountDetectionAttempts: { increment: 1 },
                lastAccountDetectionAt: new Date(),
              },
          true
        );
      }
    }

    // If we still don't have a calendar, use primary account
    if (!calendar) {
      logWarn('account_detection_using_primary_fallback', { syncId });
      calendar = await getAuthenticatedCalendar(userId, undefined);
    }
  } else {
    logInfo('sync_event_using_configured_account', { syncId, accountId: selectedAccountId });
    calendar = await getAuthenticatedCalendar(userId, selectedAccountId);
  }

  if (!calendar) {
    throw new Error(`No writable calendar client available for sync ${syncId}`);
  }

  event = await hydrateSourceEventIfMissingDetails(
    syncId,
    userId,
    event,
    sourceCalendarId,
    sourceGoogleAccountId,
    copySettings
  );

  if (needsReadableSourceDetails(copySettings) && !eventHasAnyCopyableDetails(event)) {
    logWarn('sync_event_skipped_no_readable_details', {
      syncId,
      eventId: event.id,
    });
    await recordSyncAudit({
      syncId,
      userId,
      direction,
      action: 'skip',
      result: 'skipped',
      sourceEventId: event.id,
      sourceCalendarId,
      eventSummary: event.summary || null,
      reasonCode: 'no_readable_details',
      reasonMessage: 'Source event had no readable details after hydration',
    });
    return {
      status: 'skipped',
      reasonCode: 'no_readable_details',
      reasonMessage: 'Source event had no readable details after hydration',
    };
  }

  if (
    shouldSkipEvent(
      event,
      syncRecord.excludedColors,
      syncRecord.excludedKeywords,
      copySettings.syncFreeEvents,
      copySettings.copyRsvpStatuses
    )
  ) {
    logInfo('sync_event_skipped_filtered', {
      syncId,
      eventId: event.id,
      eventSummary: event.summary || null,
    });
    await recordSyncAudit({
      syncId,
      userId,
      direction,
      action: 'skip',
      result: 'skipped',
      sourceEventId: event.id,
      sourceCalendarId,
      eventSummary: event.summary || null,
      reasonCode: 'filtered',
      reasonMessage: 'Event skipped by sync filters',
    });
    return {
      status: 'skipped',
      reasonCode: 'filtered',
      reasonMessage: 'Event skipped by sync filters',
    };
  }

  // Check if event is already synced
  const existingSync = await prisma.syncedEvent.findFirst({
    where: {
      syncId,
      sourceEventId: event.id,
      sourceCalendarId,
    },
    orderBy: [{ lastSyncedAt: 'desc' }, { createdAt: 'desc' }],
  });

  if (existingSync) {
    // Update existing synced event
    try {
      const requestBody = buildTargetEventRequestBody(syncId, event, copySettings);
      await withRateLimitRetry(
        () =>
          calendar.events.update({
            calendarId: targetCalendarId,
            eventId: existingSync.targetEventId,
            requestBody,
          }),
        `updating synced event ${existingSync.targetEventId} for sync ${syncId}`
      );

      await replaceSyncedEventMapping(
        syncId,
        event.id,
        sourceCalendarId,
        existingSync.targetEventId,
        targetCalendarId,
        event
      );
      await clearInvalidGrantFailures(syncId);
      await resolveSyncFailureByContext({
        syncId,
        direction,
        action: 'update',
        sourceEventId: event.id,
        targetEventId: existingSync.targetEventId,
      });
      await recordSyncAudit({
        syncId,
        userId,
        direction,
        action: 'update',
        result: 'success',
        sourceEventId: event.id,
        sourceCalendarId,
        targetEventId: existingSync.targetEventId,
        targetCalendarId,
        eventSummary: event.summary || null,
      });

      logInfo('sync_event_updated', { syncId, eventId: event.id, targetCalendarId });
      return { status: 'synced', targetEventId: existingSync.targetEventId };
    } catch (error: any) {
      if (error.code === 404) {
        // Target event was deleted. Remove the stale mapping first: if the
        // recreate below fails, "no mapping" lets the next run treat this as
        // a fresh create instead of retrying against a dead target event id.
        await prisma.syncedEvent.deleteMany({ where: { id: existingSync.id } });
        try {
          const targetEventId = await createSyncedEvent(
            syncId,
            userId,
            event,
            sourceCalendarId,
            targetCalendarId,
            selectedAccountId,
            copySettings,
            direction
          );
          return { status: 'synced', targetEventId };
        } catch (createError: any) {
          if (
            selectedAccountId &&
            !hasRetriedWithAutoDetection &&
            isCredentialOrAccessError(createError) &&
            !isSyncMissingError(createError)
          ) {
            logWarn('sync_event_retrying_with_auto_detection', {
              syncId,
              eventId: event.id,
              error: createError.message,
            });
            return syncEvent(
              syncId,
              userId,
              event,
              sourceCalendarId,
              targetCalendarId,
              undefined,
              true,
              sourceGoogleAccountId,
              direction,
              options
            );
          }
          await recordSyncFailure({
            syncId,
            userId,
            direction,
            action: 'create',
            sourceEventId: event.id,
            sourceCalendarId,
            targetEventId: existingSync.targetEventId,
            targetCalendarId,
            eventSummary: event.summary || null,
            errorCode: getErrorCode(createError),
            errorMessage: createError instanceof Error ? createError.message : String(createError),
          });
          throw createError;
        }
      } else if (isCredentialOrAccessError(error) && !isSyncMissingError(error)) {
        // Access/auth issue on selected account - clear so future writes can auto-detect
        logError('sync_account_access_issue_existing_event', {
          syncId,
          sourceEventId: event.id,
          targetEventId: existingSync.targetEventId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (isInvalidGrantError(error)) {
          const disabled = await recordInvalidGrantFailure(syncId, 'updating existing event');
          if (disabled) {
            throw new Error(`Sync ${syncId} disabled after repeated invalid_grant failures`);
          }
        }
        await updateSyncIfExists(
          syncId,
          {
            ...buildDestinationAccountUpdate(direction, null),
            accountDetectionAttempts: 0,
          },
          true
        );
        await recordSyncFailure({
          syncId,
          userId,
          direction,
          action: 'update',
          sourceEventId: event.id,
          sourceCalendarId,
          targetEventId: existingSync.targetEventId,
          targetCalendarId,
          eventSummary: event.summary || null,
          errorCode: getErrorCode(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } else {
        await recordSyncFailure({
          syncId,
          userId,
          direction,
          action: 'update',
          sourceEventId: event.id,
          sourceCalendarId,
          targetEventId: existingSync.targetEventId,
          targetCalendarId,
          eventSummary: event.summary || null,
          errorCode: getErrorCode(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  } else {
    if (
      await hasNativeDestinationDuplicate(
        calendar,
        targetCalendarId,
        event,
        options.destinationOccurrenceKeys
      )
    ) {
      logInfo('sync_event_skipped_duplicate_ical_uid', {
        syncId,
        direction,
        eventId: event.id,
        sourceCalendarId,
        targetCalendarId,
      });
      await recordSyncAudit({
        syncId,
        userId,
        direction,
        action: 'skip',
        result: 'skipped',
        sourceEventId: event.id,
        sourceCalendarId,
        targetCalendarId,
        eventSummary: event.summary || null,
        reasonCode: 'duplicate_ical_uid',
        reasonMessage: 'The same native Google invite already exists on the destination calendar',
      });
      return {
        status: 'duplicate',
        reasonCode: 'duplicate_ical_uid',
        reasonMessage: 'The same native Google invite already exists on the destination calendar',
      };
    }

    // Create new synced event
    logInfo('sync_event_creating', {
      syncId,
      eventId: event.id,
      eventSummary: event.summary || null,
    });
    try {
      const targetEventId = await createSyncedEvent(
        syncId,
        userId,
        event,
        sourceCalendarId,
        targetCalendarId,
        selectedAccountId,
        copySettings,
        direction
      );
      return { status: 'synced', targetEventId };
    } catch (error: any) {
      if (
        selectedAccountId &&
        !hasRetriedWithAutoDetection &&
        isCredentialOrAccessError(error) &&
        !isSyncMissingError(error)
      ) {
        logWarn('sync_event_retrying_with_auto_detection', {
          syncId,
          eventId: event.id,
          error: error.message,
        });
        return syncEvent(
          syncId,
          userId,
          event,
          sourceCalendarId,
          targetCalendarId,
          undefined,
          true,
          sourceGoogleAccountId,
          direction,
          options
        );
      }
      await recordSyncFailure({
        syncId,
        userId,
        direction,
        action: 'create',
        sourceEventId: event.id,
        sourceCalendarId,
        targetCalendarId,
        eventSummary: event.summary || null,
        errorCode: getErrorCode(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

async function hydrateSourceEventIfMissingDetails(
  syncId: string,
  userId: string,
  event: any,
  sourceCalendarId: string,
  sourceGoogleAccountId: string | undefined,
  settings: SyncCopySettings
) {
  const needsReadableDetails = needsReadableSourceDetails(settings);

  if (!needsReadableDetails || !event?.id || eventHasAnyCopyableDetails(event)) {
    return event;
  }

  if (!sourceGoogleAccountId) {
    return event;
  }

  try {
    const sourceCalendar = await getAuthenticatedCalendar(userId, sourceGoogleAccountId);
    const fullEvent = await withRateLimitRetry(
      () =>
        sourceCalendar.events.get({
          calendarId: sourceCalendarId,
          eventId: event.id,
        }),
      `hydrating source event details for sync ${syncId}`
    );

    const hydrated = {
      ...event,
      ...fullEvent.data,
    };

    if (!eventHasAnyCopyableDetails(hydrated)) {
      logWarn('sync_event_no_details_after_hydration', {
        syncId,
        eventId: event.id,
      });
    }

    return hydrated;
  } catch (error: any) {
    logWarn('sync_event_hydration_failed', {
      syncId,
      eventId: event.id,
      error: error?.message || String(error),
    });
    return event;
  }
}

async function createSyncedEvent(
  syncId: string,
  userId: string,
  event: any,
  sourceCalendarId: string,
  targetCalendarId: string,
  targetGoogleAccountId?: string,
  settings?: SyncCopySettings,
  direction: SyncDirection = 'source_to_target'
) {
  logInfo('synced_event_create_started', {
    syncId,
    targetCalendarId,
    accountId: targetGoogleAccountId || null,
  });
  const calendar = await getAuthenticatedCalendar(userId, targetGoogleAccountId);

  try {
    const normalizedSettings: SyncCopySettings =
      settings ||
      ({
        syncEventTitles: true,
        syncEventDescription: true,
        syncEventLocation: true,
        syncMeetingLinks: true,
        markEventPrivate: false,
        disableRemindersForClones: false,
        eventIdentifier: null,
        cloneColorId: null,
        copyRsvpStatuses: [...ALLOWED_RSVP_STATUSES],
        syncFreeEvents: true,
      } as SyncCopySettings);
    const targetEventId = getDeterministicTargetEventId(
      syncId,
      sourceCalendarId,
      event.id,
      targetCalendarId
    );
    const requestBody = {
      ...buildTargetEventRequestBody(syncId, event, normalizedSettings),
      id: targetEventId,
    };

    let createdOrUpdatedTargetEventId = targetEventId;
    try {
      const response = await withRateLimitRetry(
        () =>
          calendar.events.insert({
            calendarId: targetCalendarId,
            requestBody,
          }),
        `creating synced event for source event ${event.id} on sync ${syncId}`
      );
      createdOrUpdatedTargetEventId = response.data.id || targetEventId;
    } catch (error: any) {
      if (getErrorStatus(error) !== 409) {
        throw error;
      }

      const updateBody = { ...requestBody };
      delete (updateBody as any).id;
      await withRateLimitRetry(
        () =>
          calendar.events.update({
            calendarId: targetCalendarId,
            eventId: targetEventId,
            requestBody: updateBody,
          }),
        `updating deterministic target event ${targetEventId} after create conflict`
      );
    }

    await replaceSyncedEventMapping(
      syncId,
      event.id,
      sourceCalendarId,
      createdOrUpdatedTargetEventId,
      targetCalendarId,
      event
    );
    await clearInvalidGrantFailures(syncId);
    await resolveSyncFailureByContext({
      syncId,
      direction,
      action: 'create',
      sourceEventId: event.id,
      targetEventId: createdOrUpdatedTargetEventId,
    });
    await recordSyncAudit({
      syncId,
      userId,
      direction,
      action: 'create',
      result: 'success',
      sourceEventId: event.id,
      sourceCalendarId,
      targetEventId: createdOrUpdatedTargetEventId,
      targetCalendarId,
      eventSummary: event.summary || null,
    });

    logInfo('sync_target_event_created', {
      syncId,
      sourceEventId: event.id,
      targetEventId: createdOrUpdatedTargetEventId,
      targetCalendarId,
      accountId: targetGoogleAccountId || null,
    });
    return createdOrUpdatedTargetEventId;
  } catch (error: any) {
    if (isCredentialOrAccessError(error) && !isSyncMissingError(error)) {
      // Access/auth issue on selected account - clear so future writes can auto-detect
      logError('sync_account_access_issue_create_event', {
        syncId,
        sourceEventId: event.id,
        targetCalendarId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (isInvalidGrantError(error)) {
        const disabled = await recordInvalidGrantFailure(syncId, 'creating synced event');
        if (disabled) {
          throw new Error(`Sync ${syncId} disabled after repeated invalid_grant failures`);
        }
      }
      await updateSyncIfExists(
        syncId,
        {
          ...buildDestinationAccountUpdate(direction, null),
          accountDetectionAttempts: 0,
        },
        true
      );
    }
    throw error;
  }
}

export async function handleEventDeletion(
  syncId: string,
  userId: string,
  eventId: string,
  sourceCalendarId: string,
  targetGoogleAccountId?: string,
  options?: {
    recurringEventId?: string;
    isBulkSeriesCancellation?: boolean;
  },
  direction: SyncDirection = 'source_to_target'
) {
  const syncedEventsToDelete = await prisma.syncedEvent.findMany({
    where: {
      syncId,
      sourceEventId: eventId,
      sourceCalendarId,
    },
  });

  const recurringSeriesId =
    options?.recurringEventId || getRecurringSeriesIdFromEventId(eventId) || null;

  // Series-wide deletion must be explicitly authorized by an authoritative
  // recurring-master change. Event-id shape and cancellation counts are not proof.
  const seriesSweepId = options?.isBulkSeriesCancellation ? recurringSeriesId : null;

  if (seriesSweepId) {
    const alreadyMatched = new Set(syncedEventsToDelete.map((mapping) => mapping.id));
    const recurringMatches = (
      await prisma.syncedEvent.findMany({
        where: {
          syncId,
          sourceCalendarId,
          OR: [
            { sourceRecurringEventId: seriesSweepId },
            { sourceEventId: seriesSweepId },
            { sourceEventId: { startsWith: `${seriesSweepId}_` } },
          ],
        },
      })
    ).filter((mapping) => !alreadyMatched.has(mapping.id));
    syncedEventsToDelete.push(...recurringMatches);

    if (recurringMatches.length > 0) {
      logInfo('series_cancellation_sweep', {
        syncId,
        seriesSweepId,
        mappedEventCount: recurringMatches.length,
      });
    }
  }

  if (syncedEventsToDelete.length === 0) {
    logInfo('event_deletion_no_mapping_found', {
      syncId,
      eventId,
      sourceCalendarId,
    });
    await recordSyncAudit({
      syncId,
      userId,
      direction,
      action: 'delete',
      result: 'skipped',
      sourceEventId: eventId,
      sourceCalendarId,
      reasonCode: 'no_mapping',
      reasonMessage: 'No synced mapping found for cancelled event',
    });
    return;
  }

  const calendar = await getAuthenticatedCalendar(userId, targetGoogleAccountId);

  for (const syncedEvent of syncedEventsToDelete) {
    let shouldDeleteMapping = false;
    try {
      await withRateLimitRetry(
        () =>
          calendar.events.delete({
            calendarId: syncedEvent.targetCalendarId,
            eventId: syncedEvent.targetEventId,
          }),
        `deleting synced event ${syncedEvent.targetEventId} during cancellation handling`
      );
      shouldDeleteMapping = true;
    } catch (error: any) {
      const status = getErrorStatus(error);
      if (status === 404) {
        // Event is already gone on target calendar; remove stale mapping.
        shouldDeleteMapping = true;
      } else {
        logError('event_deletion_failed', {
          syncId,
          eventId,
          targetEventId: syncedEvent.targetEventId,
          error: error instanceof Error ? error.message : String(error),
        });
        await recordSyncFailure({
          syncId,
          userId,
          direction,
          action: 'delete',
          sourceEventId: eventId,
          sourceCalendarId,
          targetEventId: syncedEvent.targetEventId,
          targetCalendarId: syncedEvent.targetCalendarId,
          errorCode: getErrorCode(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (shouldDeleteMapping) {
      await prisma.syncedEvent.delete({ where: { id: syncedEvent.id } });
      await resolveSyncFailureByContext({
        syncId,
        direction,
        action: 'delete',
        sourceEventId: eventId,
        targetEventId: syncedEvent.targetEventId,
      });
      await recordSyncAudit({
        syncId,
        userId,
        direction,
        action: 'delete',
        result: 'success',
        sourceEventId: eventId,
        sourceCalendarId,
        targetEventId: syncedEvent.targetEventId,
        targetCalendarId: syncedEvent.targetCalendarId,
      });
      logInfo('event_deletion_completed', { syncId, sourceEventId: syncedEvent.sourceEventId });
    }
  }
}
