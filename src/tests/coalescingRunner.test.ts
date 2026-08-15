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

test('drain waits for active webhook work and reports a timeout safely', async () => {
  const runner = new CoalescingRunner();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = runner.run('sync:source', () => gate);

  assert.equal(await runner.drain(5), false);
  release();
  await run;
  assert.equal(await runner.drain(50), true);
});
