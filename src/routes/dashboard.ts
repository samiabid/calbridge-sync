import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getSyncs } from '../services/sync';
import { PrismaClient } from '@prisma/client';
import { getOpenSyncFailures } from '../services/syncAudit';

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

    res.render('dashboard', {
      user,
      syncs,
      failedEvents,
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

export default router;
