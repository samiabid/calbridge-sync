import { PrismaClient } from '@prisma/client';
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
  isDetailPlaceholderSummary,
  needsReadableSourceDetails,
  normalizeRsvpStatuses,
  shouldSkipEvent,
} from './syncLogic';
import { buildTargetEventRequestBody } from './syncEventPayload';

const prisma = new PrismaClient();
const MAX_INVALID_GRANT_FAILURES = 200;
const INITIAL_SYNC_PAST_MONTHS = 2;
const BACKFILL_PER_EVENT_DELAY_MS = 200;
type RsvpStatus = (typeof ALLOWED_RSVP_STATUSES)[number];

export type SyncStartMode = 'new_only' | 'past_3mo_recurring';

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
  targetCalendarId: string
) {
  const lockKey = `${syncId}:${sourceCalendarId}:${sourceEventId}`;

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

function startInitialBackfillInBackground(
  syncId: string,
  userId: string,
  sourceAccountId: string,
  targetAccountId: string
) {
  logInfo('initial_backfill_started', {
    syncId,
    sourceAccountId,
    targetAccountId,
  });
  void (async () => {
    try {
      await performInitialSync(
        syncId,
        userId,
        sourceAccountId,
        targetAccountId,
        'past_3mo_recurring'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError('initial_backfill_failed', {
        syncId,
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
    startInitialBackfillInBackground(sync.id, userId, sourceAccountId, targetAccountId);
  } else {
    console.log(`Skipping initial backfill for sync ${sync.id} (new events only mode)`);
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

  const sourceAccountId = sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetAccountId = sync.targetGoogleAccountId || sync.googleAccountId;
  startInitialBackfillInBackground(sync.id, userId, sourceAccountId, targetAccountId);
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
    console.error('Error stopping webhooks:', error);
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

        console.log(`Deleted synced event ${syncedEvent.targetEventId} from target calendar ${sync.targetCalendarId}`);
      } catch (error: any) {
        if (error.code !== 404) {
          console.error(`Error deleting event from target calendar:`, error);
        }
      }
    }

    if (skippedNonDestinationEvents > 0) {
      console.log(
        `Skipped ${skippedNonDestinationEvents} synced mappings outside destination calendar ${sync.targetCalendarId} during deleteSync(${sync.id})`
      );
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
    console.log(`Initial sync skipped for sync ${syncId} (new events only mode)`);
    return;
  }

  const sync = await prisma.sync.findUnique({ where: { id: syncId } });
  if (!sync) throw new Error('Sync not found');

  const sourceAccountId = sourceGoogleAccountId || sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetAccountId = targetGoogleAccountId || sync.targetGoogleAccountId || sync.googleAccountId;

  const sourceCalendar = await getAuthenticatedCalendar(userId, sourceAccountId);
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
  const rsvpStatuses = normalizeRsvpStatuses(sync.copyRsvpStatuses);

  let pageToken: string | undefined;
  let scannedCount = 0;
  let syncedCount = 0;
  let skippedByWindowCount = 0;
  let skippedByFilterCount = 0;
  let errorCount = 0;

  // Backfill from 2 months ago through a bounded future window.
  // Unbounded recurring expansion can produce decades of instances and exhaust Google quota.
  do {
    const response = await withRateLimitRetry(
      () =>
        sourceCalendar.events.list({
          calendarId: sync.sourceCalendarId,
          timeMin: historyStart.toISOString(),
          timeMax: futureWindowEnd.toISOString(),
          maxResults: 250,
          singleEvents: true,
          orderBy: 'startTime',
          pageToken,
        }),
      `listing initial backfill events for sync ${syncId}`
    );

    const events = response.data.items || [];

    for (const event of events) {
      if (!event.id) continue;
      scannedCount += 1;

      if (shouldSkipInitialBackfillEvent(event, now)) {
        skippedByWindowCount += 1;
        continue;
      }

      // Check filters
      if (
        shouldSkipEvent(
          event,
          sync.excludedColors,
          sync.excludedKeywords,
          sync.syncFreeEvents,
          rsvpStatuses
        )
      ) {
        skippedByFilterCount += 1;
        continue;
      }

      try {
        await syncEvent(
          syncId,
          userId,
          event,
          sync.sourceCalendarId,
          sync.targetCalendarId,
          targetAccountId,
          false,
          sourceAccountId
        );
        syncedCount += 1;
        if (BACKFILL_PER_EVENT_DELAY_MS > 0) {
          await sleepMs(BACKFILL_PER_EVENT_DELAY_MS);
        }
      } catch (error) {
        errorCount += 1;
        console.error(`Error syncing event ${event.id}:`, error);
      }
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  console.log(
    `Initial sync completed for sync ${syncId}: scanned=${scannedCount}, synced=${syncedCount}, skippedWindow=${skippedByWindowCount}, skippedFilters=${skippedByFilterCount}, errors=${errorCount}, mode=${syncStartMode}, historyMonths=${INITIAL_SYNC_PAST_MONTHS}, futureDays=${futureWindowDays}`
  );
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

export async function syncEvent(
  syncId: string,
  userId: string,
  event: any,
  sourceCalendarId: string,
  targetCalendarId: string,
  targetGoogleAccountId?: string,
  hasRetriedWithAutoDetection: boolean = false,
  sourceGoogleAccountId?: string,
  direction: SyncDirection = 'source_to_target'
) {
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

  console.log(
    `syncEvent called for sync ${syncId}: sourceGoogleAccountId=${sourceGoogleAccountId || 'null'}, targetGoogleAccountId=${targetGoogleAccountId || 'null'}, targetCalendar=${targetCalendarId}`
  );

  // If targetGoogleAccountId is not provided (old syncs), try to find the account that has access
  // But limit attempts to prevent excessive API calls
  if (!selectedAccountId) {
    const MAX_DETECTION_ATTEMPTS = 3;

    if (syncRecord.accountDetectionAttempts < MAX_DETECTION_ATTEMPTS) {
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
              targetGoogleAccountId: account.id,
              accountDetectionAttempts: 0,
            },
            true
          );

          console.log(`✓ Found working account ${account.displayName} for target calendar ${targetCalendarId}`);
          break;
        } catch (error: any) {
          // This account doesn't have access, try next
          console.log(`✗ Account ${account.displayName} cannot access target calendar: ${error.message}`);
          continue;
        }
      }

      // Increment attempt counter if we didn't find an account
      if (!selectedAccountId) {
        console.log(
          `⚠ No working account found after ${syncRecord.accountDetectionAttempts || 0} attempts for sync ${syncId}`
        );
        await updateSyncIfExists(
          syncId,
          { accountDetectionAttempts: (syncRecord.accountDetectionAttempts || 0) + 1 },
          true
        );
      }
    }

    // If we still don't have a calendar, use primary account
    if (!calendar) {
      console.log(`⚠ Using fallback primary account for sync ${syncId}`);
      calendar = await getAuthenticatedCalendar(userId, undefined);
    }
  } else {
    console.log(`Using pre-configured account ${selectedAccountId} for sync ${syncId}`);
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
    console.warn(
      `Skipping source event ${event.id} for sync ${syncId}: no readable details available after hydration.`
    );
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
    return;
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
    console.log(`Skipping event ${event.id} (${event.summary}) due to sync filters`);
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
    return;
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
        targetCalendarId
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

      console.log(`Updated event ${event.id} in target calendar`);
    } catch (error: any) {
      if (error.code === 404) {
        // Target event was deleted, recreate it
        try {
          await createSyncedEvent(
            syncId,
            userId,
            event,
            sourceCalendarId,
            targetCalendarId,
            selectedAccountId,
            copySettings,
            direction
          );
        } catch (createError: any) {
          if (
            selectedAccountId &&
            !hasRetriedWithAutoDetection &&
            isCredentialOrAccessError(createError) &&
            !isSyncMissingError(createError)
          ) {
            console.warn(
              `Retrying sync ${syncId} with account auto-detection after create failure: ${createError.message}`
            );
            await syncEvent(
              syncId,
              userId,
              event,
              sourceCalendarId,
              targetCalendarId,
              undefined,
              true,
              sourceGoogleAccountId,
              direction
            );
            return;
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
          { targetGoogleAccountId: null, accountDetectionAttempts: 0 },
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
    // Create new synced event
    console.log(`Creating new synced event for source event ${event.id} (${event.summary})`);
    try {
      await createSyncedEvent(
        syncId,
        userId,
        event,
        sourceCalendarId,
        targetCalendarId,
        selectedAccountId,
        copySettings,
        direction
      );
    } catch (error: any) {
      if (
        selectedAccountId &&
        !hasRetriedWithAutoDetection &&
        isCredentialOrAccessError(error) &&
        !isSyncMissingError(error)
      ) {
        console.warn(
          `Retrying sync ${syncId} with account auto-detection after create failure: ${error.message}`
        );
        await syncEvent(
          syncId,
          userId,
          event,
          sourceCalendarId,
          targetCalendarId,
          undefined,
          true,
          sourceGoogleAccountId,
          direction
        );
        return;
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
      console.warn(
        `Source event ${event.id} for sync ${syncId} still has no visible details after hydration. Source account may only have free/busy access.`
      );
    }

    return hydrated;
  } catch (error: any) {
    console.warn(
      `Failed to hydrate source event ${event.id} details for sync ${syncId}: ${error?.message || error}`
    );
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
  console.log(`createSyncedEvent: syncId=${syncId}, targetCalendar=${targetCalendarId}, accountId=${targetGoogleAccountId || 'null'}`);
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
      targetCalendarId
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
        { targetGoogleAccountId: null, accountDetectionAttempts: 0 },
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

  const recurringSeriesIdFromEventId = eventId.includes('_') ? eventId.split('_')[0] : null;
  const recurringSeriesId = options?.recurringEventId || recurringSeriesIdFromEventId;

  if (
    syncedEventsToDelete.length === 0 &&
    options?.isBulkSeriesCancellation &&
    recurringSeriesId
  ) {
    const recurringMatches = await prisma.syncedEvent.findMany({
      where: {
        syncId,
        sourceCalendarId,
        OR: [
          { sourceEventId: recurringSeriesId },
          { sourceEventId: { startsWith: `${recurringSeriesId}_` } },
        ],
      },
    });
    syncedEventsToDelete.push(...recurringMatches);

    if (recurringMatches.length > 0) {
      console.log(
        `Bulk cancellation fallback for series ${recurringSeriesId}: deleting ${recurringMatches.length} mapped events`
      );
    }
  }

  if (syncedEventsToDelete.length === 0) {
    console.log(
      `No synced mapping found for cancelled event ${eventId} on sync ${syncId} (source calendar ${sourceCalendarId})`
    );
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
        console.error(`Error deleting synced event ${eventId}:`, error);
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
      console.log(`Deleted synced event ${syncedEvent.sourceEventId}`);
    }
  }
}
