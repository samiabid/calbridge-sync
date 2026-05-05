import test from 'node:test';
import assert from 'node:assert/strict';
import authRouter from '../routes/auth';

function findRouteHandler(method: string, path: string) {
  const layer = (authRouter as any).stack.find(
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

test('Google auth route creates state and redirects with narrowed scopes', async () => {
  await withEnv(
    {
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://calendar.samiabid.com/auth/google/callback',
    },
    async () => {
      const handler = findRouteHandler('get', '/google');
      const session: Record<string, unknown> = {};
      let redirectedTo = '';
      const req: any = { session };
      const res: any = {
        redirect(location: string) {
          redirectedTo = location;
        },
      };

      await handler(req, res);

      const url = new URL(redirectedTo);
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

