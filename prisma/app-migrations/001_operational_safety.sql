CREATE TABLE IF NOT EXISTS "OperationLease" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "holder" TEXT NOT NULL,
  "expiresAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- migrate:split
CREATE INDEX IF NOT EXISTS "OperationLease_expiresAt_idx"
  ON "OperationLease"("expiresAt");

-- migrate:split
CREATE INDEX IF NOT EXISTS "SyncEventAudit_createdAt_idx"
  ON "SyncEventAudit"("createdAt");

-- migrate:split
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'SyncedEvent_one_source_mapping_key'
  ) AND NOT EXISTS (
    SELECT 1
    FROM "SyncedEvent"
    GROUP BY "syncId", "sourceCalendarId", "sourceEventId"
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX "SyncedEvent_one_source_mapping_key"
      ON "SyncedEvent"("syncId", "sourceCalendarId", "sourceEventId");
  END IF;
END $$;
