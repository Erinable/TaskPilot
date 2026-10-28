import { test } from 'vitest';
import assert from 'node:assert/strict';

import { BackgroundRuns } from '../../../src/main/app/background_runs.ts';

test('a registered run is listed, cancelled and waited for without any other wiring', async () => {
  const runs = new BackgroundRuns();
  const controller = runs.start({ kind: 'grade', key: 'pkg-1', busy: 'grade', label: () => '登录' });
  let settled = false;
  runs.track(
    new Promise<void>((resolve) =>
      controller.signal.addEventListener('abort', () =>
        setTimeout(() => {
          settled = true;
          resolve();
        }, 5),
      ),
    ),
  );
  assert.deepEqual(runs.busy(), [{ kind: 'grade', label: '登录' }]);
  await runs.cancelAll();
  assert.equal(controller.signal.aborted, true);
  assert.equal(settled, true, 'cancelAll returned before the run settled');
});

test('cancelAll also waits for a run that a settling run starts', async () => {
  const runs = new BackgroundRuns();
  let followUpSettled = false;
  const followUp = () =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        followUpSettled = true;
        resolve();
      }, 5),
    );
  runs.track(new Promise<void>((resolve) => setTimeout(resolve, 1)).then(() => runs.track(followUp())));
  await runs.cancelAll();
  assert.equal(followUpSettled, true, 'cancelAll returned before the follow-up run settled');
});

test('idle waits for chained runs without aborting them', async () => {
  const runs = new BackgroundRuns();
  const controller = runs.start({ kind: 'coding', key: 'pkg-1', busy: 'coding', label: () => '登录' });
  let followUpSettled = false;
  const followUp = Promise.resolve().then(() => {
    followUpSettled = true;
  });
  runs.track(Promise.resolve().then(() => runs.track(followUp)));
  await runs.idle();
  assert.equal(controller.signal.aborted, false);
  assert.equal(followUpSettled, true);
});

test('busy lists runs in a fixed order and folds once-listed kinds; work lists only agent runs', () => {
  const runs = new BackgroundRuns();
  let title = '';
  runs.start({ kind: 'note-summary', key: 'a', busy: 'tutor', label: () => '笔记总结', once: true });
  runs.start({ kind: 'note-summary', key: 'b', busy: 'tutor', label: () => '笔记总结', once: true });
  runs.start({ kind: 'baseline', key: 'pkg', busy: 'baseline', label: () => '基线' });
  runs.start({ kind: 'requirement', key: 'r1', busy: 'requirement', agent: () => 'product-lead', label: () => title || 'r1' });
  title = '登录';
  assert.deepEqual(runs.busy(), [
    { kind: 'requirement', label: '登录' },
    { kind: 'baseline', label: '基线' },
    { kind: 'tutor', label: '笔记总结' },
  ]);
  assert.deepEqual(runs.work(), [{ agent: 'product-lead', kind: 'requirement', label: '登录' }]);
});

test('finish drops a run only for the controller that started it', () => {
  const runs = new BackgroundRuns();
  const first = runs.start({ kind: 'baseline', key: 'pkg', busy: 'baseline', label: () => 'pkg' });
  const second = runs.start({ kind: 'baseline', key: 'pkg', busy: 'baseline', label: () => 'pkg' });
  runs.finish('baseline', 'pkg', first);
  assert.equal(runs.get('baseline', 'pkg'), second);
  runs.finish('baseline', 'pkg', second);
  assert.equal(runs.has('baseline', 'pkg'), false);
  assert.deepEqual(runs.keys('baseline'), []);
});
