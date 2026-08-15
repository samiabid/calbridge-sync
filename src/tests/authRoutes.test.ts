import test from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from 'express';
import { buildAuthRouter } from '../routes/auth';
import { PRIVATE_APP_AUTH_MESSAGE } from '../config/accessControl';

function findRouteLayer(router: Router, method: string, path: string) {
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

  return layer;
}

async function invokeRoute(
  router: Router,
  method: string,
  path: string,
  req: any,
  res: any
) {
  const layer = findRouteLayer(router, method, path);
  const stack = layer.route.stack.map((entry: any) => entry.handle);
  let index = 0;

  async function next(error?: unknown): Promise<void> {
    if (error) throw error;
    const handler = stack[index++];
    if (!handler || res.headersSent) return;
    await Promise.resolve(handler(req, res, next));
  }

  await next();
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null as unknown,
    redirectedTo: '',
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      this.headersSent = true;
      return this;
    },
    redirect(location: string) {
      this.redirectedTo = location;
      this.headersSent = true;
      return this;
    },
  };
}

function withEnv(values: Record<string, string | undefined>, callback: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};

  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  return callback().finally(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });
}

function createTestRouter(options: {
  email?: string;
  tokens?: Record<string, string>;
  prisma?: any;
}) {
  const tokens = options.tokens || {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
  };

  return buildAuthRouter({
    prisma:
      options.prisma ||
      {
        user: {
          findUnique: async () => null,
          update: async () => null,
          create: async () => ({ id: 'created-user' }),
        },
        googleAccount: {
          findUnique: async () => null,
          upsert: async () => null,
          update: async () => null,
        },
        sync: {
          updateMany: async () => ({ count: 0 }),
        },
      },
    createOAuth2Client: () => ({
      getToken: async () => ({ tokens }),
      setCredentials: () => undefined,
    } as any),
    getOAuthUserInfo: async () => ({ email: options.email || 'hello@pointillist.org' }),
    getAuthUrl: (state: string, opts?: { forceConsent?: boolean; loginHint?: string }) => {
      const url = new URL('https://accounts.example.test/oauth');
      url.searchParams.set('state', state);
      if (opts?.forceConsent) url.searchParams.set('prompt', 'consent');
      if (opts?.loginHint) url.searchParams.set('login_hint', opts.loginHint);
      return url.toString();
    },
    getRedirectUri: () => 'https://calendar.samiabid.com/auth/google/callback',
    encryptToken: (token: string) => `encrypted:${token}`,
    decryptToken: (token: string) => token.replace(/^encrypted:/, ''),
    logInfo: () => undefined,
    logWarn: () => undefined,
    logError: () => undefined,
  });
}

function callbackRequest(session: Record<string, unknown> = {}): any {
  return {
    query: { code: 'oauth-code', state: 'state-1' },
    session: {
      oauthState: 'state-1',
      oauthStateCreatedAt: Date.now(),
      destroy: (callback: () => void) => callback(),
      ...session,
    },
  };
}

test('Google auth route creates state and redirects with narrowed scopes', async () => {
  await withEnv(
    {
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://calendar.samiabid.com/auth/google/callback',
    },
    async () => {
      const router = buildAuthRouter();
      const session: Record<string, unknown> = {};
      const req: any = { session };
      const res = createResponse();

      await invokeRoute(router, 'get', '/google', req, res);

      const url = new URL(res.redirectedTo);
      const scopes = new Set((url.searchParams.get('scope') || '').split(' '));
      assert.equal(typeof session.oauthState, 'string');
      assert.equal(url.searchParams.get('state'), session.oauthState);
      assert.equal(url.searchParams.get('prompt'), null);
      assert.equal(scopes.has('https://www.googleapis.com/auth/calendar.events'), true);
      assert.equal(
        scopes.has('https://www.googleapis.com/auth/calendar.calendarlist.readonly'),
        true
      );
      assert.equal(scopes.has('https://www.googleapis.com/auth/calendar'), false);
    }
  );
});

test('OAuth callback creates a user for an allowlisted login email', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    async () => {
      let createdEmail = '';
      const router = createTestRouter({
        email: ' Hello@Pointillist.org ',
        prisma: {
          user: {
            findUnique: async () => null,
            update: async () => null,
            create: async (args: any) => {
              createdEmail = args.data.email;
              return { id: 'user-1' };
            },
          },
          googleAccount: {
            findUnique: async () => null,
            upsert: async () => null,
            update: async () => null,
          },
        },
      });
      const req = callbackRequest();
      const res = createResponse();

      await invokeRoute(router, 'get', '/google/callback', req, res);

      assert.equal(res.redirectedTo, '/dashboard');
      assert.equal(req.session.userId, 'user-1');
      assert.equal(createdEmail, 'hello@pointillist.org');
    }
  );
});

test('OAuth callback blocks new-user creation for a non-allowlisted login email', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    async () => {
      let userLookupCalls = 0;
      const router = createTestRouter({
        email: 'intruder@example.com',
        prisma: {
          user: {
            findUnique: async () => {
              userLookupCalls += 1;
              return null;
            },
            update: async () => null,
            create: async () => {
              throw new Error('user create should not be called');
            },
          },
          googleAccount: {
            findUnique: async () => null,
            upsert: async () => null,
            update: async () => null,
          },
        },
      });
      const req = callbackRequest();
      const res = createResponse();

      await invokeRoute(router, 'get', '/google/callback', req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.payload, PRIVATE_APP_AUTH_MESSAGE);
      assert.equal(userLookupCalls, 0);
      assert.equal(req.session.userId, undefined);
    }
  );
});

test('OAuth callback blocks an existing-user login when the email is not allowlisted', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    async () => {
      const router = createTestRouter({
        email: 'former-user@example.com',
        prisma: {
          user: {
            findUnique: async () => ({ id: 'former-user', email: 'former-user@example.com' }),
            update: async () => {
              throw new Error('user update should not be called');
            },
            create: async () => {
              throw new Error('user create should not be called');
            },
          },
          googleAccount: {
            findUnique: async () => null,
            upsert: async () => {
              throw new Error('account upsert should not be called');
            },
            update: async () => null,
          },
        },
      });
      const req = callbackRequest();
      const res = createResponse();

      await invokeRoute(router, 'get', '/google/callback', req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.payload, PRIVATE_APP_AUTH_MESSAGE);
    }
  );
});

test('OAuth callback blocks login when the primary Google account is not connectable', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'sami@solvaa.co.uk',
    },
    async () => {
      let userLookupCalls = 0;
      const router = createTestRouter({
        email: 'hello@pointillist.org',
        prisma: {
          user: {
            findUnique: async () => {
              userLookupCalls += 1;
              return null;
            },
            update: async () => null,
            create: async () => {
              throw new Error('user create should not be called');
            },
          },
          googleAccount: {
            findUnique: async () => null,
            upsert: async () => {
              throw new Error('account upsert should not be called');
            },
            update: async () => null,
          },
        },
      });
      const req = callbackRequest();
      const res = createResponse();

      await invokeRoute(router, 'get', '/google/callback', req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.payload, PRIVATE_APP_AUTH_MESSAGE);
      assert.equal(userLookupCalls, 0);
    }
  );
});

test('logged-in add-account allows allowlisted connected Google accounts', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    async () => {
      let upsertDisplayName = '';
      let detectionResetWhere: any = null;
      const router = createTestRouter({
        email: 'sami@solvaa.co.uk',
        prisma: {
          user: {
            findUnique: async () => ({ id: 'user-1', email: 'hello@pointillist.org' }),
            update: async () => null,
            create: async () => null,
          },
          googleAccount: {
            findUnique: async () => null,
            upsert: async (args: any) => {
              upsertDisplayName = args.create.displayName;
              return null;
            },
            update: async () => null,
          },
          sync: {
            updateMany: async (args: any) => {
              detectionResetWhere = args.where;
              return { count: 1 };
            },
          },
        },
      });
      const req = callbackRequest({ userId: 'user-1' });
      const res = createResponse();

      await invokeRoute(router, 'get', '/google/callback', req, res);

      assert.equal(res.redirectedTo, '/dashboard');
      assert.equal(upsertDisplayName, 'sami@solvaa.co.uk');
      // Connecting an account resets stuck account detection for the user.
      assert.deepEqual(detectionResetWhere, {
        userId: 'user-1',
        accountDetectionAttempts: { gt: 0 },
      });
    }
  );
});

test('logged-in add-account blocks non-allowlisted connected Google accounts', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    async () => {
      let accountLookupCalls = 0;
      const router = createTestRouter({
        email: 'random@example.com',
        prisma: {
          user: {
            findUnique: async () => ({ id: 'user-1', email: 'hello@pointillist.org' }),
            update: async () => null,
            create: async () => null,
          },
          googleAccount: {
            findUnique: async () => {
              accountLookupCalls += 1;
              return null;
            },
            upsert: async () => {
              throw new Error('account upsert should not be called');
            },
            update: async () => null,
          },
        },
      });
      const req = callbackRequest({ userId: 'user-1' });
      const res = createResponse();

      await invokeRoute(router, 'get', '/google/callback', req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.payload, PRIVATE_APP_AUTH_MESSAGE);
      assert.equal(accountLookupCalls, 0);
    }
  );
});

test('reauth start rejects a connected account that is no longer allowlisted', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    async () => {
      const router = createTestRouter({
        prisma: {
          googleAccount: {
            findUnique: async () => ({
              id: 'acct-1',
              userId: 'user-1',
              displayName: 'retired@example.com',
            }),
            upsert: async () => null,
            update: async () => null,
          },
          user: {
            findUnique: async () => null,
            update: async () => null,
            create: async () => null,
          },
        },
      });
      const req: any = {
        params: { accountId: 'acct-1' },
        session: { userId: 'user-1' },
      };
      const res = createResponse();

      await invokeRoute(router, 'get', '/google/reauth/:accountId', req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.payload, PRIVATE_APP_AUTH_MESSAGE);
      assert.equal(res.redirectedTo, '');
    }
  );
});
