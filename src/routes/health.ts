import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import packageJson from '../../package.json';
import { getPublicBaseUrl } from '../config/runtime';
import { isTokenEncryptionEnabled } from '../services/tokenCrypto';
import { getWebhookRenewalStatus } from '../services/webhookRenewal';

const router = Router();
const prisma = new PrismaClient();

function getAppMetadata() {
  return {
    service: 'calendar-sync-app',
    version: packageJson.version,
    environment: process.env.NODE_ENV || 'development',
    commit:
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.SOURCE_VERSION ||
      process.env.GITHUB_SHA ||
      null,
  };
}

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ...getAppMetadata(),
    timestamp: new Date().toISOString(),
    webhookRenewal: getWebhookRenewalStatus(),
  });
});

router.get('/ready', async (_req, res) => {
  const timestamp = new Date().toISOString();
  const checks = {
    database: false,
    sessionConfigured: Boolean(process.env.DATABASE_URL) && Boolean(process.env.SESSION_SECRET || process.env.NODE_ENV !== 'production'),
    tokenEncryptionConfigured: isTokenEncryptionEnabled(),
    publicUrlConfigured: Boolean(getPublicBaseUrl()),
    webhookRenewalScheduled: getWebhookRenewalStatus().status !== 'not_scheduled',
  };

  let databaseError: string | null = null;

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.database = true;
  } catch (error: any) {
    databaseError = error instanceof Error ? error.message : String(error);
  }

  const webhookRenewal = getWebhookRenewalStatus();
  const ok =
    checks.database &&
    checks.sessionConfigured &&
    checks.webhookRenewalScheduled &&
    webhookRenewal.status !== 'error';

  res.status(ok ? 200 : 503).json({
    ok,
    ...getAppMetadata(),
    timestamp,
    checks,
    databaseError,
    webhookRenewal,
  });
});

export default router;
