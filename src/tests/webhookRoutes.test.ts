import test from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from 'express';
import { buildWebhookRouter } from '../routes/webhook';

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
  options: { headers?: Record<string, string> } = {}
) {
  const handler = findRouteHandler(router, method, path);
  const req: any = {
    method: method.toUpperCase(),
    path,
    url: path,
    headers: options.headers || {},
    body: {},
  };

  const res: any = {
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

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

const GOOGLE_HEADERS = {
  'x-goog-channel-id': 'channel-1',
  'x-goog-resource-state': 'exists',
  'x-goog-resource-id': 'resource-1',
};

test('google webhook requires a matching channel token when one is configured', async () => {
  const originalToken = process.env.GOOGLE_WEBHOOK_TOKEN;
  process.env.GOOGLE_WEBHOOK_TOKEN = 'webhook-token';

  let processed = 0;
  const router = buildWebhookRouter({
    handleWebhook: async () => {
      processed += 1;
    },
  });

  try {
    // Missing token: acknowledged but not processed.
    const missing = await invokeRoute(router, 'post', '/google', {
      headers: { ...GOOGLE_HEADERS },
    });
    assert.equal(missing.statusCode, 200);
    assert.equal(processed, 0);

    // Mismatched token: acknowledged but not processed.
    const mismatched = await invokeRoute(router, 'post', '/google', {
      headers: { ...GOOGLE_HEADERS, 'x-goog-channel-token': 'wrong-token' },
    });
    assert.equal(mismatched.statusCode, 200);
    assert.equal(processed, 0);

    // Matching token: processed.
    const matched = await invokeRoute(router, 'post', '/google', {
      headers: { ...GOOGLE_HEADERS, 'x-goog-channel-token': 'webhook-token' },
    });
    assert.equal(matched.statusCode, 200);
    assert.equal(processed, 1);
  } finally {
    restoreEnv('GOOGLE_WEBHOOK_TOKEN', originalToken);
  }
});

test('google webhook processes notifications when no token is configured', async () => {
  const originalToken = process.env.GOOGLE_WEBHOOK_TOKEN;
  delete process.env.GOOGLE_WEBHOOK_TOKEN;

  let processed = 0;
  const router = buildWebhookRouter({
    handleWebhook: async () => {
      processed += 1;
    },
  });

  try {
    const response = await invokeRoute(router, 'post', '/google', {
      headers: { ...GOOGLE_HEADERS },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(processed, 1);
  } finally {
    restoreEnv('GOOGLE_WEBHOOK_TOKEN', originalToken);
  }
});

test('internal renew endpoint passes force flag through to the renewal check', async () => {
  const originalToken = process.env.INTERNAL_CRON_TOKEN;
  process.env.INTERNAL_CRON_TOKEN = 'cron-token';

  const forcedCalls: boolean[] = [];
  const router = buildWebhookRouter({
    runRenewalCheck: async (options?: { force?: boolean }) => {
      forcedCalls.push(Boolean(options?.force));
    },
  });

  try {
    const handler = findRouteHandler(router, 'post', '/internal/renew');
    const makeRes = () => ({
      statusCode: 200,
      payload: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.payload = payload;
        return this;
      },
    });

    const baseReq = {
      headers: { authorization: 'Bearer cron-token' },
      body: {},
    };

    const plainRes = makeRes();
    await handler({ ...baseReq, query: {} }, plainRes, () => {});
    assert.equal(plainRes.statusCode, 200);

    const forcedRes = makeRes();
    await handler({ ...baseReq, query: { force: 'true' } }, forcedRes, () => {});
    assert.equal(forcedRes.statusCode, 200);

    assert.deepEqual(forcedCalls, [false, true]);
  } finally {
    restoreEnv('INTERNAL_CRON_TOKEN', originalToken);
  }
});
