import { Router } from 'express';
import { handleWebhookNotification } from '../services/webhook';
import { sendAlert } from '../services/alerts';
import { logError, logInfo, logWarn } from '../services/logger';
import { runWebhookRenewalCheck } from '../services/webhookRenewal';
import { runSyncMaintenanceNow } from '../services/syncMaintenance';
import { runSyntheticSyncCanary } from '../services/syncCanary';
import { hasValidInternalToken, safeEqual } from '../utils/security';

interface WebhookRouteDeps {
  handleWebhook?: typeof handleWebhookNotification;
  runRenewalCheck?: (options?: { force?: boolean }) => Promise<unknown>;
  sendTestAlert?: typeof sendAlert;
}

export function buildWebhookRouter(deps: WebhookRouteDeps = {}) {
  const router = Router();
  const processWebhook = deps.handleWebhook || handleWebhookNotification;
  const renewalCheck = deps.runRenewalCheck || runWebhookRenewalCheck;
  const testAlert = deps.sendTestAlert || sendAlert;

  // Google Calendar webhook endpoint
  router.post('/google', (req, res) => {
    try {
      const channelId = req.headers['x-goog-channel-id'] as string;
      const resourceState = req.headers['x-goog-resource-state'] as string;
      const resourceId = req.headers['x-goog-resource-id'] as string;
      const channelToken = req.headers['x-goog-channel-token'] as string | undefined;

      if (!channelId || !resourceState || !resourceId) {
        res.status(200).send('OK');
        return;
      }

      const configuredToken = process.env.GOOGLE_WEBHOOK_TOKEN;
      // When a token is configured, every channel must present a matching one.
      // Channels registered before the token rollout must be re-registered
      // (POST /webhook/internal/renew?force=true) before enabling this.
      if (configuredToken && (!channelToken || !safeEqual(channelToken, configuredToken))) {
        logWarn('webhook_google_token_mismatch', {
          channelId,
          tokenPresent: Boolean(channelToken),
        });
        res.status(200).send('OK');
        return;
      }

      logInfo('webhook_google_received', {
        channelId,
        resourceState,
        resourceId,
      });

      // Acknowledge receipt immediately
      res.status(200).send('OK');

      // Process webhook in background without blocking the response.
      if (resourceState === 'exists') {
        void processWebhook(channelId, resourceId).catch((error) => {
          logError('webhook_google_background_processing_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      logError('webhook_google_request_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(200).send('OK');
      }
    }
  });

  router.post('/internal/renew', async (req, res) => {
    const configuredToken = process.env.INTERNAL_CRON_TOKEN;
    if (!configuredToken) {
      return res.status(503).json({ error: 'Internal renewal token is not configured' });
    }

    if (!hasValidInternalToken(req, configuredToken)) {
      logWarn('webhook_internal_renew_unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const force = req.query?.force === 'true';
      const result = await renewalCheck({ force });
      res.json({ success: true, force, result });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      logError('webhook_internal_renew_failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  router.post('/internal/catchup', async (req, res) => {
    const configuredToken = process.env.INTERNAL_CRON_TOKEN;
    if (!configuredToken) {
      return res.status(503).json({ error: 'Internal catch-up token is not configured' });
    }
    if (!hasValidInternalToken(req, configuredToken)) {
      logWarn('webhook_internal_catchup_unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await runSyncMaintenanceNow();
      res.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError('webhook_internal_catchup_failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  router.post('/internal/canary', async (req, res) => {
    const configuredToken = process.env.INTERNAL_CRON_TOKEN;
    if (!configuredToken) {
      return res.status(503).json({ error: 'Internal canary token is not configured' });
    }
    if (!hasValidInternalToken(req, configuredToken)) {
      logWarn('webhook_internal_canary_unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await runSyntheticSyncCanary();
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.post('/internal/test-alert', async (req, res) => {
    const configuredToken = process.env.INTERNAL_CRON_TOKEN;
    if (!configuredToken) {
      return res.status(503).json({ error: 'Internal alert token is not configured' });
    }

    if (!hasValidInternalToken(req, configuredToken)) {
      logWarn('webhook_internal_test_alert_unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      await testAlert({
        severity: 'warn',
        key: 'manual_test_alert',
        message: 'Manual test alert triggered from protected internal endpoint.',
        details: {
          source: 'internal_test_endpoint',
        },
        cooldownMs: 0,
      });
      res.json({ success: true });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      logError('webhook_internal_test_alert_failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  return router;
}

export default buildWebhookRouter();
