import test from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimitError, withRateLimitRetry } from '../services/rateLimit';

test('rate-limit detection covers 429 and Google quota reasons without masking normal 403s', () => {
  assert.equal(isRateLimitError({ response: { status: 429 } }), true);
  assert.equal(
    isRateLimitError({
      response: {
        status: 403,
        data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } },
      },
    }),
    true
  );
  assert.equal(isRateLimitError({ response: { status: 403 }, message: 'Forbidden' }), false);
});

test('rate-limit retry eventually succeeds without retrying unrelated errors', async () => {
  const originalInterval = process.env.GOOGLE_API_MIN_INTERVAL_MS;
  process.env.GOOGLE_API_MIN_INTERVAL_MS = '0';
  try {
    let attempts = 0;
    const result = await withRateLimitRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw { response: { status: 429 } };
        return 'ok';
      },
      'test retry',
      { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 }
    );
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);

    await assert.rejects(
      withRateLimitRetry(
        async () => {
          throw new Error('permission denied');
        },
        'test non-rate-limit',
        { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 }
      ),
      /permission denied/
    );
  } finally {
    if (originalInterval === undefined) delete process.env.GOOGLE_API_MIN_INTERVAL_MS;
    else process.env.GOOGLE_API_MIN_INTERVAL_MS = originalInterval;
  }
});
