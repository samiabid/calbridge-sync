import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeGoogleEventColorId } from '../services/eventColors';

test('normalizes valid Google Calendar event color IDs', () => {
  assert.equal(normalizeGoogleEventColorId('1'), '1');
  assert.equal(normalizeGoogleEventColorId(' 11 '), '11');
});

test('rejects invalid Google Calendar event color IDs', () => {
  assert.equal(normalizeGoogleEventColorId('0'), null);
  assert.equal(normalizeGoogleEventColorId('12'), null);
  assert.equal(normalizeGoogleEventColorId(1), null);
  assert.equal(normalizeGoogleEventColorId(null), null);
});

test('clone color is present in Prisma and runtime schema bootstrap', () => {
  const root = path.resolve(__dirname, '../..');
  const prismaSchema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
  const runtimeSchema = fs.readFileSync(path.join(root, 'src/services/schema.ts'), 'utf8');

  assert.match(prismaSchema, /cloneColorId\s+String\?/);
  assert.match(runtimeSchema, /ADD COLUMN IF NOT EXISTS "cloneColorId" TEXT/);
});
