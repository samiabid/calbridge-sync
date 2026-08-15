import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getCalendarList, getAuthenticatedCalendar } from '../services/calendar';
import {
  createSync,
  deleteSync,
  getSyncs,
  rerunMissedBackfill,
  setSyncActiveStatus,
  type SyncStartMode,
} from '../services/sync';
import {
  deleteStaleTargetClone,
  forceResyncFailureEvent,
  retrySyncFailure,
} from '../services/syncRecovery';
import { resolveSyncFailureById } from '../services/syncAudit';
import {
  cleanupSyncOrphanClone,
  runSyncReconciliation,
  scanSyncOrphanClones,
} from '../services/syncRepair';
import { getProductionDiagnostics } from '../services/productionDiagnostics';
import { ALLOWED_RSVP_STATUSES } from '../services/syncLogic';
import { GOOGLE_EVENT_COLOR_IDS, normalizeGoogleEventColorId } from '../services/eventColors';
import { buildSyncEventsRouter } from './syncEvents';
import { prisma } from '../services/prisma';
import { logError, logInfo } from '../services/logger';

const router = Router();

router.use('/', buildSyncEventsRouter());

const MAX_EXCLUDED_KEYWORDS = 50;
const MAX_KEYWORD_LENGTH = 100;
const MAX_EVENT_IDENTIFIER_LENGTH = 64;

function sanitizeExcludedKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((keyword): keyword is string => typeof keyword === 'string')
    .map((keyword) => keyword.trim().slice(0, MAX_KEYWORD_LENGTH))
    .filter((keyword) => keyword.length > 0)
    .slice(0, MAX_EXCLUDED_KEYWORDS);
}

function sanitizeExcludedColors(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input.filter(
        (color): color is string => typeof color === 'string' && GOOGLE_EVENT_COLOR_IDS.has(color)
      )
    ),
  ];
}

function sanitizeEventIdentifier(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, MAX_EVENT_IDENTIFIER_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeRsvpStatuses(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input.filter(
        (status): status is string =>
          typeof status === 'string' &&
          (ALLOWED_RSVP_STATUSES as readonly string[]).includes(status)
      )
    ),
  ];
}

function getAccountStatusReason(error: unknown): string {
  const err = error as any;
  const rawMessage =
    err?.response?.data?.error_description ||
    err?.response?.data?.error?.message ||
    err?.message ||
    'Authorization failed';
  const message = String(rawMessage);
  const normalized = message.toLowerCase();

  if (normalized.includes('invalid_grant')) {
    return 'Refresh token expired or revoked';
  }
  if (normalized.includes('invalid credentials')) {
    return 'Access token is no longer valid';
  }
  if (normalized.includes('insufficient')) {
    return 'Missing required Google permissions';
  }

  return message;
}

// Get all syncs for user
router.get('/', requireAuth, async (req, res) => {
  try {
    const syncs = await getSyncs(req.session.userId!);
    res.json(syncs);
  } catch (error) {
    logError('syncs_fetch_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch syncs' });
  }
});

router.get('/diagnostics', requireAuth, async (req, res) => {
  try {
    const result = await getProductionDiagnostics(req.session.userId!);
    res.json(result);
  } catch (error: any) {
    const message = error?.message || 'Failed to load diagnostics';
    res.status(500).json({ error: message });
  }
});

router.post('/failures/:failureId/retry', requireAuth, async (req, res) => {
  try {
    await retrySyncFailure(req.params.failureId, req.session.userId!);
    res.json({ success: true });
  } catch (error: any) {
    const message = error?.message || 'Failed to retry event';
    res.status(400).json({ error: message });
  }
});

router.post('/failures/:failureId/force-resync', requireAuth, async (req, res) => {
  try {
    await forceResyncFailureEvent(req.params.failureId, req.session.userId!);
    res.json({ success: true });
  } catch (error: any) {
    const message = error?.message || 'Failed to force re-sync event';
    res.status(400).json({ error: message });
  }
});

router.post('/failures/:failureId/delete-stale-target', requireAuth, async (req, res) => {
  try {
    await deleteStaleTargetClone(req.params.failureId, req.session.userId!);
    res.json({ success: true });
  } catch (error: any) {
    const message = error?.message || 'Failed to delete stale target clone';
    res.status(400).json({ error: message });
  }
});

router.post('/failures/:failureId/resolve', requireAuth, async (req, res) => {
  try {
    const note =
      typeof req.body?.resolutionNote === 'string' ? req.body.resolutionNote.trim() : null;
    const result = await resolveSyncFailureById(req.params.failureId, req.session.userId!, note);
    if (result.count === 0) {
      return res.status(404).json({ error: 'Failed event not found' });
    }
    res.json({ success: true });
  } catch (error: any) {
    const message = error?.message || 'Failed to resolve event';
    res.status(400).json({ error: message });
  }
});

router.post('/:id/reconcile', requireAuth, async (req, res) => {
  try {
    const result = await runSyncReconciliation(req.params.id, req.session.userId!, {
      daysBack: req.body?.daysBack,
      daysForward: req.body?.daysForward,
    });
    res.json(result);
  } catch (error: any) {
    const message = error?.message || 'Failed to run reconciliation';
    res.status(error?.code === 'OPERATION_LEASE_BUSY' ? 409 : 400).json({ error: message });
  }
});

router.get('/:id/orphans', requireAuth, async (req, res) => {
  try {
    const result = await scanSyncOrphanClones(req.params.id, req.session.userId!, {
      daysBack: req.query?.daysBack,
      daysForward: req.query?.daysForward,
    });
    res.json(result);
  } catch (error: any) {
    const message = error?.message || 'Failed to scan orphan clones';
    res.status(400).json({ error: message });
  }
});

router.post('/:id/orphans/cleanup', requireAuth, async (req, res) => {
  try {
    await cleanupSyncOrphanClone(req.params.id, req.session.userId!, {
      direction: req.body?.direction,
      targetEventId: req.body?.targetEventId,
      targetCalendarId: req.body?.targetCalendarId,
      sourceEventId: req.body?.sourceEventId,
      eventSummary: req.body?.eventSummary,
    });
    res.json({ success: true });
  } catch (error: any) {
    const message = error?.message || 'Failed to clean orphan clone';
    res.status(400).json({ error: message });
  }
});

// Get user's Google accounts
router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await prisma.googleAccount.findMany({
      where: { userId: req.session.userId! },
      select: { id: true, displayName: true, isPrimary: true, createdAt: true },
    });

    const accountsWithStatus = await Promise.all(
      accounts.map(async (account) => {
        try {
          const calendar = await getAuthenticatedCalendar(req.session.userId!, account.id);
          await calendar.calendarList.list({ maxResults: 1 });
          return {
            ...account,
            connectionStatus: 'connected' as const,
            statusReason: null,
          };
        } catch (error) {
          return {
            ...account,
            connectionStatus: 'disconnected' as const,
            statusReason: getAccountStatusReason(error),
          };
        }
      })
    );

    res.json(accountsWithStatus);
  } catch (error) {
    logError('accounts_fetch_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Delete a Google account
router.delete('/accounts/:id', requireAuth, async (req, res) => {
  try {
    const account = await prisma.googleAccount.findUnique({
      where: { id: req.params.id },
    });

    if (!account || account.userId !== req.session.userId!) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (account.isPrimary) {
      return res.status(400).json({ error: 'Cannot delete primary account' });
    }

    // Delete syncs using this account in any role with full cleanup (stop webhooks, remove sync metadata).
    const syncsUsingAccount = await prisma.sync.findMany({
      where: {
        userId: req.session.userId!,
        OR: [
          { googleAccountId: req.params.id },
          { sourceGoogleAccountId: req.params.id },
          { targetGoogleAccountId: req.params.id },
        ],
      },
      select: { id: true },
    });

    for (const sync of syncsUsingAccount) {
      await deleteSync(sync.id, req.session.userId!, false);
    }

    await prisma.googleAccount.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    logError('account_delete_failed', {
      accountId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Get user's calendars
router.get('/calendars', requireAuth, async (req, res) => {
  try {
    const calendars = await getCalendarList(req.session.userId!);
    res.json(calendars);
  } catch (error) {
    logError('calendars_fetch_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

// Create new sync
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      sourceCalendarId,
      sourceCalendarName,
      targetCalendarId,
      targetCalendarName,
      googleAccountId,
      targetGoogleAccountId,
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
    } = req.body;

    if (!sourceCalendarId || !targetCalendarId) {
      return res.status(400).json({ error: 'Source and target calendars are required' });
    }

    const resolvedSyncStartMode: SyncStartMode =
      syncStartMode === 'past_3mo_recurring' ? 'past_3mo_recurring' : 'new_only';

    const sync = await createSync({
      userId: req.session.userId!,
      sourceGoogleAccountId: googleAccountId,
      targetGoogleAccountId,
      sourceCalendarId,
      sourceCalendarName,
      targetCalendarId,
      targetCalendarName,
      isTwoWay: typeof isTwoWay === 'boolean' ? isTwoWay : true,
      syncStartMode: resolvedSyncStartMode,
      excludedColors: sanitizeExcludedColors(excludedColors),
      excludedKeywords: sanitizeExcludedKeywords(excludedKeywords),
      syncEventTitles: typeof syncEventTitles === 'boolean' ? syncEventTitles : true,
      syncEventDescription: typeof syncEventDescription === 'boolean' ? syncEventDescription : true,
      syncEventLocation: typeof syncEventLocation === 'boolean' ? syncEventLocation : true,
      syncMeetingLinks: typeof syncMeetingLinks === 'boolean' ? syncMeetingLinks : true,
      markEventPrivate: typeof markEventPrivate === 'boolean' ? markEventPrivate : false,
      disableRemindersForClones:
        typeof disableRemindersForClones === 'boolean' ? disableRemindersForClones : false,
      eventIdentifier: sanitizeEventIdentifier(eventIdentifier),
      cloneColorId: normalizeGoogleEventColorId(cloneColorId),
      copyRsvpStatuses: sanitizeRsvpStatuses(copyRsvpStatuses),
      syncFreeEvents: typeof syncFreeEvents === 'boolean' ? syncFreeEvents : true,
    });

    res.json(sync);
  } catch (error: any) {
    logError('sync_create_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error?.message || 'Failed to create sync';
    const normalizedMessage = String(message).toLowerCase();
    const status =
      normalizedMessage.includes('required') ||
      normalizedMessage.includes('invalid') ||
      normalizedMessage.includes('already exists') ||
      normalizedMessage.includes('must be different') ||
      normalizedMessage.includes('authorization expired') ||
      normalizedMessage.includes('accessible')
        ? 400
        : 500;
    res.status(status).json({ error: message });
  }
});

// Delete sync
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { deleteEvents } = req.body;
    await deleteSync(req.params.id, req.session.userId!, deleteEvents || false);
    res.json({ success: true });
  } catch (error) {
    logError('sync_delete_failed', {
      syncId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to delete sync' });
  }
});

// Re-run initial backfill in the background for an existing sync.
router.post('/:id/rerun-backfill', requireAuth, async (req, res) => {
  try {
    const run = await rerunMissedBackfill(req.params.id, req.session.userId!);
    res.json({ success: true, message: 'Backfill queued', run });
  } catch (error: any) {
    const message = error?.message || 'Failed to start backfill';
    const status =
      error?.code === 'BACKFILL_ALREADY_RUNNING'
        ? 409
        : message.toLowerCase().includes('not found') || message.toLowerCase().includes('paused')
          ? 400
          : 500;
    res.status(status).json({ error: message });
  }
});

// Toggle sync active status
router.patch('/:id/toggle', requireAuth, async (req, res) => {
  try {
    if (typeof req.body.isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }
    const sync = await setSyncActiveStatus(
      req.params.id,
      req.session.userId!,
      req.body.isActive
    );
    res.json(sync);
  } catch (error) {
    if (error instanceof Error && error.message === 'Sync not found') {
      return res.status(404).json({ error: error.message });
    }
    logError('sync_toggle_failed', {
      syncId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to toggle sync' });
  }
});

// Update sync settings and filters
router.patch('/:id/filters', requireAuth, async (req, res) => {
  try {
    const {
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
    } = req.body;
    
    const result = await prisma.sync.updateMany({
      where: { id: req.params.id, userId: req.session.userId! },
      data: {
        excludedColors: Array.isArray(excludedColors)
          ? sanitizeExcludedColors(excludedColors)
          : undefined,
        excludedKeywords: Array.isArray(excludedKeywords)
          ? sanitizeExcludedKeywords(excludedKeywords)
          : undefined,
        syncEventTitles: typeof syncEventTitles === 'boolean' ? syncEventTitles : undefined,
        syncEventDescription:
          typeof syncEventDescription === 'boolean' ? syncEventDescription : undefined,
        syncEventLocation: typeof syncEventLocation === 'boolean' ? syncEventLocation : undefined,
        syncMeetingLinks: typeof syncMeetingLinks === 'boolean' ? syncMeetingLinks : undefined,
        markEventPrivate: typeof markEventPrivate === 'boolean' ? markEventPrivate : undefined,
        disableRemindersForClones:
          typeof disableRemindersForClones === 'boolean' ? disableRemindersForClones : undefined,
        eventIdentifier:
          typeof eventIdentifier === 'string' ? sanitizeEventIdentifier(eventIdentifier) : undefined,
        cloneColorId:
          cloneColorId === undefined ? undefined : normalizeGoogleEventColorId(cloneColorId),
        copyRsvpStatuses: Array.isArray(copyRsvpStatuses)
          ? sanitizeRsvpStatuses(copyRsvpStatuses)
          : undefined,
        syncFreeEvents: typeof syncFreeEvents === 'boolean' ? syncFreeEvents : undefined,
      },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Sync not found' });
    }

    const sync = await prisma.sync.findUnique({ where: { id: req.params.id } });
    
    res.json(sync);
  } catch (error) {
    logError('sync_filters_update_failed', {
      syncId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to update filters' });
  }
});

// Migration endpoint - backfill targetGoogleAccountId for old syncs
router.post('/migrate/target-accounts', requireAuth, async (req, res) => {
  try {
    // Find all syncs for this user without targetGoogleAccountId
    const syncsToMigrate = await prisma.sync.findMany({
      where: {
        userId: req.session.userId!,
        targetGoogleAccountId: null,
      },
    });

    logInfo('target_account_migration_started', {
      syncCount: syncsToMigrate.length,
      userId: req.session.userId,
    });

    const results = {
      total: syncsToMigrate.length,
      migrated: 0,
      failed: 0,
      details: [] as any[],
    };

    // Get all Google accounts for this user
    const accounts = await prisma.googleAccount.findMany({
      where: { userId: req.session.userId! },
      orderBy: { isPrimary: 'desc' },
    });

    for (const sync of syncsToMigrate) {
      try {
        let foundAccountId: string | null = null;

        // Try each account to see which can access the target calendar
        for (const account of accounts) {
          try {
            const calendar = await getAuthenticatedCalendar(req.session.userId!, account.id);
            const calendarInfo = await calendar.calendarList.get({
              calendarId: sync.targetCalendarId,
            });

            if (
              calendarInfo.data?.accessRole === 'writer' ||
              calendarInfo.data?.accessRole === 'owner'
            ) {
              foundAccountId = account.id;
              break;
            }
          } catch (error) {
            // Account doesn't have access, continue
            continue;
          }
        }

        if (foundAccountId) {
          await prisma.sync.update({
            where: { id: sync.id },
            data: { targetGoogleAccountId: foundAccountId },
          });
          results.migrated++;
          results.details.push({
            syncId: sync.id,
            targetCalendarId: sync.targetCalendarId,
            accountId: foundAccountId,
            status: 'migrated',
          });
        } else {
          // Try primary as fallback
          const primaryAccount = accounts.find((a) => a.isPrimary);
          if (primaryAccount) {
            await prisma.sync.update({
              where: { id: sync.id },
              data: { targetGoogleAccountId: primaryAccount.id },
            });
            results.migrated++;
            results.details.push({
              syncId: sync.id,
              targetCalendarId: sync.targetCalendarId,
              accountId: primaryAccount.id,
              status: 'migrated_fallback',
            });
          } else {
            results.failed++;
            results.details.push({
              syncId: sync.id,
              targetCalendarId: sync.targetCalendarId,
              status: 'failed',
              reason: 'No account has access to target calendar',
            });
          }
        }
      } catch (error: any) {
        results.failed++;
        results.details.push({
          syncId: sync.id,
          status: 'error',
          error: error.message,
        });
      }
    }

    res.json(results);
  } catch (error) {
    logError('target_account_migration_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Migration failed' });
  }
});

export default router;
