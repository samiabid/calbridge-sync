import assert from 'node:assert/strict';
import test from 'node:test';
import { logInfo } from '../services/logger';
import { runWithRequestContext } from '../services/requestContext';

function captureConsoleLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('logInfo emits single-line JSON with level, message, and fields', () => {
  const lines = captureConsoleLog(() => {
    logInfo('test_event', { syncId: 'sync-1', count: 3 });
  });

  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.level, 'info');
  assert.equal(payload.message, 'test_event');
  assert.equal(payload.syncId, 'sync-1');
  assert.equal(payload.count, 3);
  assert.ok(typeof payload.timestamp === 'string');
});

test('logInfo merges requestId from AsyncLocalStorage request context', () => {
  const lines = captureConsoleLog(() => {
    runWithRequestContext({ requestId: 'req-abc' }, () => {
      logInfo('test_event_with_context');
    });
  });

  const payload = JSON.parse(lines[0]);
  assert.equal(payload.requestId, 'req-abc');
});

test('requestId propagates across async boundaries within the context', async () => {
  let lines: string[] = [];
  await runWithRequestContext({ requestId: 'req-async' }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    lines = captureConsoleLog(() => {
      logInfo('test_event_async');
    });
  });

  const payload = JSON.parse(lines[0]);
  assert.equal(payload.requestId, 'req-async');
});

test('logInfo omits requestId outside any request context', () => {
  const lines = captureConsoleLog(() => {
    logInfo('test_event_no_context');
  });

  const payload = JSON.parse(lines[0]);
  assert.equal('requestId' in payload, false);
});

test('undefined fields are dropped from the payload', () => {
  const lines = captureConsoleLog(() => {
    logInfo('test_event_undefined', { present: 'yes', absent: undefined });
  });

  const payload = JSON.parse(lines[0]);
  assert.equal(payload.present, 'yes');
  assert.equal('absent' in payload, false);
});
