import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getSyncs } from '../services/sync';
import { PrismaClient } from '@prisma/client';
import { getOpenSyncFailures } from '../services/syncAudit';
import { getWebhookRenewalStatus } from '../services/webhookRenewal';

const router = Router();
const prisma = new PrismaClient();

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
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

export default router;
