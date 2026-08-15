import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getSyncs } from '../services/sync';
import { getOpenSyncFailures } from '../services/syncAudit';
import { getWebhookRenewalStatus } from '../services/webhookRenewal';
import { serializeJsonForScript } from '../utils/serializeForScript';
import { prisma } from '../services/prisma';
import { logError } from '../services/logger';

const router = Router();

// Dashboard page
router.get('/', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
    });

    if (!user) {
      req.session.destroy(() => {});
      return res.redirect('/');
    }

    const syncs = await getSyncs(req.session.userId!);
    const failedEvents = await getOpenSyncFailures(req.session.userId!);
    const [totalSyncCount, activeSyncCount, errorSyncCount, pausedSyncCount, openFailureCount] =
      await Promise.all([
        prisma.sync.count({
          where: { userId: req.session.userId! },
        }),
        prisma.sync.count({
          where: { userId: req.session.userId!, isActive: true },
        }),
        prisma.sync.count({
          where: { userId: req.session.userId!, isActive: true, lastSyncStatus: 'error' },
        }),
        prisma.sync.count({
          where: { userId: req.session.userId!, isActive: false },
        }),
        prisma.syncFailure.count({
          where: { userId: req.session.userId!, status: 'open' },
        }),
      ]);

    const systemHealthSummary = {
      environment: process.env.NODE_ENV || 'development',
      totalSyncCount,
      activeSyncCount,
      errorSyncCount,
      pausedSyncCount,
      openFailureCount,
      webhookRenewal: getWebhookRenewalStatus(),
    };

    res.render('dashboard', {
      user,
      syncs,
      failedEvents,
      systemHealthSummary,
      syncsJson: serializeJsonForScript(syncs),
      systemHealthJson: serializeJsonForScript(systemHealthSummary),
    });
  } catch (error) {
    logError('dashboard_load_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Error loading dashboard');
  }
});

export default router;
