import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { getAuthenticatedCalendar } from './calendar';
import { syncEvent, handleEventDeletion } from './sync';
import { withRateLimitRetry } from './rateLimit';
import { getPublicBaseUrl } from '../config/runtime';

const prisma = new PrismaClient();
const MAX_INVALID_GRANT_FAILURES = 200;
const ALLOWED_RSVP_STATUSES = ['accepted', 'tentative', 'needsAction', 'declined'] as const;
type RsvpStatus = (typeof ALLOWED_RSVP_STATUSES)[number];

function isInvalidGrantError(error: any): boolean {
  const tokenError = error?.response?.data?.error;
  const message = String(error?.message || '').toLowerCase();
  return tokenError === 'invalid_grant' || message.includes('invalid_grant');
}

function isSyncMissingError(error: any): boolean {
  return error?.code === 'SYNC_MISSING' || error?.code === 'P2025';
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

async function updateSyncIfExists(
  syncId: string,
  data: Record<string, any>,
  context: string
): Promise<boolean> {
  const result = await prisma.sync.updateMany({
    where: { id: syncId },
    data,
  });

  if (result.count === 0) {
    console.warn(`Sync ${syncId} missing while ${context}; stopping webhook processing`);
    return false;
  }

  return true;
}

async function findWorkingAccountForCalendar(
  userId: string,
  calendarId: string,
  excludeAccountId?: string
) {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    orderBy: { isPrimary: 'desc' },
  });

  for (const account of accounts) {
    if (account.id === excludeAccountId) continue;

    try {
      const calendar = await getAuthenticatedCalendar(userId, account.id);
      await withRateLimitRetry(
        () => calendar.calendars.get({ calendarId }),
        `finding working account for calendar ${calendarId}`
      );
      return { accountId: account.id, calendar };
    } catch {
      continue;
    }
  }

  return null;
}

function getRecurringSeriesId(event: any): string | undefined {
  if (event?.recurringEventId && typeof event.recurringEventId === 'string') {
    return event.recurringEventId;
  }

  if (typeof event?.id !== 'string') return undefined;
  const index = event.id.indexOf('_');
  if (index <= 0) return undefined;

  return event.id.slice(0, index);
}

export async function setupWebhook(
  syncId: string,
  userId: string,
  googleAccountId: string | undefined,
  calendarId: string,
  type: 'source' | 'target'
) {
  const calendar = await getAuthenticatedCalendar(userId, googleAccountId);
  const channelId = uuidv4();
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    throw new Error('PUBLIC_URL (or Railway public domain) is required to register webhook endpoints');
  }
  const webhookUrl = `${baseUrl}/webhook/google`;
  const webhookToken = process.env.GOOGLE_WEBHOOK_TOKEN;

  try {
    const response = await calendar.events.watch({
      calendarId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        ...(webhookToken ? { token: webhookToken } : {}),
      },
    });

    const expiration = new Date(parseInt(response.data.expiration!));

    // Update sync with webhook info
    const updateData = type === 'source' 
      ? {
          sourceChannelId: channelId,
          sourceResourceId: response.data.resourceId!,
          sourceExpiration: expiration,
        }
      : {
          targetChannelId: channelId,
          targetResourceId: response.data.resourceId!,
          targetExpiration: expiration,
        };

    await prisma.sync.update({
      where: { id: syncId },
      data: updateData,
    });

    console.log(`Webhook setup for ${type} calendar ${calendarId}`);
    return channelId;
  } catch (error) {
    console.error(`Error setting up webhook for ${type}:`, error);
    throw error;
  }
}

export async function stopWebhook(
  userId: string,
  googleAccountId: string | undefined,
  channelId: string,
  resourceId: string
) {
  try {
    const calendar = await getAuthenticatedCalendar(userId, googleAccountId);
    await calendar.channels.stop({
      requestBody: {
        id: channelId,
        resourceId,
      },
    });
    console.log(`Stopped webhook ${channelId}`);
  } catch (error) {
    console.error('Error stopping webhook:', error);
    throw error;
  }
}

export async function handleWebhookNotification(channelId: string, resourceId: string) {
  // Find sync by channel + resource pairing to avoid spoofed notifications.
  const sync = await prisma.sync.findFirst({
    where: {
      OR: [
        { sourceChannelId: channelId, sourceResourceId: resourceId },
        { targetChannelId: channelId, targetResourceId: resourceId },
      ],
    },
  });

  if (!sync || !sync.isActive) {
    console.log('Sync not found, inactive, or channel/resource mismatch');
    return;
  }

  const isSourceCalendar = sync.sourceChannelId === channelId;
  const sourceCalendarId = isSourceCalendar ? sync.sourceCalendarId : sync.targetCalendarId;
  const targetCalendarId = isSourceCalendar ? sync.targetCalendarId : sync.sourceCalendarId;
  const sourceAccountId = sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetAccountId = sync.targetGoogleAccountId || sync.googleAccountId;
  let listAccountId = isSourceCalendar ? sourceAccountId : targetAccountId;
  const writeAccountId = isSourceCalendar ? targetAccountId : sourceAccountId;
  const updatedMinField = isSourceCalendar ? 'sourceUpdatedMin' : 'targetUpdatedMin';
  const listAccountField = isSourceCalendar ? 'sourceGoogleAccountId' : 'targetGoogleAccountId';

  console.log(`Processing webhook for sync ${sync.id}, source: ${sourceCalendarId}`);

  let calendar = await getAuthenticatedCalendar(sync.userId, listAccountId);

  try {
    let hadInvalidGrant = false;

    // Use updatedMin to catch updates regardless of event start time.
    const maxLookbackMs = 7 * 24 * 60 * 60 * 1000;
    const fallbackUpdatedMin = new Date(Date.now() - maxLookbackMs);
    const updatedMinValue = (sync as any)[updatedMinField];
    const updatedMin = updatedMinValue ? new Date(updatedMinValue) : fallbackUpdatedMin;
    const minAllowed = new Date(Date.now() - maxLookbackMs);
    const effectiveUpdatedMin = updatedMin < minAllowed ? minAllowed : updatedMin;

    if (effectiveUpdatedMin !== updatedMin) {
      const updated = await updateSyncIfExists(
        sync.id,
        { [updatedMinField]: effectiveUpdatedMin } as any,
        'clamping updatedMin'
      );
      if (!updated) return;
    }

    console.log(
      `Fetching updates from calendar ${sourceCalendarId} since ${effectiveUpdatedMin.toISOString()}`
    );

    const events: any[] = [];
    let pageToken: string | undefined;

    const listEvents = async (minDate: Date, token?: string) => {
      return withRateLimitRetry(
        () =>
          calendar.events.list({
            calendarId: sourceCalendarId,
            updatedMin: minDate.toISOString(),
            showDeleted: true,
            maxResults: 250,
            singleEvents: true,
            orderBy: 'updated',
            pageToken: token,
          }),
        `listing webhook updates for sync ${sync.id}`
      );
    };

    try {
      do {
        const response = await listEvents(effectiveUpdatedMin, pageToken);
        events.push(...(response.data.items || []));
        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);
    } catch (error: any) {
      if (error?.code === 410 || error?.response?.status === 410) {
        console.warn('updatedMin too old; resetting to fallback window and retrying');
        const fallback = new Date(Date.now() - maxLookbackMs);
        pageToken = undefined;
        events.length = 0;
        do {
          const response = await listEvents(fallback, pageToken);
          events.push(...(response.data.items || []));
          pageToken = response.data.nextPageToken || undefined;
        } while (pageToken);
        const updated = await updateSyncIfExists(
          sync.id,
          { [updatedMinField]: fallback } as any,
          'resetting updatedMin after 410'
        );
        if (!updated) return;
      } else if (isInvalidGrantError(error)) {
        hadInvalidGrant = true;
        const disabled = await recordInvalidGrantFailure(sync.id, 'listing source calendar updates');
        if (disabled) {
          await updateSyncIfExists(
            sync.id,
            {
              lastSyncStatus: 'error',
              lastSyncError:
                'Sync disabled after repeated invalid_grant failures while listing calendar updates.',
            },
            'marking sync as disabled after invalid_grant'
          );
          return;
        }

        console.warn(
          `Account token expired for sync ${sync.id} (${listAccountId}); trying fallback account for ${sourceCalendarId}`
        );

        const fallback = await findWorkingAccountForCalendar(
          sync.userId,
          sourceCalendarId,
          listAccountId
        );

        if (!fallback) {
          console.error(
            `No fallback account available for sync ${sync.id}; account re-auth is required`
          );
          throw error;
        }

        listAccountId = fallback.accountId;
        calendar = fallback.calendar;

        const updated = await updateSyncIfExists(
          sync.id,
          { [listAccountField]: fallback.accountId } as any,
          'saving fallback list account'
        );
        if (!updated) return;

        pageToken = undefined;
        events.length = 0;
        do {
          const response = await listEvents(effectiveUpdatedMin, pageToken);
          events.push(...(response.data.items || []));
          pageToken = response.data.nextPageToken || undefined;
        } while (pageToken);
      } else {
        throw error;
      }
    }

    const cancelledSeriesCounts = new Map<string, number>();
    let hadProcessingError = false;
    let lastProcessingError = '';
    let lastDetectedChangeAt: Date | null = null;

    for (const event of events) {
      if (event?.updated) {
        const updatedAt = new Date(event.updated);
        if (!Number.isNaN(updatedAt.getTime()) && (!lastDetectedChangeAt || updatedAt > lastDetectedChangeAt)) {
          lastDetectedChangeAt = updatedAt;
        }
      }

      if (event?.status !== 'cancelled' || !event?.id) continue;
      const recurringSeriesId = getRecurringSeriesId(event);
      if (!recurringSeriesId) continue;
      cancelledSeriesCounts.set(
        recurringSeriesId,
        (cancelledSeriesCounts.get(recurringSeriesId) || 0) + 1
      );
    }

    for (const event of events) {
      if (!event.id) continue;

      try {
        // Handle deletions before filters.
        // Filters should only apply to active events, not cancel/delete propagation.
        if (event.status === 'cancelled') {
          console.log(`Handling deletion for cancelled event ${event.id}`);
          const recurringSeriesId = getRecurringSeriesId(event);
          const isBulkSeriesCancellation = Boolean(
            recurringSeriesId &&
              (cancelledSeriesCounts.get(recurringSeriesId) || 0) > 1
          );
          await handleEventDeletion(
            sync.id,
            sync.userId,
            event.id,
            sourceCalendarId,
            writeAccountId,
            {
              recurringEventId: recurringSeriesId,
              isBulkSeriesCancellation,
            }
          );
          continue;
        }

        // Skip if active event should be filtered
        if (
          shouldSkipEvent(
            event,
            sync.excludedColors,
            sync.excludedKeywords,
            sync.syncFreeEvents,
            normalizeRsvpStatuses(sync.copyRsvpStatuses)
          )
        ) {
          console.log(`Skipping event ${event.id} (${event.summary}) - filtered out`);
          continue;
        }

        // Sync or update event
        console.log(`Processing event ${event.id} (${event.summary})`);
        await syncEvent(
          sync.id,
          sync.userId,
          event,
          sourceCalendarId,
          targetCalendarId,
          writeAccountId
        );
      } catch (eventError) {
        if (isSyncMissingError(eventError)) {
          console.warn(`Sync ${sync.id} removed during event processing; stopping webhook run`);
          return;
        }
        if (isInvalidGrantError(eventError)) {
          hadInvalidGrant = true;
        }
        hadProcessingError = true;
        lastProcessingError = eventError instanceof Error ? eventError.message : String(eventError);
        console.error(`Error handling event ${event.id} for sync ${sync.id}:`, eventError);
      }
    }

    if (!hadInvalidGrant) {
      await clearInvalidGrantFailures(sync.id);
    }

    const updatePayload: Record<string, any> = {
      [updatedMinField]: new Date(),
      lastSyncStatus: hadProcessingError ? 'error' : 'success',
      lastSyncError: hadProcessingError ? lastProcessingError.slice(0, 1000) : null,
    };
    if (lastDetectedChangeAt) {
      updatePayload.lastDetectedChangeAt = lastDetectedChangeAt;
    }

    const updated = await updateSyncIfExists(sync.id, updatePayload, 'finalizing updatedMin/status');
    if (!updated) return;

    console.log(`Webhook processing completed for sync ${sync.id}`);
  } catch (error: any) {
    if (isSyncMissingError(error)) {
      console.warn(`Sync ${sync.id} removed during webhook execution; exiting`);
      return;
    }
    await updateSyncIfExists(
      sync.id,
      {
        lastSyncStatus: 'error',
        lastSyncError: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      },
      'recording webhook failure'
    );
    console.error('Error processing webhook notification:', error);
  }
}

function shouldSkipEvent(
  event: any,
  excludedColors: string[],
  excludedKeywords: string[],
  syncFreeEvents: boolean,
  copyRsvpStatuses: string[]
): boolean {
  if (event.colorId && excludedColors.includes(event.colorId)) {
    return true;
  }

  const text = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  for (const keyword of excludedKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      return true;
    }
  }

  if (event.extendedProperties?.private?.syncId) {
    return true;
  }

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
