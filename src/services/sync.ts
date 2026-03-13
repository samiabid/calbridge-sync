import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { getAuthenticatedCalendar } from './calendar';
import { setupWebhook, stopWebhook } from './webhook';
import { isRateLimitError, sleepMs, withRateLimitRetry } from './rateLimit';
import {
  recordSyncAudit,
  recordSyncFailure,
  resolveSyncFailureByContext,
  type SyncDirection,
} from './syncAudit';

const prisma = new PrismaClient();
const MAX_INVALID_GRANT_FAILURES = 200;
const INITIAL_SYNC_PAST_MONTHS = 2;
const BACKFILL_PER_EVENT_DELAY_MS = 200;
const ALLOWED_RSVP_STATUSES = ['accepted', 'tentative', 'needsAction', 'declined'] as const;
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
        console.error(
          `Disabled sync ${syncId} after ${sync.invalidGrantFailures} invalid_grant failures (${context})`
        );
      }
      return true;
    }

    console.warn(
      `invalid_grant for sync ${syncId} (${sync.invalidGrantFailures}/${MAX_INVALID_GRANT_FAILURES}) (${context})`
    );
    return false;
  } catch (error: any) {
    if (error?.code !== 'P2025') {
      console.error(`Failed to record invalid_grant failure for sync ${syncId}:`, error);
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

function normalizeRsvpStatuses(input: unknown): RsvpStatus[] {
  if (!Array.isArray(input)) return [...ALLOWED_RSVP_STATUSES];

  const valid = input
    .filter((status): status is RsvpStatus =>
      typeof status === 'string' &&
      (ALLOWED_RSVP_STATUSES as readonly string[]).includes(status)
    );

  if (valid.length === 0) {
    return [...ALLOWED_RSVP_STATUSES];
  }

  return [...new Set(valid)];
}

function getEventSelfResponseStatus(event: any): RsvpStatus {
  const selfAttendee = Array.isArray(event?.attendees)
    ? event.attendees.find((attendee: any) => attendee?.self)
    : null;
  const status = selfAttendee?.responseStatus;

  return (ALLOWED_RSVP_STATUSES as readonly string[]).includes(status)
    ? (status as RsvpStatus)
    : 'accepted';
}

function getEventMeetingLink(event: any): string | null {
  if (typeof event?.hangoutLink === 'string' && event.hangoutLink.trim().length > 0) {
    return event.hangoutLink.trim();
  }

  const entryPoint = Array.isArray(event?.conferenceData?.entryPoints)
    ? event.conferenceData.entryPoints.find(
        (entry: any) => typeof entry?.uri === 'string' && entry.uri.trim().length > 0
      )
    : null;

  return entryPoint?.uri?.trim() || null;
}

function getNormalizedEventIdentifier(settings: SyncCopySettings): string | null {
  if (!settings.eventIdentifier) return null;
  const value = settings.eventIdentifier.trim();
  return value.length > 0 ? value : null;
}

function getTargetEventDescription(
  event: any,
  settings: SyncCopySettings,
  includeEventIdentifier: boolean
): string | undefined {
  const parts: string[] = [];

  if (settings.syncEventDescription && typeof event?.description === 'string' && event.description.trim()) {
    parts.push(event.description.trim());
  }

  if (settings.syncMeetingLinks) {
    const meetingLink = getEventMeetingLink(event);
    if (meetingLink) {
      const currentText = parts.join('\n\n');
      if (!currentText.includes(meetingLink)) {
        parts.push(`Meeting Link: ${meetingLink}`);
      }
    }
  }

  const eventIdentifier = getNormalizedEventIdentifier(settings);
  if (includeEventIdentifier && eventIdentifier) {
    parts.push(eventIdentifier);
  }

  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

function buildTargetEventRequestBody(
  syncId: string,
  event: any,
  settings: SyncCopySettings
) {
  const eventIdentifier = getNormalizedEventIdentifier(settings);
  const useIdentifierAsSummary = !settings.syncEventTitles && Boolean(eventIdentifier);
  const summary = settings.syncEventTitles
    ? event.summary
    : eventIdentifier || 'Busy';

  return {
    summary,
    description: getTargetEventDescription(event, settings, !useIdentifierAsSummary),
    start: event.start,
    end: event.end,
    location: settings.syncEventLocation ? event.location : undefined,
    colorId: event.colorId,
    visibility: settings.markEventPrivate ? 'private' : event.visibility,
    reminders: settings.disableRemindersForClones
      ? {
          useDefault: false,
          overrides: [],
        }
      : event.reminders,
    extendedProperties: {
      private: {
        syncId,
        originalEventId: event.id,
      },
    },
  };
}

async function assertCalendarAccess(
  userId: string,
  googleAccountId: string,
  calendarId: string,
  role: 'Source' | 'Target'
) {
  try {
    const calendar = await getAuthenticatedCalendar(userId, googleAccountId);
    await withRateLimitRetry(
      () => calendar.calendars.get({ calendarId }),
      `verifying ${role.toLowerCase()} calendar access`
    );
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
  console.log(`Starting initial backfill in background for sync ${syncId}`);
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
      console.error(`Error performing initial sync for ${syncId}:`, error);
      const message = error instanceof Error ? error.message : String(error);
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
      console.log(`One-way sync ${sync.id}: skipping target webhook setup`);
    }
  } catch (error: any) {
    console.error(`Error setting up webhooks for sync ${sync.id}:`, error);

    // Roll back partially-created syncs so users don't end up with broken setups.
    try {
      await deleteSync(sync.id, userId, false);
    } catch (cleanupError) {
      console.error(`Failed to clean up sync ${sync.id} after webhook setup failure:`, cleanupError);
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
  const rsvpStatuses = normalizeRsvpStatuses(sync.copyRsvpStatuses);

  let pageToken: string | undefined;
  let scannedCount = 0;
  let syncedCount = 0;
  let skippedByWindowCount = 0;
  let skippedByFilterCount = 0;
  let errorCount = 0;

  // Backfill from 2 months ago through all present/future pages.
  // No timeMax is set so setup sync captures upcoming events too.
  do {
    const response = await withRateLimitRetry(
      () =>
        sourceCalendar.events.list({
          calendarId: sync.sourceCalendarId,
          timeMin: historyStart.toISOString(),
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
          targetAccountId
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
    `Initial sync completed for sync ${syncId}: scanned=${scannedCount}, synced=${syncedCount}, skippedWindow=${skippedByWindowCount}, skippedFilters=${skippedByFilterCount}, errors=${errorCount}, mode=${syncStartMode}, historyMonths=${INITIAL_SYNC_PAST_MONTHS}`
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
    copyRsvpStatuses: normalizeRsvpStatuses(syncRecord.copyRsvpStatuses),
    syncFreeEvents: syncRecord.syncFreeEvents,
  };

  console.log(`syncEvent called for sync ${syncId}: targetGoogleAccountId=${targetGoogleAccountId || 'null'}, targetCalendar=${targetCalendarId}`);

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
          // Test if this account has access by trying a simple list operation
          await withRateLimitRetry(
            () => candidateCalendar.calendars.get({ calendarId: targetCalendarId }),
            `detecting writable account for target calendar ${targetCalendarId}`
          );
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

      await prisma.syncedEvent.update({
        where: { id: existingSync.id },
        data: { lastSyncedAt: new Date() },
      });
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
              undefined,
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
        console.error(
          `⚠ Account access issue for sync ${syncId}, will retry account detection`
        );
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
          undefined,
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
        copyRsvpStatuses: [...ALLOWED_RSVP_STATUSES],
        syncFreeEvents: true,
      } as SyncCopySettings);
    const requestBody = buildTargetEventRequestBody(syncId, event, normalizedSettings);

    const response = await withRateLimitRetry(
      () =>
        calendar.events.insert({
          calendarId: targetCalendarId,
          requestBody,
        }),
      `creating synced event for source event ${event.id} on sync ${syncId}`
    );

    await prisma.syncedEvent.create({
      data: {
        syncId,
        sourceEventId: event.id,
        sourceCalendarId,
        targetEventId: response.data.id!,
        targetCalendarId,
      },
    });
    await clearInvalidGrantFailures(syncId);
    await resolveSyncFailureByContext({
      syncId,
      direction,
      action: 'create',
      sourceEventId: event.id,
      targetEventId: response.data.id!,
    });
    await recordSyncAudit({
      syncId,
      userId,
      direction,
      action: 'create',
      result: 'success',
      sourceEventId: event.id,
      sourceCalendarId,
      targetEventId: response.data.id!,
      targetCalendarId,
      eventSummary: event.summary || null,
    });

    console.log(`Created synced event ${event.id} -> ${response.data.id}`);
  } catch (error: any) {
    if (isCredentialOrAccessError(error) && !isSyncMissingError(error)) {
      // Access/auth issue on selected account - clear so future writes can auto-detect
      console.error(
        `⚠ Account access issue when creating event for sync ${syncId}, will retry account detection`
      );
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

function shouldSkipEvent(
  event: any,
  excludedColors: string[],
  excludedKeywords: string[],
  syncFreeEvents: boolean,
  copyRsvpStatuses: string[]
): boolean {
  // Check color filter
  if (event.colorId && excludedColors.includes(event.colorId)) {
    return true;
  }

  // Check keyword filter
  const text = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  for (const keyword of excludedKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      return true;
    }
  }

  // Skip events that were created by sync (to prevent loops)
  if (event.extendedProperties?.private?.syncId) {
    return true;
  }

  // Skip free events when disabled.
  if (!syncFreeEvents && event.transparency === 'transparent') {
    return true;
  }

  const allowedStatuses = normalizeRsvpStatuses(copyRsvpStatuses);
  const responseStatus = getEventSelfResponseStatus(event);
  if (!allowedStatuses.includes(responseStatus)) {
    return true;
  }

  return false;
}
