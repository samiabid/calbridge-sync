import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  forceSyncDashboardEvent,
  listSyncDashboardEvents,
} from '../services/syncEventsDashboard';

interface SyncEventsRouteDeps {
  authMiddleware?: typeof requireAuth;
  listEvents?: typeof listSyncDashboardEvents;
  forceSyncEvent?: typeof forceSyncDashboardEvent;
}

export function buildSyncEventsRouter(deps: SyncEventsRouteDeps = {}) {
  const router = Router();
  const authMiddleware = deps.authMiddleware || requireAuth;
  const listEvents = deps.listEvents || listSyncDashboardEvents;
  const forceSyncEvent = deps.forceSyncEvent || forceSyncDashboardEvent;

  router.get('/:id/events', authMiddleware, async (req, res) => {
    try {
      const result = await listEvents(req.params.id, req.session.userId!, {
        daysBack: req.query?.daysBack,
        daysForward: req.query?.daysForward,
        direction: req.query?.direction,
        page: req.query?.page,
        pageSize: req.query?.pageSize,
      });
      res.json(result);
    } catch (error: any) {
      const message = error?.message || 'Failed to load sync events';
      const normalized = String(message).toLowerCase();
      const status = normalized.includes('not found') || normalized.includes('invalid') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.post('/:id/events/force-sync', authMiddleware, async (req, res) => {
    try {
      const result = await forceSyncEvent(req.params.id, req.session.userId!, {
        direction: req.body?.direction,
        sourceEventId: req.body?.sourceEventId,
        sourceCalendarId: req.body?.sourceCalendarId,
      });
      res.json({ success: true, ...result });
    } catch (error: any) {
      const message = error?.message || 'Failed to force sync event';
      const normalized = String(message).toLowerCase();
      const status =
        normalized.includes('not found') ||
        normalized.includes('invalid') ||
        normalized.includes('paused') ||
        normalized.includes('required')
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  });

  return router;
}

export default buildSyncEventsRouter();
