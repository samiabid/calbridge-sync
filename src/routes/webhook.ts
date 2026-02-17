import { Router } from 'express';
import { handleWebhookNotification } from '../services/webhook';

const router = Router();

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
    // Backward-compatible: enforce token only when both configured and present.
    // Older channels created before token rollout may not send one.
    if (configuredToken && channelToken && channelToken !== configuredToken) {
      console.warn('Webhook token mismatch; ignoring notification');
      res.status(200).send('OK');
      return;
    }

    console.log('Webhook received:', {
      channelId,
      resourceState,
      resourceId,
    });

    // Acknowledge receipt immediately
    res.status(200).send('OK');

    // Process webhook in background without blocking the response.
    if (resourceState === 'exists') {
      void handleWebhookNotification(channelId, resourceId).catch((error) => {
        console.error('Error processing webhook notification:', error);
      });
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    if (!res.headersSent) {
      res.status(200).send('OK'); // Still acknowledge to prevent retries
    }
  }
});

export default router;
