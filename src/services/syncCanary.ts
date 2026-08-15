import { sendAlert } from './alerts';
import { logError, logInfo } from './logger';
import { prisma } from './prisma';
import { forceSyncDashboardEvent } from './syncEventsDashboard';
import type { SyncDirection } from './syncAudit';

interface SyncCanaryStatus {
  configured: boolean;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
}

const status: SyncCanaryStatus = {
  configured: false,
  lastStartedAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
};

function getCanaryConfig() {
  const syncId = process.env.SYNC_CANARY_SYNC_ID?.trim();
  const sourceEventId = process.env.SYNC_CANARY_SOURCE_EVENT_ID?.trim();
  const direction = process.env.SYNC_CANARY_DIRECTION === 'target_to_source'
    ? 'target_to_source'
    : 'source_to_target';
  return { syncId, sourceEventId, direction: direction as SyncDirection };
}

export function getSyncCanaryStatus(): SyncCanaryStatus {
  const config = getCanaryConfig();
  return { ...status, configured: Boolean(config.syncId && config.sourceEventId) };
}

export async function runSyntheticSyncCanary() {
  const config = getCanaryConfig();
  if (!config.syncId || !config.sourceEventId) {
    throw new Error('Synthetic sync canary is not configured');
  }
  status.configured = true;
  status.lastStartedAt = new Date().toISOString();
  try {
    const sync = await prisma.sync.findUnique({
      where: { id: config.syncId },
      select: { id: true, userId: true, isActive: true },
    });
    if (!sync || !sync.isActive) throw new Error('Canary sync is missing or paused');
    const result = await forceSyncDashboardEvent(sync.id, sync.userId, {
      direction: config.direction,
      sourceEventId: config.sourceEventId,
    });
    if (result.item.status !== 'synced' || !result.item.targetEventId) {
      throw new Error(`Canary event ended with status ${result.item.status}: ${result.item.statusReason}`);
    }
    status.lastSucceededAt = new Date().toISOString();
    status.lastError = null;
    logInfo('synthetic_sync_canary_succeeded', {
      syncId: sync.id,
      direction: config.direction,
      targetEventId: result.item.targetEventId,
    });
    return {
      success: true,
      syncId: sync.id,
      direction: config.direction,
      targetEventId: result.item.targetEventId,
      status: result.item.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.lastFailedAt = new Date().toISOString();
    status.lastError = message;
    logError('synthetic_sync_canary_failed', { error: message });
    await sendAlert({
      severity: 'error',
      key: 'synthetic_sync_canary_failed',
      message: 'Synthetic calendar sync canary failed.',
      details: { syncId: config.syncId, direction: config.direction, error: message },
      cooldownMs: 30 * 60 * 1000,
    });
    throw error;
  }
}
