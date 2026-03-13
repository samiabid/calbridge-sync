import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { getCalendarList, getAuthenticatedCalendar } from '../services/calendar';
import {
  createSync,
  deleteSync,
  getSyncs,
  rerunMissedBackfill,
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

const router = Router();
const prisma = new PrismaClient();

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
    console.error('Error fetching syncs:', error);
    res.status(500).json({ error: 'Failed to fetch syncs' });
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
    res.status(400).json({ error: message });
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
    console.error('Error fetching accounts:', error);
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
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Get user's calendars
router.get('/calendars', requireAuth, async (req, res) => {
  try {
    const calendars = await getCalendarList(req.session.userId!);
    res.json(calendars);
  } catch (error) {
    console.error('Error fetching calendars:', error);
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
      excludedColors: excludedColors || [],
      excludedKeywords: excludedKeywords || [],
      syncEventTitles: typeof syncEventTitles === 'boolean' ? syncEventTitles : true,
      syncEventDescription: typeof syncEventDescription === 'boolean' ? syncEventDescription : true,
      syncEventLocation: typeof syncEventLocation === 'boolean' ? syncEventLocation : true,
      syncMeetingLinks: typeof syncMeetingLinks === 'boolean' ? syncMeetingLinks : true,
      markEventPrivate: typeof markEventPrivate === 'boolean' ? markEventPrivate : false,
      disableRemindersForClones:
        typeof disableRemindersForClones === 'boolean' ? disableRemindersForClones : false,
      eventIdentifier:
        typeof eventIdentifier === 'string' && eventIdentifier.trim().length > 0
          ? eventIdentifier.trim()
          : null,
      copyRsvpStatuses: Array.isArray(copyRsvpStatuses) ? copyRsvpStatuses : [],
      syncFreeEvents: typeof syncFreeEvents === 'boolean' ? syncFreeEvents : true,
    });

    res.json(sync);
  } catch (error: any) {
    console.error('Error creating sync:', error);
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
    console.error('Error deleting sync:', error);
    res.status(500).json({ error: 'Failed to delete sync' });
  }
});

// Re-run initial backfill in the background for an existing sync.
router.post('/:id/rerun-backfill', requireAuth, async (req, res) => {
  try {
    await rerunMissedBackfill(req.params.id, req.session.userId!);
    res.json({ success: true, message: 'Backfill started' });
  } catch (error: any) {
    const message = error?.message || 'Failed to start backfill';
    const status = message.toLowerCase().includes('not found') || message.toLowerCase().includes('paused')
      ? 400
      : 500;
    res.status(status).json({ error: message });
  }
});

// Toggle sync active status
router.patch('/:id/toggle', requireAuth, async (req, res) => {
  try {
    const isActive = Boolean(req.body.isActive);
    const result = await prisma.sync.updateMany({
      where: { id: req.params.id, userId: req.session.userId! },
      data: {
        isActive,
        lastSyncStatus: isActive ? 'success' : 'paused',
        ...(isActive ? {} : { lastSyncError: null }),
      },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Sync not found' });
    }

    const sync = await prisma.sync.findUnique({ where: { id: req.params.id } });
    res.json(sync);
  } catch (error) {
    console.error('Error toggling sync:', error);
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
      copyRsvpStatuses,
      syncFreeEvents,
    } = req.body;
    
    const result = await prisma.sync.updateMany({
      where: { id: req.params.id, userId: req.session.userId! },
      data: {
        excludedColors: Array.isArray(excludedColors) ? excludedColors : undefined,
        excludedKeywords: Array.isArray(excludedKeywords) ? excludedKeywords : undefined,
        syncEventTitles: typeof syncEventTitles === 'boolean' ? syncEventTitles : undefined,
        syncEventDescription:
          typeof syncEventDescription === 'boolean' ? syncEventDescription : undefined,
        syncEventLocation: typeof syncEventLocation === 'boolean' ? syncEventLocation : undefined,
        syncMeetingLinks: typeof syncMeetingLinks === 'boolean' ? syncMeetingLinks : undefined,
        markEventPrivate: typeof markEventPrivate === 'boolean' ? markEventPrivate : undefined,
        disableRemindersForClones:
          typeof disableRemindersForClones === 'boolean' ? disableRemindersForClones : undefined,
        eventIdentifier:
          typeof eventIdentifier === 'string'
            ? eventIdentifier.trim().length > 0
              ? eventIdentifier.trim()
              : null
            : undefined,
        copyRsvpStatuses: Array.isArray(copyRsvpStatuses) ? copyRsvpStatuses : undefined,
        syncFreeEvents: typeof syncFreeEvents === 'boolean' ? syncFreeEvents : undefined,
      },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Sync not found' });
    }

    const sync = await prisma.sync.findUnique({ where: { id: req.params.id } });
    
    res.json(sync);
  } catch (error) {
    console.error('Error updating filters:', error);
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

    console.log(`Migrating ${syncsToMigrate.length} syncs for user ${req.session.userId}`);

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
            const calendarInfo = await calendar.calendars.get({
              calendarId: sync.targetCalendarId,
            });

            if (calendarInfo.data) {
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
    console.error('Migration failed:', error);
    res.status(500).json({ error: 'Migration failed' });
  }
});

export default router;
