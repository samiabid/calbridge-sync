import test from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { buildSyncEventsRouter } from '../routes/syncEvents';

interface MockResponse {
  statusCode: number;
  payload: unknown;
  redirectedTo: string | null;
  headersSent: boolean;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
  send: (payload: unknown) => MockResponse;
  redirect: (location: string) => MockResponse;
}

function findRoute(router: Router, method: string, path: string) {
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

  return layer.route.stack.map((item: any) => item.handle);
}

async function invokeRoute(
  router: Router,
  method: string,
  path: string,
  options: {
    session?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  } = {}
) {
  const handlers = findRoute(router, method, path);
  const req: any = {
    method: method.toUpperCase(),
    path,
    url: path,
    session: options.session || {},
    query: options.query || {},
    body: options.body || {},
    params: options.params || {},
    headers: {},
  };

  const res: MockResponse = {
    statusCode: 200,
    payload: null,
    redirectedTo: null,
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
    redirect(location: string) {
      this.statusCode = 302;
      this.redirectedTo = location;
      this.headersSent = true;
      return this;
    },
  };

  for (const handler of handlers) {
    let nextCalled = false;
    await new Promise<void>((resolve, reject) => {
      const next = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        nextCalled = true;
        resolve();
      };

      Promise.resolve(handler(req, res, next))
        .then(() => {
          if (!nextCalled) {
            resolve();
          }
        })
        .catch(reject);
    });

    if (res.headersSent || !nextCalled) {
      break;
    }
  }

  return res;
}

test('event routes reject unauthorized requests through auth middleware', async () => {
  const router = buildSyncEventsRouter({ authMiddleware: requireAuth });
  const response = await invokeRoute(router, 'get', '/:id/events', {
    params: { id: 'sync-1' },
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.redirectedTo, '/');
});

test('event list route returns the dashboard payload for authorized requests', async () => {
  const router = buildSyncEventsRouter({
    authMiddleware: (_req, _res, next) => next(),
    listEvents: async (_syncId, _userId, options = {}) => ({
      syncId: 'sync-1',
      syncLabel: 'Source -> Target',
      isTwoWay: true,
      direction: 'all',
      window: {
        daysBack: 30,
        daysForward: 365,
        timeMin: '2026-02-14T00:00:00.000Z',
        timeMax: '2027-03-15T00:00:00.000Z',
      },
      page: Number(options.page || 1),
      pageSize: Number(options.pageSize || 25),
      total: 1,
      totalPages: 1,
      items: [
        {
          direction: 'source_to_target',
          sourceEventId: 'event-1',
          sourceCalendarId: 'source-cal',
          targetCalendarId: 'target-cal',
          sourceGoogleAccountId: 'acct-source',
          targetGoogleAccountId: 'acct-target',
          summary: 'Planning',
          location: null,
          start: { dateTime: '2026-03-16T10:00:00.000Z' },
          end: { dateTime: '2026-03-16T11:00:00.000Z' },
          isAllDay: false,
          sourceStatus: 'confirmed',
          status: 'synced',
          statusReason: 'Synced to target-1.',
          targetEventId: 'target-1',
          lastSyncedAt: '2026-03-15T10:00:00.000Z',
          failureId: null,
        },
      ],
    }),
  });

  const response = await invokeRoute(router, 'get', '/:id/events', {
    session: { userId: 'user-1' },
    params: { id: 'sync-1' },
    query: { page: '2', pageSize: '50' },
  });
  const body = response.payload as any;

  assert.equal(response.statusCode, 200);
  assert.equal(body.syncId, 'sync-1');
  assert.equal(body.page, 2);
  assert.equal(body.pageSize, 50);
  assert.equal(body.items[0].status, 'synced');
});

test('force sync route returns the refreshed event item', async () => {
  const router = buildSyncEventsRouter({
    authMiddleware: (_req, _res, next) => next(),
    forceSyncEvent: async (_syncId, _userId, input) => ({
      syncId: 'sync-1',
      item: {
        direction: input.direction as 'source_to_target',
        sourceEventId: input.sourceEventId,
        sourceCalendarId: input.sourceCalendarId || 'source-cal',
        targetCalendarId: 'target-cal',
        sourceGoogleAccountId: 'acct-source',
        targetGoogleAccountId: 'acct-target',
        summary: 'Planning',
        location: null,
        start: { dateTime: '2026-03-16T10:00:00.000Z' },
        end: { dateTime: '2026-03-16T11:00:00.000Z' },
        isAllDay: false,
        sourceStatus: 'confirmed',
        status: 'skipped',
        statusReason: 'Event matches excluded keyword "private".',
        targetEventId: null,
        lastSyncedAt: null,
        failureId: null,
      },
    }),
  });

  const response = await invokeRoute(router, 'post', '/:id/events/force-sync', {
    session: { userId: 'user-1' },
    params: { id: 'sync-1' },
    body: {
      direction: 'source_to_target',
      sourceEventId: 'event-1',
      sourceCalendarId: 'source-cal',
    },
  });
  const body = response.payload as any;

  assert.equal(response.statusCode, 200);
  assert.equal(body.success, true);
  assert.equal(body.item.sourceEventId, 'event-1');
  assert.equal(body.item.status, 'skipped');
});
