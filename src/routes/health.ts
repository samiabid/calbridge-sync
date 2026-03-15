import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import packageJson from '../../package.json';
import { getPublicBaseUrl } from '../config/runtime';
import { isTokenEncryptionEnabled } from '../services/tokenCrypto';
import { getWebhookRenewalStatus } from '../services/webhookRenewal';

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

interface HealthRouteDeps {
  queryDatabase?: () => Promise<void>;
  getPublicUrl?: () => string | null | undefined;
  isTokenEncryptionReady?: () => boolean;
  getRenewalStatus?: typeof getWebhookRenewalStatus;
  getMetadata?: () => ReturnType<typeof getAppMetadata>;
}

export function buildHealthRouter(deps: HealthRouteDeps = {}) {
  const router = Router();
  const queryDatabase =
    deps.queryDatabase ||
    (async () => {
      await prisma.$queryRawUnsafe('SELECT 1');
    });
  const getPublicUrl = deps.getPublicUrl || getPublicBaseUrl;
  const isTokenEncryptionReady = deps.isTokenEncryptionReady || isTokenEncryptionEnabled;
  const getRenewalStatus = deps.getRenewalStatus || getWebhookRenewalStatus;
  const getMetadata = deps.getMetadata || getAppMetadata;

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      ...getMetadata(),
      timestamp: new Date().toISOString(),
      webhookRenewal: getRenewalStatus(),
    });
  });

  router.get('/ready', async (_req, res) => {
    const timestamp = new Date().toISOString();
    const checks = {
      database: false,
      sessionConfigured: Boolean(process.env.DATABASE_URL) && Boolean(process.env.SESSION_SECRET || process.env.NODE_ENV !== 'production'),
      tokenEncryptionConfigured: isTokenEncryptionReady(),
      publicUrlConfigured: Boolean(getPublicUrl()),
      internalRenewalTokenConfigured: Boolean(process.env.INTERNAL_CRON_TOKEN),
      alertWebhookConfigured: Boolean(process.env.ALERT_WEBHOOK_URL),
      webhookRenewalScheduled: getRenewalStatus().status !== 'not_scheduled',
    };

    let databaseError: string | null = null;

    try {
      await queryDatabase();
      checks.database = true;
    } catch (error: any) {
      databaseError = error instanceof Error ? error.message : String(error);
    }

    const webhookRenewal = getRenewalStatus();
    const ok =
      checks.database &&
      checks.sessionConfigured &&
      checks.webhookRenewalScheduled &&
      webhookRenewal.status !== 'error';

    res.status(ok ? 200 : 503).json({
      ok,
      ...getMetadata(),
      timestamp,
      checks,
      databaseError,
      webhookRenewal,
    });
  });

  return router;
}

export default buildHealthRouter();
