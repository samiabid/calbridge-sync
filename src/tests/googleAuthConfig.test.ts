import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPES, getAuthUrl } from '../config/google';

function withEnv(values: Record<string, string | undefined>, callback: () => void) {
  const previous: Record<string, string | undefined> = {};

  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  try {
    callback();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test('Google OAuth scopes use narrowed Calendar access', () => {
  assert.deepEqual(SCOPES, [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
  assert.equal(SCOPES.includes('https://www.googleapis.com/auth/calendar'), false);
});

test('normal auth URL uses offline access without forced consent', () => {
  withEnv(
    {
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://calendar.samiabid.com/auth/google/callback',
    },
    () => {
      const url = new URL(getAuthUrl('state-123'));
      const scopes = new Set((url.searchParams.get('scope') || '').split(' '));

      assert.equal(url.searchParams.get('access_type'), 'offline');
      assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
      assert.equal(url.searchParams.get('state'), 'state-123');
      assert.equal(url.searchParams.has('prompt'), false);
      assert.equal(scopes.has('https://www.googleapis.com/auth/calendar.events'), true);
      assert.equal(
        scopes.has('https://www.googleapis.com/auth/calendar.calendarlist.readonly'),
        true
      );
      assert.equal(scopes.has('https://www.googleapis.com/auth/calendar'), false);
    }
  );
});

test('reauth URL can force consent and include login hint', () => {
  withEnv(
    {
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://calendar.samiabid.com/auth/google/callback',
    },
    () => {
      const url = new URL(
        getAuthUrl('state-456', {
          forceConsent: true,
          loginHint: 'sami@solvaa.co.uk',
        })
      );

      assert.equal(url.searchParams.get('prompt'), 'consent');
      assert.equal(url.searchParams.get('login_hint'), 'sami@solvaa.co.uk');
    }
  );
});

