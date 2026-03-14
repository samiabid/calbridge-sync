import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { setupWebhook } from './webhook';
import { sendAlert } from './alerts';
import { logError, logInfo } from './logger';

const prisma = new PrismaClient();
const WEBHOOK_RENEWAL_SCHEDULE = '0 2 * * *';

type WebhookRenewalState = 'not_scheduled' | 'scheduled' | 'running' | 'healthy' | 'error';

interface WebhookRenewalStatus {
  status: WebhookRenewalState;
  schedule: string;
  scheduledAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  lastRunSummary: string | null;
}

const webhookRenewalStatus: WebhookRenewalStatus = {
  status: 'not_scheduled',
  schedule: WEBHOOK_RENEWAL_SCHEDULE,
  scheduledAt: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  lastRunSummary: null,
};

function setWebhookRenewalStatus(
  updates: Partial<WebhookRenewalStatus>
) {
  Object.assign(webhookRenewalStatus, updates);
}

export function getWebhookRenewalStatus(): WebhookRenewalStatus {
  return { ...webhookRenewalStatus };
}

export async function runWebhookRenewalCheck() {
  const startedAt = new Date();
  setWebhookRenewalStatus({
    status: 'running',
    lastStartedAt: startedAt.toISOString(),
    lastError: null,
  });
  logInfo('webhook_renewal_started', {
    startedAt: startedAt.toISOString(),
  });

  try {
    // Find syncs with webhooks expiring in the next 2 days
    const expiringDate = new Date();
    expiringDate.setDate(expiringDate.getDate() + 2);

    const syncs = await prisma.sync.findMany({
      where: {
        isActive: true,
        OR: [
          {
            sourceExpiration: {
              lte: expiringDate,
            },
          },
          {
            targetExpiration: {
              lte: expiringDate,
            },
          },
        ],
      },
    });

    logInfo('webhook_renewal_expiring_syncs_loaded', {
      syncCount: syncs.length,
    });

    let renewedCount = 0;
    let failedCount = 0;

    for (const sync of syncs) {
      try {
        // Renew source webhook
        if (sync.sourceExpiration && sync.sourceExpiration <= expiringDate) {
          logInfo('webhook_renewal_source_renewing', {
            syncId: sync.id,
            calendarId: sync.sourceCalendarId,
            direction: 'source',
          });
          await setupWebhook(
            sync.id,
            sync.userId,
            sync.sourceGoogleAccountId || sync.googleAccountId,
            sync.sourceCalendarId,
            'source'
          );
          renewedCount += 1;
        }

        // Renew target webhook if two-way sync
        if (
          sync.isTwoWay &&
          sync.targetExpiration &&
          sync.targetExpiration <= expiringDate
        ) {
          logInfo('webhook_renewal_target_renewing', {
            syncId: sync.id,
            calendarId: sync.targetCalendarId,
            direction: 'target',
          });
          await setupWebhook(
            sync.id,
            sync.userId,
            sync.targetGoogleAccountId || sync.googleAccountId,
            sync.targetCalendarId,
            'target'
          );
          renewedCount += 1;
        }
      } catch (error: any) {
        failedCount += 1;
        logError('webhook_renewal_sync_failed', {
          syncId: sync.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const finishedAt = new Date();
    setWebhookRenewalStatus({
      status: failedCount > 0 ? 'error' : 'healthy',
      lastFinishedAt: finishedAt.toISOString(),
      lastSucceededAt: failedCount > 0 ? webhookRenewalStatus.lastSucceededAt : finishedAt.toISOString(),
      lastFailedAt: failedCount > 0 ? finishedAt.toISOString() : webhookRenewalStatus.lastFailedAt,
      lastError: failedCount > 0 ? `${failedCount} sync renewal(s) failed` : null,
      lastRunSummary: `expiringSyncs=${syncs.length}, renewed=${renewedCount}, failed=${failedCount}`,
    });
    logInfo('webhook_renewal_completed', {
      expiringSyncs: syncs.length,
      renewedCount,
      failedCount,
      status: webhookRenewalStatus.status,
    });
    if (failedCount > 0) {
      await sendAlert({
        severity: 'error',
        key: 'webhook_renewal_partial_failure',
        message: 'Webhook renewal completed with one or more sync renewal failures.',
        details: {
          expiringSyncs: syncs.length,
          renewedCount,
          failedCount,
        },
        cooldownMs: 60 * 60 * 1000,
      });
    }
  } catch (error: any) {
    const finishedAt = new Date();
    const message = error instanceof Error ? error.message : String(error);
    setWebhookRenewalStatus({
      status: 'error',
      lastFinishedAt: finishedAt.toISOString(),
      lastFailedAt: finishedAt.toISOString(),
      lastError: message,
      lastRunSummary: 'renewal_cron_failed',
    });
    logError('webhook_renewal_failed', {
      error: message,
    });
    await sendAlert({
      severity: 'error',
      key: 'webhook_renewal_failed',
      message: 'Webhook renewal cron job failed.',
      details: {
        error: message,
      },
      cooldownMs: 60 * 60 * 1000,
    });
  }
}

export function setupWebhookRenewal() {
  setWebhookRenewalStatus({
    status: 'scheduled',
    scheduledAt: new Date().toISOString(),
    lastError: null,
    lastRunSummary: null,
  });

  cron.schedule(WEBHOOK_RENEWAL_SCHEDULE, async () => {
    await runWebhookRenewalCheck();
  });

  logInfo('webhook_renewal_scheduled', {
    schedule: WEBHOOK_RENEWAL_SCHEDULE,
  });
}
