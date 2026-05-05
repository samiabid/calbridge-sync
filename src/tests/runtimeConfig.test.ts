import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_PUBLIC_URL,
  assertProductionRuntimeConfig,
  getGoogleRedirectUri,
  getPublicBaseUrl,
  getRuntimeConfigSummary,
} from '../config/runtime';

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

test('runtime config derives canonical Google redirect URI from PUBLIC_URL', () => {
  withEnv(
    {
      PUBLIC_URL: 'https://calendar.samiabid.com/',
      GOOGLE_REDIRECT_URI: undefined,
    },
    () => {
      assert.equal(getPublicBaseUrl(), CANONICAL_PUBLIC_URL);
      assert.equal(
        getGoogleRedirectUri(),
        'https://calendar.samiabid.com/auth/google/callback'
      );
      assert.equal(getRuntimeConfigSummary().canonicalPublicUrlConfigured, true);
    }
  );
});

test('explicit Google redirect URI overrides derived redirect URI', () => {
  withEnv(
    {
      PUBLIC_URL: 'https://calendar.samiabid.com',
      GOOGLE_REDIRECT_URI: 'https://override.example.com/auth/google/callback',
    },
    () => {
      assert.equal(getGoogleRedirectUri(), 'https://override.example.com/auth/google/callback');
    }
  );
});

test('production runtime config fails fast when Google credentials are missing', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      SESSION_SECRET: 'secret',
      PUBLIC_URL: 'https://calendar.samiabid.com',
      GOOGLE_REDIRECT_URI: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    },
    () => {
      assert.throws(
        () => assertProductionRuntimeConfig(),
        /GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/
      );
    }
  );
});

