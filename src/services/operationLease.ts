import crypto from 'crypto';
import { prisma } from './prisma';
import { logInfo, logWarn } from './logger';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;

export class OperationLeaseBusyError extends Error {
  code = 'OPERATION_LEASE_BUSY';

  constructor(key: string) {
    super(`Another heavy calendar operation is already running (${key}).`);
  }
}

interface LeaseOptions {
  wait?: boolean;
  waitTimeoutMs?: number;
  leaseMs?: number;
  pollMs?: number;
  holder?: string;
}

async function tryAcquireLease(key: string, holder: string, leaseMs: number): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ key: string }>>(
    `
      INSERT INTO "OperationLease" ("key", "holder", "expiresAt", "updatedAt")
      VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'), NOW())
      ON CONFLICT ("key") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "expiresAt" = EXCLUDED."expiresAt",
          "updatedAt" = NOW()
      WHERE "OperationLease"."expiresAt" <= NOW()
         OR "OperationLease"."holder" = EXCLUDED."holder"
      RETURNING "key"
    `,
    key,
    holder,
    leaseMs
  );
  return rows.length > 0;
}

async function releaseLease(key: string, holder: string): Promise<void> {
  await prisma.operationLease.deleteMany({ where: { key, holder } });
}

export async function withOperationLease<T>(
  key: string,
  fn: () => Promise<T>,
  options: LeaseOptions = {}
): Promise<T> {
  const holder = options.holder || crypto.randomUUID();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const wait = options.wait ?? false;
  const waitTimeoutMs = options.waitTimeoutMs ?? 0;
  const waitStartedAt = Date.now();

  while (!(await tryAcquireLease(key, holder, leaseMs))) {
    if (!wait || (waitTimeoutMs > 0 && Date.now() - waitStartedAt >= waitTimeoutMs)) {
      throw new OperationLeaseBusyError(key);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  logInfo('operation_lease_acquired', { key, holder });
  const heartbeat = setInterval(() => {
    void prisma.operationLease
      .updateMany({
        where: { key, holder },
        data: { expiresAt: new Date(Date.now() + leaseMs) },
      })
      .then((result) => {
        if (result.count === 0) logWarn('operation_lease_heartbeat_lost', { key, holder });
      })
      .catch((error) => {
        logWarn('operation_lease_heartbeat_failed', {
          key,
          holder,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseLease(key, holder).catch((error) => {
      logWarn('operation_lease_release_failed', {
        key,
        holder,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    logInfo('operation_lease_released', { key, holder });
  }
}

export const HEAVY_CALENDAR_OPERATION_LEASE = 'google-calendar-heavy-operation';

