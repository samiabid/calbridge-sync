import cron from 'node-cron';
import { setupWebhook, stopWebhook } from './webhook';
import { sendAlert } from './alerts';
import { logError, logInfo } from './logger';
import { prisma } from './prisma';

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

function schedulePostRenewalMaintenance() {
  void Promise.all([import('./webhook'), import('./sync')])
    .then(async ([{ runActiveSyncCatchup }, { runRecurrenceHorizonMaintenance }]) => {
      await runActiveSyncCatchup();
      const horizonSummary = await runRecurrenceHorizonMaintenance();
      logInfo('post_renewal_sync_maintenance_completed', {
        ...horizonSummary,
      });
      if (horizonSummary.failedDirections > 0) {
        await sendAlert({
          severity: 'warn',
          key: 'recurrence_horizon_maintenance_partial_failure',
          message: 'Recurring-event horizon maintenance completed with failures.',
          details: {
            checkedDirections: horizonSummary.checkedDirections,
            extendedDirections: horizonSummary.extendedDirections,
            failedDirections: horizonSummary.failedDirections,
          },
          cooldownMs: 6 * 60 * 60 * 1000,
        });
      }
    })
    .catch((error) => {
      logError('post_renewal_sync_maintenance_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function runWebhookRenewalCheck(options: { force?: boolean } = {}) {
  const force = Boolean(options.force);
  const startedAt = new Date();
  setWebhookRenewalStatus({
    status: 'running',
    lastStartedAt: startedAt.toISOString(),
    lastError: null,
  });
  logInfo('webhook_renewal_started', {
    startedAt: startedAt.toISOString(),
    force,
  });

  try {
    // Find active syncs with missing or expiring webhooks.
    const expiringDate = new Date();
    expiringDate.setDate(expiringDate.getDate() + 2);

    const syncs = await prisma.sync.findMany({
      where: force
        ? { isActive: true }
        : {
            isActive: true,
            OR: [
              { sourceChannelId: null },
              { sourceResourceId: null },
              { sourceExpiration: null },
              {
                sourceExpiration: {
                  lte: expiringDate,
                },
              },
              { isTwoWay: true, targetChannelId: null },
              { isTwoWay: true, targetResourceId: null },
              { isTwoWay: true, targetExpiration: null },
              {
                isTwoWay: true,
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
        const shouldRenewSource =
          force ||
          !sync.sourceChannelId ||
          !sync.sourceResourceId ||
          !sync.sourceExpiration ||
          sync.sourceExpiration <= expiringDate;
        const oldSourceChannelId = sync.sourceChannelId;
        const oldSourceResourceId = sync.sourceResourceId;

        if (shouldRenewSource) {
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
          if (oldSourceChannelId && oldSourceResourceId) {
            await stopWebhook(
              sync.userId,
              sync.sourceGoogleAccountId || sync.googleAccountId,
              oldSourceChannelId,
              oldSourceResourceId
            ).catch((error) => {
              logError('webhook_renewal_old_source_stop_failed', {
                syncId: sync.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          renewedCount += 1;
        }

        // Renew target webhook if two-way sync
        const shouldRenewTarget =
          sync.isTwoWay &&
          (force ||
            !sync.targetChannelId ||
            !sync.targetResourceId ||
            !sync.targetExpiration ||
            sync.targetExpiration <= expiringDate);
        const oldTargetChannelId = sync.targetChannelId;
        const oldTargetResourceId = sync.targetResourceId;

        if (shouldRenewTarget) {
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
          if (oldTargetChannelId && oldTargetResourceId) {
            await stopWebhook(
              sync.userId,
              sync.targetGoogleAccountId || sync.googleAccountId,
              oldTargetChannelId,
              oldTargetResourceId
            ).catch((error) => {
              logError('webhook_renewal_old_target_stop_failed', {
                syncId: sync.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
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
    schedulePostRenewalMaintenance();
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

let scheduledRenewalTask: cron.ScheduledTask | null = null;

export function setupWebhookRenewal() {
  setWebhookRenewalStatus({
    status: 'scheduled',
    scheduledAt: new Date().toISOString(),
    lastError: null,
    lastRunSummary: null,
  });

  scheduledRenewalTask = cron.schedule(WEBHOOK_RENEWAL_SCHEDULE, async () => {
    await runWebhookRenewalCheck();
  });

  logInfo('webhook_renewal_scheduled', {
    schedule: WEBHOOK_RENEWAL_SCHEDULE,
  });
}

export function stopWebhookRenewal() {
  scheduledRenewalTask?.stop();
  scheduledRenewalTask = null;
}
