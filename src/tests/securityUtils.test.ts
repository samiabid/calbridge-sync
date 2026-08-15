import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual, hasValidInternalToken } from '../utils/security';
import { serializeJsonForScript } from '../utils/serializeForScript';

test('safeEqual matches equal strings and rejects others', () => {
  assert.equal(safeEqual('token-abc', 'token-abc'), true);
  assert.equal(safeEqual('token-abc', 'token-abd'), false);
  assert.equal(safeEqual('short', 'much-longer-value'), false);
  assert.equal(safeEqual('', ''), true);
});

test('hasValidInternalToken accepts bearer and header tokens, rejects otherwise', () => {
  const token = 'internal-token';
  assert.equal(
    hasValidInternalToken({ headers: { authorization: `Bearer ${token}` } }, token),
    true
  );
  assert.equal(hasValidInternalToken({ headers: { 'x-internal-token': token } }, token), true);
  assert.equal(hasValidInternalToken({ headers: { 'x-internal-token': 'wrong' } }, token), false);
  assert.equal(hasValidInternalToken({ headers: {} }, token), false);
  assert.equal(hasValidInternalToken({ headers: { 'x-internal-token': token } }, undefined), false);
});

test('serializeJsonForScript escapes script breakout and line separators', () => {
  const payload = { summary: '</script><script>alert(1)</script>' };
  const serialized = serializeJsonForScript(payload);

  assert.equal(serialized.includes('</script>'), false);
  assert.equal(serialized.includes('\\u003c'), true);
  // The escapes are valid JSON, so the value round-trips unchanged.
  assert.deepEqual(JSON.parse(serialized), payload);

  const withSeparators = serializeJsonForScript({ text: 'a\u2028b\u2029c' });
  assert.equal(withSeparators.includes('\u2028'), false);
  assert.equal(withSeparators.includes('\u2029'), false);
  assert.equal(withSeparators.includes('\\u2028'), true);
  assert.equal(withSeparators.includes('\\u2029'), true);
  assert.deepEqual(JSON.parse(withSeparators), { text: 'a\u2028b\u2029c' });
});
