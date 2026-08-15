import test from 'node:test';
import assert from 'node:assert/strict';
import { CoalescingRunner } from '../services/coalescingRunner';

test('notifications received during a run are coalesced into one follow-up pass', async () => {
  const runner = new CoalescingRunner();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let runs = 0;
  const task = async () => {
    runs += 1;
    if (runs === 1) await firstGate;
  };

  const first = runner.run('sync:source', task);
  const second = runner.run('sync:source', task);
  const third = runner.run('sync:source', task);
  releaseFirst();
  await Promise.all([first, second, third]);

  assert.equal(runs, 2);
});
