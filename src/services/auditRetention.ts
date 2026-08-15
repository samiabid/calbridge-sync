import { logInfo } from './logger';
import { prisma } from './prisma';

const DEFAULT_RETENTION_DAYS = 180;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastRunAt = 0;

export function normalizeAuditRetentionDays(value: unknown): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  return Math.min(Math.max(parsed, MIN_RETENTION_DAYS), MAX_RETENTION_DAYS);
}

export async function pruneExpiredSyncAudits(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastRunAt < RUN_INTERVAL_MS) return 0;
  const retentionDays = normalizeAuditRetentionDays(process.env.SYNC_AUDIT_RETENTION_DAYS);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.syncEventAudit.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  lastRunAt = now.getTime();
  logInfo('sync_audit_retention_completed', {
    retentionDays,
    cutoff: cutoff.toISOString(),
    deletedCount: result.count,
  });
  return result.count;
}
