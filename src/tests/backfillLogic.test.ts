import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackfillDirectionContexts,
  buildDestinationAccountUpdate,
  isBackfillRunStale,
} from '../services/backfillLogic';

const sync = {
  googleAccountId: 'legacy',
  sourceGoogleAccountId: 'source-account',
  targetGoogleAccountId: 'target-account',
  sourceCalendarId: 'source-calendar',
  targetCalendarId: 'target-calendar',
  isTwoWay: true,
};

test('two-way backfill resolves both directions with reversed accounts and calendars', () => {
  assert.deepEqual(buildBackfillDirectionContexts(sync), [
    {
      direction: 'source_to_target',
      sourceCalendarId: 'source-calendar',
      targetCalendarId: 'target-calendar',
      sourceGoogleAccountId: 'source-account',
      targetGoogleAccountId: 'target-account',
    },
    {
      direction: 'target_to_source',
      sourceCalendarId: 'target-calendar',
      targetCalendarId: 'source-calendar',
      sourceGoogleAccountId: 'target-account',
      targetGoogleAccountId: 'source-account',
    },
  ]);
});

test('one-way backfill retains source-to-target behavior only', () => {
  assert.equal(buildBackfillDirectionContexts({ ...sync, isTwoWay: false }).length, 1);
});

test('backfill runs become restartable after the stale threshold', () => {
  const now = new Date('2026-08-14T12:00:00Z');
  assert.equal(isBackfillRunStale(new Date('2026-08-14T10:00:01Z'), now, 2 * 60 * 60 * 1000), false);
  assert.equal(isBackfillRunStale(new Date('2026-08-14T10:00:00Z'), now, 2 * 60 * 60 * 1000), true);
  assert.equal(isBackfillRunStale(null, now, 2 * 60 * 60 * 1000), true);
});

test('account recovery updates the destination side for each direction', () => {
  assert.deepEqual(buildDestinationAccountUpdate('source_to_target', 'target-account'), {
    targetGoogleAccountId: 'target-account',
  });
  assert.deepEqual(buildDestinationAccountUpdate('target_to_source', 'source-account'), {
    sourceGoogleAccountId: 'source-account',
  });
});
