import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function ensureSyncColumns() {
  try {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "sourceUpdatedMin" TIMESTAMP'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Sync" ADD COLUMN IF NOT EXISTS "targetUpdatedMin" TIMESTAMP'
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
  } catch (error) {
    console.error('Failed to ensure Sync columns exist:', error);
  }
}
