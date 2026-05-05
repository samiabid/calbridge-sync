import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccessControlSummary,
  isGoogleAccountEmailAllowed,
  isLoginEmailAllowed,
  normalizeEmail,
  parseAllowedEmails,
} from '../config/accessControl';

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

test('email allowlist parsing normalizes case, whitespace, and duplicates', () => {
  assert.equal(normalizeEmail(' Hello@Pointillist.ORG '), 'hello@pointillist.org');
  assert.deepEqual(
    parseAllowedEmails(' Hello@Pointillist.ORG, sami@solvaa.co.uk;hello@pointillist.org '),
    ['hello@pointillist.org', 'sami@solvaa.co.uk']
  );
});

test('production login allowlist blocks missing and non-matching emails', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: undefined,
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: undefined,
    },
    () => {
      assert.equal(isLoginEmailAllowed('hello@pointillist.org'), false);
      assert.equal(getAccessControlSummary().accessControlConfigured, false);
    }
  );

  withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    () => {
      assert.equal(isLoginEmailAllowed('HELLO@POINTILLIST.ORG'), true);
      assert.equal(isLoginEmailAllowed('intruder@example.com'), false);
      assert.equal(getAccessControlSummary().accessControlConfigured, true);
    }
  );
});

test('connected account allowlist is separate from login allowlist', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      ALLOWED_LOGIN_EMAILS: 'hello@pointillist.org',
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: 'hello@pointillist.org,sami@solvaa.co.uk',
    },
    () => {
      assert.equal(isLoginEmailAllowed('sami@solvaa.co.uk'), false);
      assert.equal(isGoogleAccountEmailAllowed('sami@solvaa.co.uk'), true);
      assert.equal(isGoogleAccountEmailAllowed('other@example.com'), false);
    }
  );
});

test('development remains open when allowlists are not configured', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      ALLOWED_LOGIN_EMAILS: undefined,
      ALLOWED_GOOGLE_ACCOUNT_EMAILS: undefined,
    },
    () => {
      assert.equal(isLoginEmailAllowed('dev@example.com'), true);
      assert.equal(isGoogleAccountEmailAllowed('dev@example.com'), true);
      assert.equal(getAccessControlSummary().accessControlConfigured, true);
    }
  );
});
