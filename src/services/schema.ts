
import { prisma } from './prisma';
import { logError } from './logger';

export async function ensureSyncColumns() {
  try {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "sourceUpdatedMin" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "targetUpdatedMin" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "sourceSyncToken" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "targetSyncToken" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "sourceRecurrenceHorizon" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "targetRecurrenceHorizon" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "invalidGrantFailures" INTEGER NOT NULL DEFAULT 0'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "syncEventTitles" BOOLEAN NOT NULL DEFAULT TRUE'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "syncEventDescription" BOOLEAN NOT NULL DEFAULT TRUE'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "syncEventLocation" BOOLEAN NOT NULL DEFAULT TRUE'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "syncMeetingLinks" BOOLEAN NOT NULL DEFAULT TRUE'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "markEventPrivate" BOOLEAN NOT NULL DEFAULT FALSE'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "disableRemindersForClones" BOOLEAN NOT NULL DEFAULT FALSE'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "eventIdentifier" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "cloneColorId" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "copyRsvpStatuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "syncFreeEvents" BOOLEAN NOT NULL DEFAULT TRUE'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "lastDetectedChangeAt" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "lastSyncStatus" TEXT NOT NULL DEFAULT \'idle\''
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "lastSyncError" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "backfillRunId" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "backfillStatus" TEXT NOT NULL DEFAULT \'idle\''
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "backfillStartedAt" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "backfillCompletedAt" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "backfillLastError" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "lastAccountDetectionAt" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "Sync_isActive_idx" ON "Sync"("isActive")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "Sync_sourceChannelId_idx" ON "Sync"("sourceChannelId")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "Sync_targetChannelId_idx" ON "Sync"("targetChannelId")'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "SyncedEvent" ADD COLUMN IF NOT EXISTS "sourceRecurringEventId" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "SyncedEvent" ADD COLUMN IF NOT EXISTS "sourceOriginalStart" TEXT'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncedEvent_syncId_sourceCalendarId_sourceRecurringEventId_idx" ON "SyncedEvent"("syncId", "sourceCalendarId", "sourceRecurringEventId")'
    );
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SyncEventAudit" (
        "id" TEXT NOT NULL,
        "syncId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "direction" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "result" TEXT NOT NULL,
        "sourceEventId" TEXT,
        "sourceCalendarId" TEXT,
        "targetEventId" TEXT,
        "targetCalendarId" TEXT,
        "eventSummary" TEXT,
        "reasonCode" TEXT,
        "reasonMessage" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SyncEventAudit_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "SyncEventAudit_syncId_fkey" FOREIGN KEY ("syncId") REFERENCES "Sync"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "SyncEventAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SyncFailure" (
        "id" TEXT NOT NULL,
        "dedupeKey" TEXT NOT NULL,
        "syncId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "direction" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'open',
        "sourceEventId" TEXT,
        "sourceCalendarId" TEXT,
        "targetEventId" TEXT,
        "targetCalendarId" TEXT,
        "eventSummary" TEXT,
        "errorCode" TEXT,
        "errorMessage" TEXT NOT NULL,
        "failureCount" INTEGER NOT NULL DEFAULT 1,
        "retryCount" INTEGER NOT NULL DEFAULT 0,
        "firstFailedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastFailedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastAttemptedAt" TIMESTAMP,
        "resolutionNote" TEXT,
        "resolvedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SyncFailure_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "SyncFailure_syncId_fkey" FOREIGN KEY ("syncId") REFERENCES "Sync"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "SyncFailure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "SyncFailure_dedupeKey_key" ON "SyncFailure"("dedupeKey")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncEventAudit_syncId_createdAt_idx" ON "SyncEventAudit"("syncId", "createdAt")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncEventAudit_userId_createdAt_idx" ON "SyncEventAudit"("userId", "createdAt")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncEventAudit_sourceEventId_idx" ON "SyncEventAudit"("sourceEventId")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncEventAudit_targetEventId_idx" ON "SyncEventAudit"("targetEventId")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncFailure_userId_status_lastFailedAt_idx" ON "SyncFailure"("userId", "status", "lastFailedAt")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncFailure_syncId_status_lastFailedAt_idx" ON "SyncFailure"("syncId", "status", "lastFailedAt")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncFailure_sourceEventId_idx" ON "SyncFailure"("sourceEventId")'
    );
    await prisma.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "SyncFailure_targetEventId_idx" ON "SyncFailure"("targetEventId")'
    );
  } catch (error) {
    logError('schema_ensure_columns_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
