import { v4 as uuidv4 } from 'uuid';
import { getAuthenticatedCalendar } from './calendar';
import { syncEvent, handleEventDeletion } from './sync';
import { withRateLimitRetry } from './rateLimit';
import { getPublicBaseUrl } from '../config/runtime';
import { recordSyncFailure, type SyncDirection } from './syncAudit';
import { sendAlert } from './alerts';
import { logError, logInfo, logWarn } from './logger';
import { getSyncFutureWindowEnd, normalizeSyncFutureDays } from './syncWindow';
import { resolveSyncAccounts } from './syncLogic';
import { prisma } from './prisma';
import {
  getMappingOriginalStart,
  getRecurrenceIdentity,
  isOriginalStartInWindow,
  mappingBelongsToSeries,
  shouldExpandChangedEvent,
} from './recurrenceLogic';
import { CoalescingRunner } from './coalescingRunner';

const MAX_INVALID_GRANT_FAILURES = 200;
const WEBHOOK_BOOTSTRAP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Per-sync guard so a watermark gap doesn't stampede reconciliations.
const reconciliationsInFlight = new Set<string>();

// A watermark older than the fetch lookback means changes in the gap window
// were never fetched and will not propagate. The clamp has to stay (Google
// rejects very old updatedMin values); this makes the data loss visible and
// kicks off the existing repair path.
async function reportWatermarkGap(
  sync: { id: string; userId: string },
  direction: SyncDirection,
  staleWatermark: Date,
  minAllowed: Date
) {
  const message =
    `Sync was paused or stalled from ${staleWatermark.toISOString()} to ` +
    `${minAllowed.toISOString()}; changes in that window may not have propagated. ` +
    'Run Reconcile to repair.';

  await recordSyncFailure({
    syncId: sync.id,
    userId: sync.userId,
    direction,
    action: 'update',
    errorCode: 'watermark_gap',
    errorMessage: message,
  }).catch((error) => {
    logError('watermark_gap_failure_record_failed', {
      syncId: sync.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  await sendAlert({
    severity: 'warn',
    key: `webhook_watermark_gap:${sync.id}`,
    message: `Watermark gap detected for sync ${sync.id}; automatic reconciliation started.`,
    details: {
      syncId: sync.id,
      direction,
      gapStart: staleWatermark.toISOString(),
      gapEnd: minAllowed.toISOString(),
    },
    cooldownMs: 24 * 60 * 60 * 1000,
  }).catch(() => {});

  if (!reconciliationsInFlight.has(sync.id)) {
    reconciliationsInFlight.add(sync.id);
    // Deferred import: syncRepair -> sync -> webhook forms a module cycle, so
    // resolve the reconciler at call time the same way sync/webhook already do.
    void import('./syncRepair')
      .then(({ runSyncReconciliation }) => runSyncReconciliation(sync.id, sync.userId))
      .then((summary) => {
        logInfo('watermark_gap_reconciliation_completed', {
          syncId: sync.id,
          summary: typeof summary === 'object' ? JSON.stringify(summary).slice(0, 500) : String(summary),
        });
      })
      .catch((error) => {
        logError('watermark_gap_reconciliation_failed', {
          syncId: sync.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        reconciliationsInFlight.delete(sync.id);
      });
  }
}
function isInvalidGrantError(error: any): boolean {
  const tokenError = error?.response?.data?.error;
  const message = String(error?.message || '').toLowerCase();
  return tokenError === 'invalid_grant' || message.includes('invalid_grant');
}

function isSyncMissingError(error: any): boolean {
  return error?.code === 'SYNC_MISSING' || error?.code === 'P2025';
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
        logError('webhook_invalid_grant_threshold_reached', {
          syncId,
          invalidGrantFailures: sync.invalidGrantFailures,
          context,
        });
        await sendAlert({
          severity: 'error',
          key: `webhook_invalid_grant_disabled:${syncId}`,
          message: `Sync ${syncId} was disabled after repeated invalid_grant failures in webhook processing.`,
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

    logWarn('webhook_invalid_grant_recorded', {
      syncId,
      invalidGrantFailures: sync.invalidGrantFailures,
      maxInvalidGrantFailures: MAX_INVALID_GRANT_FAILURES,
      context,
    });
    if (sync.invalidGrantFailures === 1) {
      await sendAlert({
        severity: 'warn',
        key: `webhook_invalid_grant_warning:${syncId}`,
        message: `Sync ${syncId} hit an invalid_grant error during webhook processing.`,
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
      logError('webhook_invalid_grant_record_failed', {
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
    logWarn('webhook_sync_missing', {
      syncId,
      context,
    });
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
      try {
        const listEntry = await withRateLimitRetry(
          () => calendar.calendarList.get({ calendarId }),
          `checking fallback account visibility for calendar ${calendarId}`
        );
        if (listEntry.data.accessRole === 'freeBusyReader') {
          logWarn('fallback_account_skipped', {
            accountDisplayName: account.displayName,
            calendarId,
            reason: 'free_busy_only_access',
          });
          continue;
        }
      } catch (listError: any) {
        const status = listError?.code || listError?.response?.status;
        if (status === 404) {
          logWarn('fallback_account_skipped', {
            accountDisplayName: account.displayName,
            calendarId,
            reason: 'calendar_list_entry_missing',
          });
          continue;
        }
        throw listError;
      }
      return { accountId: account.id, calendar };
    } catch {
      continue;
    }
  }

  return null;
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

    logInfo('webhook_setup_completed', {
      syncId,
      type,
      calendarId,
      channelId,
    });
    return channelId;
  } catch (error) {
    logError('webhook_setup_failed', {
      syncId,
      type,
      calendarId,
      error: error instanceof Error ? error.message : String(error),
    });
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
    logInfo('webhook_stopped', {
      channelId,
      resourceId,
    });
  } catch (error) {
    logError('webhook_stop_failed', {
      channelId,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

interface WebhookDirectionContext {
  direction: SyncDirection;
  sourceCalendarId: string;
  targetCalendarId: string;
  listAccountId: string;
  writeAccountId: string;
  listAccountField: 'sourceGoogleAccountId' | 'targetGoogleAccountId';
  syncTokenField: 'sourceSyncToken' | 'targetSyncToken';
  updatedMinField: 'sourceUpdatedMin' | 'targetUpdatedMin';
}

interface EventProcessingResult {
  hadError: boolean;
  lastError: string;
  lastDetectedChangeAt: Date | null;
}

const webhookRuns = new CoalescingRunner();

function getDirectionContext(sync: any, direction: SyncDirection): WebhookDirectionContext {
  const isSource = direction === 'source_to_target';
  const { sourceAccountId, targetAccountId } = resolveSyncAccounts(sync);
  return {
    direction,
    sourceCalendarId: isSource ? sync.sourceCalendarId : sync.targetCalendarId,
    targetCalendarId: isSource ? sync.targetCalendarId : sync.sourceCalendarId,
    listAccountId: isSource ? sourceAccountId : targetAccountId,
    writeAccountId: isSource ? targetAccountId : sourceAccountId,
    listAccountField: isSource ? 'sourceGoogleAccountId' : 'targetGoogleAccountId',
    syncTokenField: isSource ? 'sourceSyncToken' : 'targetSyncToken',
    updatedMinField: isSource ? 'sourceUpdatedMin' : 'targetUpdatedMin',
  };
}

function getHttpStatus(error: any): number | undefined {
  const value = error?.code || error?.status || error?.response?.status;
  return typeof value === 'number' ? value : undefined;
}

function collapseEventsById(events: any[]): any[] {
  const byId = new Map<string, any>();
  for (const event of events) {
    if (!event?.id) continue;
    const previous = byId.get(event.id);
    if (!previous || event.status === 'cancelled' || previous.status !== 'cancelled') {
      byId.set(event.id, event);
    }
  }
  return Array.from(byId.values());
}

export async function establishSyncToken(calendar: any, calendarId: string, syncId: string): Promise<string> {
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const response: any = await withRateLimitRetry(
      () =>
        calendar.events.list({
          calendarId,
          maxResults: 2500,
          showDeleted: true,
          singleEvents: false,
          pageToken,
        }),
      `establishing Google sync token for sync ${syncId}`
    );
    pageToken = response.data.nextPageToken || undefined;
    nextSyncToken = response.data.nextSyncToken || nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    throw new Error('Google did not return a sync token after the full calendar baseline');
  }
  return nextSyncToken;
}

export async function listIncrementalChanges(
  calendar: any,
  calendarId: string,
  syncToken: string,
  syncId: string
): Promise<{ events: any[]; nextSyncToken: string }> {
  const events: any[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const response: any = await withRateLimitRetry(
      () =>
        calendar.events.list({
          calendarId,
          syncToken,
          maxResults: 2500,
          showDeleted: true,
          singleEvents: false,
          pageToken,
        }),
      `listing incremental Google changes for sync ${syncId}`
    );
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
    nextSyncToken = response.data.nextSyncToken || nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    throw new Error('Google did not return the next sync token');
  }
  return { events: collapseEventsById(events), nextSyncToken };
}

async function listLegacyBootstrapChanges(
  calendar: any,
  calendarId: string,
  updatedMin: Date,
  futureWindowEnd: Date,
  syncId: string
): Promise<any[]> {
  const events: any[] = [];
  let pageToken: string | undefined;
  do {
    const response: any = await withRateLimitRetry(
      () =>
        calendar.events.list({
          calendarId,
          updatedMin: updatedMin.toISOString(),
          timeMax: futureWindowEnd.toISOString(),
          showDeleted: true,
          maxResults: 250,
          singleEvents: true,
          orderBy: 'updated',
          pageToken,
        }),
      `listing bootstrap changes for sync ${syncId}`
    );
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return collapseEventsById(events);
}

export async function listRecurringInstances(
  calendar: any,
  calendarId: string,
  recurringEventId: string,
  timeMin: Date,
  timeMax: Date,
  syncId: string
): Promise<any[]> {
  const events: any[] = [];
  let pageToken: string | undefined;
  do {
    const response: any = await withRateLimitRetry(
      () =>
        calendar.events.instances({
          calendarId,
          eventId: recurringEventId,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          showDeleted: true,
          maxResults: 2500,
          pageToken,
        }),
      `expanding recurring series ${recurringEventId} for sync ${syncId}`
    );
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return collapseEventsById(events);
}

async function isMappedRecurringSeries(
  syncId: string,
  sourceCalendarId: string,
  recurringEventId: string
): Promise<boolean> {
  const direct = await prisma.syncedEvent.count({
    where: { syncId, sourceCalendarId, sourceRecurringEventId: recurringEventId },
  });
  if (direct > 0) return true;
  const legacy = await prisma.syncedEvent.count({
    where: { syncId, sourceCalendarId, sourceEventId: { startsWith: `${recurringEventId}_` } },
  });
  return legacy > 0;
}

async function processSourceEvent(
  sync: any,
  event: any,
  context: WebhookDirectionContext
) {
  if (!event?.id) return;
  if (event.status === 'cancelled') {
    const identity = getRecurrenceIdentity(event);
    const isSeriesMaster =
      !identity.recurringEventId &&
      (await isMappedRecurringSeries(sync.id, context.sourceCalendarId, event.id));
    await handleEventDeletion(
      sync.id,
      sync.userId,
      event.id,
      context.sourceCalendarId,
      context.writeAccountId,
      identity.recurringEventId
        ? { recurringEventId: identity.recurringEventId, isBulkSeriesCancellation: false }
        : isSeriesMaster
          ? { recurringEventId: event.id, isBulkSeriesCancellation: true }
          : undefined,
      context.direction
    );
    return;
  }

  await syncEvent(
    sync.id,
    sync.userId,
    event,
    context.sourceCalendarId,
    context.targetCalendarId,
    context.writeAccountId,
    false,
    context.listAccountId,
    context.direction
  );
}

async function reconcileSeriesMappings(
  sync: any,
  context: WebhookDirectionContext,
  recurringEventId: string,
  instances: any[],
  timeMin: Date,
  timeMax: Date
) {
  const authoritativeIds = new Set(instances.map((event) => event.id).filter(Boolean));
  const candidates = await prisma.syncedEvent.findMany({
    where: {
      syncId: sync.id,
      sourceCalendarId: context.sourceCalendarId,
      OR: [
        { sourceRecurringEventId: recurringEventId },
        { sourceEventId: { startsWith: `${recurringEventId}_` } },
      ],
    },
  });

  for (const mapping of candidates) {
    if (!mappingBelongsToSeries(mapping, recurringEventId)) continue;
    if (authoritativeIds.has(mapping.sourceEventId)) continue;
    const originalStart = getMappingOriginalStart(mapping);
    if (!isOriginalStartInWindow(originalStart, timeMin, timeMax)) continue;
    await handleEventDeletion(
      sync.id,
      sync.userId,
      mapping.sourceEventId,
      context.sourceCalendarId,
      context.writeAccountId,
      { recurringEventId, isBulkSeriesCancellation: false },
      context.direction
    );
  }
}

async function processChangedEvents(
  sync: any,
  events: any[],
  context: WebhookDirectionContext,
  calendar: any,
  now: Date
): Promise<EventProcessingResult> {
  const result: EventProcessingResult = {
    hadError: false,
    lastError: '',
    lastDetectedChangeAt: null,
  };
  const historyStart = new Date(now);
  historyStart.setMonth(historyStart.getMonth() - 2);
  const futureWindowEnd = getSyncFutureWindowEnd(now);

  for (const event of events) {
    if (event?.updated) {
      const updatedAt = new Date(event.updated);
      if (
        !Number.isNaN(updatedAt.getTime()) &&
        (!result.lastDetectedChangeAt || updatedAt > result.lastDetectedChangeAt)
      ) {
        result.lastDetectedChangeAt = updatedAt;
      }
    }

    try {
      if (shouldExpandChangedEvent(event)) {
        const instances = await listRecurringInstances(
          calendar,
          context.sourceCalendarId,
          event.id,
          historyStart,
          futureWindowEnd,
          sync.id
        );
        for (const instance of instances) {
          await processSourceEvent(sync, instance, context);
        }
        await reconcileSeriesMappings(
          sync,
          context,
          event.id,
          instances,
          historyStart,
          futureWindowEnd
        );
      } else {
        await processSourceEvent(sync, event, context);
      }
    } catch (error) {
      if (isSyncMissingError(error)) throw error;
      result.hadError = true;
      result.lastError = error instanceof Error ? error.message : String(error);
      logError('webhook_event_processing_failed', {
        syncId: sync.id,
        direction: context.direction,
        eventId: event?.id || null,
        error: result.lastError,
      });
    }
  }
  return result;
}

async function processWebhookDirection(syncId: string, direction: SyncDirection) {
  const sync = await prisma.sync.findUnique({ where: { id: syncId } });
  if (!sync || !sync.isActive || (direction === 'target_to_source' && !sync.isTwoWay)) return;

  let context = getDirectionContext(sync, direction);
  let calendar = await getAuthenticatedCalendar(sync.userId, context.listAccountId);
  const processWithCurrentAccount = async () => {
    const now = new Date();
    const futureWindowEnd = getSyncFutureWindowEnd(now);
    let syncToken = (sync as any)[context.syncTokenField] as string | null;
    let bootstrapResult: EventProcessingResult | null = null;

    if (!syncToken) {
      syncToken = await establishSyncToken(calendar, context.sourceCalendarId, sync.id);
      const fallback = new Date(now.getTime() - WEBHOOK_BOOTSTRAP_LOOKBACK_MS);
      const storedUpdatedMin = (sync as any)[context.updatedMinField] as Date | null;
      const effectiveUpdatedMin = storedUpdatedMin && storedUpdatedMin > fallback
        ? storedUpdatedMin
        : fallback;
      if (storedUpdatedMin && storedUpdatedMin < fallback) {
        await reportWatermarkGap(sync, direction, storedUpdatedMin, fallback);
      }
      const bootstrapEvents = await listLegacyBootstrapChanges(
        calendar,
        context.sourceCalendarId,
        effectiveUpdatedMin,
        futureWindowEnd,
        sync.id
      );
      bootstrapResult = await processChangedEvents(sync, bootstrapEvents, context, calendar, now);
      if (bootstrapResult.hadError) {
        throw new Error(bootstrapResult.lastError || 'Bootstrap event processing failed');
      }
    }

    let incremental;
    try {
      incremental = await listIncrementalChanges(
        calendar,
        context.sourceCalendarId,
        syncToken,
        sync.id
      );
    } catch (error) {
      if (getHttpStatus(error) !== 410) throw error;
      logWarn('webhook_sync_token_expired', { syncId: sync.id, direction });
      await updateSyncIfExists(sync.id, { [context.syncTokenField]: null }, 'clearing expired sync token');
      const gapStart = ((sync as any)[context.updatedMinField] as Date | null) ||
        new Date(now.getTime() - WEBHOOK_BOOTSTRAP_LOOKBACK_MS);
      await reportWatermarkGap(sync, direction, gapStart, now);
      syncToken = await establishSyncToken(calendar, context.sourceCalendarId, sync.id);
      incremental = await listIncrementalChanges(
        calendar,
        context.sourceCalendarId,
        syncToken,
        sync.id
      );
    }

    const processed = await processChangedEvents(
      sync,
      incremental.events,
      context,
      calendar,
      now
    );
    if (processed.hadError) {
      throw new Error(processed.lastError || 'Incremental event processing failed');
    }

    const lastDetectedChangeAt =
      processed.lastDetectedChangeAt || bootstrapResult?.lastDetectedChangeAt || null;
    const updatePayload: Record<string, any> = {
      [context.syncTokenField]: incremental.nextSyncToken,
      [context.updatedMinField]: now,
      lastSyncStatus: 'success',
      lastSyncError: null,
    };
    if (lastDetectedChangeAt) updatePayload.lastDetectedChangeAt = lastDetectedChangeAt;
    await updateSyncIfExists(sync.id, updatePayload, 'persisting incremental sync token');
    await clearInvalidGrantFailures(sync.id);
    logInfo('webhook_processing_completed', {
      syncId: sync.id,
      direction,
      changedEvents: incremental.events.length,
      futureWindowDays: normalizeSyncFutureDays(process.env.SYNC_FUTURE_DAYS),
      syncTokenPersisted: true,
    });
  };

  logInfo('webhook_processing_started', {
    syncId: sync.id,
    direction,
    sourceCalendarId: context.sourceCalendarId,
    targetCalendarId: context.targetCalendarId,
  });

  try {
    await processWithCurrentAccount();
  } catch (error) {
    if (isSyncMissingError(error)) return;
    let finalError = error;
    if (isInvalidGrantError(error)) {
      const disabled = await recordInvalidGrantFailure(sync.id, 'incremental calendar sync');
      if (!disabled) {
        const fallback = await findWorkingAccountForCalendar(
          sync.userId,
          context.sourceCalendarId,
          context.listAccountId
        );
        if (fallback) {
          context = { ...context, listAccountId: fallback.accountId };
          calendar = fallback.calendar;
          await updateSyncIfExists(
            sync.id,
            { [context.listAccountField]: fallback.accountId },
            'saving fallback incremental-sync account'
          );
          try {
            await processWithCurrentAccount();
            return;
          } catch (fallbackError) {
            finalError = fallbackError;
          }
        }
      }
    }

    const message = finalError instanceof Error ? finalError.message : String(finalError);
    await updateSyncIfExists(
      sync.id,
      { lastSyncStatus: 'error', lastSyncError: message.slice(0, 1000) },
      'recording incremental webhook failure'
    );
    logError('webhook_processing_failed', { syncId: sync.id, direction, error: message });
    await sendAlert({
      severity: 'error',
      key: `webhook_processing_crashed:${sync.id}:${direction}`,
      message: `Webhook processing crashed for sync ${sync.id}.`,
      details: { syncId: sync.id, direction, error: message },
      cooldownMs: 30 * 60 * 1000,
    });
    throw finalError;
  }
}

async function enqueueWebhookDirection(syncId: string, direction: SyncDirection): Promise<void> {
  const key = `${syncId}:${direction}`;
  return webhookRuns.run(key, () => processWebhookDirection(syncId, direction));
}

export async function runSyncCatchup(syncId: string): Promise<ActiveSyncCatchupSummary> {
  const sync = await prisma.sync.findUnique({
    where: { id: syncId },
    select: { id: true, isActive: true, isTwoWay: true },
  });
  if (!sync || !sync.isActive) {
    throw new Error(`Sync ${syncId} is not active`);
  }

  const directions: SyncDirection[] = ['source_to_target'];
  if (sync.isTwoWay) directions.push('target_to_source');
  const summary: ActiveSyncCatchupSummary = {
    attemptedDirections: 0,
    succeededDirections: 0,
    failedDirections: 0,
  };
  let lastError: unknown;
  for (const direction of directions) {
    summary.attemptedDirections += 1;
    try {
      await enqueueWebhookDirection(sync.id, direction);
      summary.succeededDirections += 1;
    } catch (error) {
      lastError = error;
      summary.failedDirections += 1;
    }
  }
  if (summary.failedDirections > 0) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`${summary.failedDirections} catch-up direction(s) failed`);
  }
  return summary;
}

export interface ActiveSyncCatchupSummary {
  attemptedDirections: number;
  succeededDirections: number;
  failedDirections: number;
}

export async function runActiveSyncCatchup(): Promise<ActiveSyncCatchupSummary> {
  const syncs = await prisma.sync.findMany({
    where: { isActive: true },
    select: { id: true, isTwoWay: true },
  });
  const summary: ActiveSyncCatchupSummary = {
    attemptedDirections: 0,
    succeededDirections: 0,
    failedDirections: 0,
  };
  for (const sync of syncs) {
    const directions: SyncDirection[] = ['source_to_target'];
    if (sync.isTwoWay) directions.push('target_to_source');
    for (const direction of directions) {
      summary.attemptedDirections += 1;
      try {
        await enqueueWebhookDirection(sync.id, direction);
        summary.succeededDirections += 1;
      } catch (error) {
        summary.failedDirections += 1;
        logError('active_sync_catchup_direction_failed', {
          syncId: sync.id,
          direction,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  logInfo('active_sync_catchup_completed', {
    attemptedDirections: summary.attemptedDirections,
    succeededDirections: summary.succeededDirections,
    failedDirections: summary.failedDirections,
  });
  return summary;
}

export function drainWebhookProcessing(timeoutMs: number = 10_000): Promise<boolean> {
  return webhookRuns.drain(timeoutMs);
}

export async function handleWebhookNotification(channelId: string, resourceId: string) {
  const sync = await prisma.sync.findFirst({
    where: {
      isActive: true,
      OR: [
        { sourceChannelId: channelId, sourceResourceId: resourceId },
        { targetChannelId: channelId, targetResourceId: resourceId },
      ],
    },
  });
  if (!sync) {
    logInfo('webhook_notification_ignored', { channelId, resourceId });
    return;
  }
  const direction: SyncDirection =
    sync.sourceChannelId === channelId ? 'source_to_target' : 'target_to_source';
  await enqueueWebhookDirection(sync.id, direction);
}
