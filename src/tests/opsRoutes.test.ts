import test from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from 'express';
import { buildHealthRouter } from '../routes/health';
import { buildWebhookRouter } from '../routes/webhook';

interface MockResponse {
  statusCode: number;
  payload: unknown;
  headersSent: boolean;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
  send: (payload: unknown) => MockResponse;
}

function findRouteHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (entry: any) =>
      entry.route &&
      entry.route.path === path &&
      entry.route.methods &&
      entry.route.methods[method.toLowerCase()]
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }

  return layer.route.stack[0].handle;
}

async function invokeRoute(
  router: Router,
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
) {
  const handler = findRouteHandler(router, method, path);
  const req: any = {
    method: method.toUpperCase(),
    path,
    url: path,
    headers: options.headers || {},
    body: options.body || {},
  };

  const res: MockResponse = {
    statusCode: 200,
    payload: null,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      this.headersSent = true;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      this.headersSent = true;
      return this;
    },
  };

  await new Promise<void>((resolve, reject) => {
    Promise.resolve(handler(req, res, (error: unknown) => (error ? reject(error) : resolve())))
      .then(() => resolve())
      .catch(reject);
  });

  return res;
}

test('health route returns metadata and renewal status', async () => {
  const router = buildHealthRouter({
    getMetadata: () => ({
      service: 'calendar-sync-app',
      version: 'test',
      environment: 'test',
      commit: 'abc123',
    }),
    getRenewalStatus: () => ({
      status: 'healthy',
      schedule: '0 2 * * *',
      scheduledAt: '2026-03-15T00:00:00.000Z',
      lastStartedAt: '2026-03-15T02:00:00.000Z',
      lastFinishedAt: '2026-03-15T02:00:01.000Z',
      lastSucceededAt: '2026-03-15T02:00:01.000Z',
      lastFailedAt: null,
      lastError: null,
      lastRunSummary: 'ok',
    }),
  });

  const response = await invokeRoute(router, 'get', '/health');
  const body = response.payload as any;

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.environment, 'test');
  assert.equal(body.commit, 'abc123');
  assert.equal(body.webhookRenewal.status, 'healthy');
});

test('ready route reports degraded status when database check fails', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSessionSecret = process.env.SESSION_SECRET;
  const originalInternalCronToken = process.env.INTERNAL_CRON_TOKEN;
  const originalAlertWebhookUrl = process.env.ALERT_WEBHOOK_URL;

  process.env.DATABASE_URL = 'postgres://example';
  process.env.SESSION_SECRET = 'secret';
  process.env.INTERNAL_CRON_TOKEN = 'token';
  process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.com';

  const router = buildHealthRouter({
    queryDatabase: async () => {
      throw new Error('db down');
    },
    getMetadata: () => ({
      service: 'calendar-sync-app',
      version: 'test',
      environment: 'test',
      commit: 'abc123',
    }),
    getPublicUrl: () => 'https://app.example.com',
    isTokenEncryptionReady: () => true,
    getRenewalStatus: () => ({
      status: 'healthy',
      schedule: '0 2 * * *',
      scheduledAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      lastError: null,
      lastRunSummary: null,
    }),
  });

  try {
    const response = await invokeRoute(router, 'get', '/ready');
    const body = response.payload as any;

    assert.equal(response.statusCode, 503);
    assert.equal(body.ok, false);
    assert.equal(body.checks.database, false);
    assert.equal(body.checks.alertWebhookConfigured, true);
    assert.match(body.databaseError, /db down/i);
  } finally {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SESSION_SECRET = originalSessionSecret;
    process.env.INTERNAL_CRON_TOKEN = originalInternalCronToken;
    process.env.ALERT_WEBHOOK_URL = originalAlertWebhookUrl;
  }
});

test('internal renewal endpoint requires token and runs renewal when authorized', async () => {
  let renewalCalls = 0;
  const originalToken = process.env.INTERNAL_CRON_TOKEN;
  process.env.INTERNAL_CRON_TOKEN = 'test-token';
  const router = buildWebhookRouter({
    runRenewalCheck: async () => {
      renewalCalls += 1;
    },
  });

  try {
    const unauthorized = await invokeRoute(router, 'post', '/internal/renew');
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await invokeRoute(router, 'post', '/internal/renew', {
      headers: {
        authorization: 'Bearer test-token',
      },
    });
    const body = authorized.payload as any;

    assert.equal(authorized.statusCode, 200);
    assert.equal(body.success, true);
    assert.equal(renewalCalls, 1);
  } finally {
    process.env.INTERNAL_CRON_TOKEN = originalToken;
  }
});

test('internal test-alert endpoint requires token and invokes alert sender', async () => {
  let alertCalls = 0;
  const originalToken = process.env.INTERNAL_CRON_TOKEN;
  process.env.INTERNAL_CRON_TOKEN = 'test-token';
  const router = buildWebhookRouter({
    sendTestAlert: async () => {
      alertCalls += 1;
    },
  });

  try {
    const response = await invokeRoute(router, 'post', '/internal/test-alert', {
      headers: {
        'x-internal-token': 'test-token',
      },
    });
    const body = response.payload as any;

    assert.equal(response.statusCode, 200);
    assert.equal(body.success, true);
    assert.equal(alertCalls, 1);
  } finally {
    process.env.INTERNAL_CRON_TOKEN = originalToken;
  }
});
