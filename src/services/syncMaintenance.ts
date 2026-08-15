import { sendAlert } from './alerts';
import { logError, logInfo, logWarn } from './logger';
import { OperationLeaseBusyError, withOperationLease } from './operationLease';
import { runActiveSyncCatchup, type ActiveSyncCatchupSummary } from './webhook';
import { pruneExpiredSyncAudits } from './auditRetention';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 15_000;
const MAINTENANCE_LEASE = 'google-calendar-incremental-catchup';

type MaintenanceState = 'not_scheduled' | 'scheduled' | 'running' | 'healthy' | 'error';

interface SyncMaintenanceStatus {
  status: MaintenanceState;
  intervalMs: number;
  scheduledAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  lastSummary: ActiveSyncCatchupSummary | null;
}

const status: SyncMaintenanceStatus = {
  status: 'not_scheduled',
  intervalMs: DEFAULT_INTERVAL_MS,
  scheduledAt: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  lastSummary: null,
};

let timer: NodeJS.Timeout | null = null;
let stopped = true;

function getIntervalMs(): number {
  const parsed = Number.parseInt(process.env.SYNC_CATCHUP_INTERVAL_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed < 60_000) return DEFAULT_INTERVAL_MS;
  return Math.min(parsed, 60 * 60 * 1000);
}

function getNextDelay(intervalMs: number): number {
  const jitter = intervalMs * 0.25;
  return Math.round(intervalMs - jitter + Math.random() * jitter * 2);
}

export function getSyncMaintenanceStatus(): SyncMaintenanceStatus {
  return {
    ...status,
    lastSummary: status.lastSummary ? { ...status.lastSummary } : null,
  };
}

export async function runSyncMaintenanceNow(): Promise<ActiveSyncCatchupSummary> {
  const startedAt = new Date();
  Object.assign(status, {
    status: 'running',
    lastStartedAt: startedAt.toISOString(),
    lastError: null,
  });

  try {
    const summary = await withOperationLease(
      MAINTENANCE_LEASE,
      runActiveSyncCatchup,
      { holder: `catchup:${process.pid}` }
    );
    await pruneExpiredSyncAudits();
    const finishedAt = new Date();
    const failed = summary.failedDirections > 0;
    Object.assign(status, {
      status: failed ? 'error' : 'healthy',
      lastFinishedAt: finishedAt.toISOString(),
      lastSucceededAt: failed ? status.lastSucceededAt : finishedAt.toISOString(),
      lastFailedAt: failed ? finishedAt.toISOString() : status.lastFailedAt,
      lastError: failed ? `${summary.failedDirections} catch-up direction(s) failed` : null,
      lastSummary: summary,
    });
    if (failed) {
      await sendAlert({
        severity: 'error',
        key: 'scheduled_sync_catchup_failed',
        message: 'Scheduled calendar catch-up completed with failures.',
        details: {
          attemptedDirections: summary.attemptedDirections,
          succeededDirections: summary.succeededDirections,
          failedDirections: summary.failedDirections,
        },
        cooldownMs: 30 * 60 * 1000,
      });
      throw new Error(status.lastError || 'Scheduled catch-up failed');
    }
    return summary;
  } catch (error) {
    if (error instanceof OperationLeaseBusyError) {
      logInfo('scheduled_sync_catchup_skipped_busy');
      Object.assign(status, {
        status: status.lastSucceededAt ? 'healthy' : 'scheduled',
        lastFinishedAt: new Date().toISOString(),
        lastError: null,
      });
      return { attemptedDirections: 0, succeededDirections: 0, failedDirections: 0 };
    }
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(status, {
      status: 'error',
      lastFinishedAt: new Date().toISOString(),
      lastFailedAt: new Date().toISOString(),
      lastError: message,
    });
    logError('scheduled_sync_catchup_failed', { error: message });
    throw error;
  }
}

function scheduleNext(delayMs: number) {
  if (stopped) return;
  timer = setTimeout(async () => {
    try {
      await runSyncMaintenanceNow();
    } catch {
      // Status and alerts are handled by runSyncMaintenanceNow.
    } finally {
      scheduleNext(getNextDelay(status.intervalMs));
    }
  }, delayMs);
  timer.unref();
}

export function setupSyncMaintenance() {
  if (timer) {
    logWarn('sync_maintenance_already_scheduled');
    return;
  }
  stopped = false;
  status.intervalMs = getIntervalMs();
  status.status = 'scheduled';
  status.scheduledAt = new Date().toISOString();
  scheduleNext(DEFAULT_STARTUP_DELAY_MS);
  logInfo('sync_maintenance_scheduled', {
    intervalMs: status.intervalMs,
    startupDelayMs: DEFAULT_STARTUP_DELAY_MS,
  });
}

export function stopSyncMaintenance() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
