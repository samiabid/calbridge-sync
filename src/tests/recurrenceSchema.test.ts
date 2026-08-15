import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('recurrence state is present in Prisma and idempotent runtime schema bootstrap', () => {
  const root = path.resolve(__dirname, '../..');
  const prismaSchema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
  const runtimeSchema = fs.readFileSync(path.join(root, 'src/services/schema.ts'), 'utf8');
  for (const field of [
    'sourceSyncToken',
    'targetSyncToken',
    'sourceRecurrenceHorizon',
    'targetRecurrenceHorizon',
    'sourceRecurringEventId',
    'sourceOriginalStart',
  ]) {
    assert.match(prismaSchema, new RegExp(`\\b${field}\\b`));
    assert.match(runtimeSchema, new RegExp(`\\b${field}\\b`));
  }
});
