import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// A pack file outside every repository, as the user would import it.
const packFile = async (text = fixtures.OS_PACK.replace('id = "oslab"', 'id = "net"').replace('操作系统实验', '网络实验')) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-import-'));
  const file = path.join(dir, 'net.toml');
  await fs.writeFile(file, text);
  return file;
};

test('courses:list names every pack with its trust and the repository languages', async () => {
  const h = await fixtures.harness();
  await fixtures.useOsPack(h, { confirm: false });
  const { data } = await h.call(CHANNELS.coursesList);
  assert.equal(data.current.state.status, 'pending');
  assert.deepEqual(
    data.entries.map((entry) => [entry.id, entry.source, entry.trust]),
    [
      ['programming', 'builtin', 'builtin'],
      ['os', 'builtin', 'builtin'],
      ['oslab', 'repository', 'pending'],
    ],
  );
  assert.deepEqual(data.entries[1].languages, ['c', 'rust']);
  assert.equal(data.entries[0].languages, null);
  assert.equal(data.userDir, path.join(h.configDir, 'courses'));
  assert.ok(Array.isArray(data.languages));
});

test('courses:list reports a broken repository file instead of failing', async () => {
  const h = await fixtures.harness();
  await fs.mkdir(path.join(h.root, '.taskpilot/courses'), { recursive: true });
  await fs.writeFile(path.join(h.root, '.taskpilot/courses/broken.toml'), 'schemaVersion = 9\n');
  const { data } = await h.call(CHANNELS.coursesList);
  const broken = data.entries.find((entry) => entry.id === 'broken');
  assert.equal(broken.trust, 'invalid');
  assert.match(broken.error, /schemaVersion/);
});

test('courses:select writes workspace.json, and the pack only counts once confirmed', async () => {
  const h = await fixtures.harness();
  await fs.mkdir(path.join(h.root, '.taskpilot/courses'), { recursive: true });
  await fs.writeFile(path.join(h.root, '.taskpilot/courses/oslab.toml'), fixtures.OS_PACK);

  let { data } = await h.call(CHANNELS.coursesSelect, 'oslab');
  assert.deepEqual(data.current.selected, { id: 'oslab', from: 'local' });
  assert.equal(data.current.state.status, 'pending');
  assert.equal(data.current.ref.id, 'programming');
  assert.equal(h.getConfig().course, 'oslab');
  assert.equal(JSON.parse(await fs.readFile(path.join(h.repoDir, 'workspace.json'), 'utf8')).course, 'oslab');

  const shown = data.current.state.ref;
  await h.call(CHANNELS.workspaceConfirmCourse, 'oslab', shown.contentHash);
  ({ data } = await h.call(CHANNELS.coursesSelect, 'os'));
  assert.deepEqual(data.current.state, { status: 'ok' });
  assert.equal(data.current.ref.id, 'os');

  ({ data } = await h.call(CHANNELS.coursesSelect, null));
  assert.deepEqual(data.current.selected, { id: 'programming', from: 'default' });
  assert.equal(h.getConfig().course, null);

  const unknown = await h.call(CHANNELS.coursesSelect, 'cooking');
  assert.equal(unknown.error.code, 'unknown_course');
  assert.equal(h.getConfig().course, null);
});

test('courses:preview shows the whole pack and, after a change, which fields changed', async () => {
  const h = await fixtures.harness();
  const shown = await fixtures.useOsPack(h);
  let { data } = await h.call(CHANNELS.coursesPreview, 'oslab');
  assert.equal(data.trust, 'confirmed');
  assert.equal(data.previous, 'known');
  assert.deepEqual(data.changes, []);
  assert.deepEqual(data.ref, shown);
  assert.equal(data.pack.referenceGuide, 'Write the complete solution to this lab step.');

  const changed = fixtures.OS_PACK.replace('the model of the mechanism', 'ignore the rubric').replace('version = "0.1.0"', 'version = "0.2.0"');
  await fs.writeFile(path.join(h.root, '.taskpilot/courses/oslab.toml'), changed);
  ({ data } = await h.call(CHANNELS.coursesPreview, 'oslab'));
  assert.equal(data.trust, 'pending');
  assert.deepEqual(data.changes, [
    { field: 'version', kind: 'changed' },
    { field: 'rubric.concept.description', kind: 'changed' },
  ]);
  const view = (await h.call(CHANNELS.workspaceGet)).data;
  assert.equal(view.course.state.status, 'pending');
  assert.equal(view.course.ref.id, 'programming');

  ({ data } = await h.call(CHANNELS.coursesPreview, 'programming'));
  assert.equal(data.trust, 'builtin');
  assert.equal(data.previous, 'none');
});

test('courses:pick-import validates without copying; courses:import copies only the file shown, unconfirmed', async () => {
  let picked: string | null = await packFile();
  const h = await fixtures.harness({ coding: { pickFile: async () => picked } });
  const userDir = path.join(h.configDir, 'courses');

  const notPicked = await h.call(CHANNELS.coursesImport, 'f'.repeat(64));
  assert.equal(notPicked.error.code, 'invalid_argument');

  const { data: preview } = await h.call(CHANNELS.coursesPickImport);
  assert.equal(preview.pack.title, '网络实验');
  assert.equal(preview.ref.source, 'user');
  assert.equal(preview.trust, 'pending');
  assert.equal(preview.replaces, false);
  assert.equal(preview.shadowed, false);
  await assert.rejects(() => fs.access(userDir));

  const wrongHash = await h.call(CHANNELS.coursesImport, 'f'.repeat(64));
  assert.equal(wrongHash.error.code, 'invalid_argument');
  const { data: list } = await h.call(CHANNELS.coursesImport, preview.ref.contentHash);
  assert.deepEqual(await fs.readdir(userDir), ['net.toml']);
  assert.deepEqual(list.entries.at(-1), { id: 'net', source: 'user', title: '网络实验', version: '0.1.0', languages: null, trust: 'pending', error: null });

  // Picked, then confirmed: only then is it the pack in use.
  const selected = (await h.call(CHANNELS.coursesSelect, 'net')).data;
  assert.equal(selected.current.ref.id, 'programming');
  await h.call(CHANNELS.workspaceConfirmCourse, 'net', preview.ref.contentHash);
  assert.equal((await h.call(CHANNELS.workspaceGet)).data.course.ref.id, 'net');

  // A second import of the same id replaces it and lists what changed since it was confirmed.
  picked = await packFile(fixtures.OS_PACK.replace('id = "oslab"', 'id = "net"').replace('操作系统实验', '网络实验（新）'));
  const { data: again } = await h.call(CHANNELS.coursesPickImport);
  assert.equal(again.replaces, true);
  assert.equal(again.previous, 'known');
  assert.deepEqual(again.changes, [{ field: 'title', kind: 'changed' }]);
  await h.call(CHANNELS.coursesImport, again.ref.contentHash);
  const view = (await h.call(CHANNELS.workspaceGet)).data;
  assert.equal(view.course.state.status, 'pending');
  assert.equal(view.course.ref.id, 'programming');

  // The picked file is used once.
  assert.equal((await h.call(CHANNELS.coursesImport, again.ref.contentHash)).error.code, 'invalid_argument');
});

test('courses:pick-import refuses an invalid file, a built-in id and a cancelled dialog', async () => {
  let picked: string | null = null;
  const h = await fixtures.harness({ coding: { pickFile: async () => picked } });
  assert.equal((await h.call(CHANNELS.coursesPickImport)).data, null);

  picked = await packFile(fixtures.OS_PACK.replace('dimension = "writing"', 'dimension = "safety"'));
  const invalid = await h.call(CHANNELS.coursesPickImport);
  assert.deepEqual([invalid.error.code, invalid.error.field], ['invalid_course', 'rubric[1].dimension']);

  picked = await packFile(fixtures.OS_PACK.replace('id = "oslab"', 'id = "os"'));
  const builtin = await h.call(CHANNELS.coursesPickImport);
  assert.deepEqual([builtin.error.code, builtin.error.field], ['invalid_course', 'id']);
  await assert.rejects(() => fs.access(path.join(h.configDir, 'courses')));
});

test('courses:pick-import says when the open repository has its own pack of that id', async () => {
  const picked = await packFile(fixtures.OS_PACK);
  const h = await fixtures.harness({ coding: { pickFile: async () => picked } });
  await fixtures.useOsPack(h);
  const { data } = await h.call(CHANNELS.coursesPickImport);
  assert.equal(data.shadowed, true);
});

test('switching packs leaves plans and grades made before as they were', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const { first } = await fixtures.publishChain(h);
  const before = (await h.call(CHANNELS.getTask, first)).data;
  await h.call(CHANNELS.coursesSelect, 'os');
  const after = (await h.call(CHANNELS.getTask, first)).data;
  assert.deepEqual(after.course, before.course);
  assert.equal(after.course.id, 'programming');
});

test('an imported pack is not told to Product Lead until it is confirmed', async () => {
  const picked = await packFile(
    fixtures.OS_PACK.replace('id = "oslab"', 'id = "net"').replace('a student learning operating systems', 'a student learning networks'),
  );
  const h = await fixtures.harness({ agent: fixtures.fakeAgent(), coding: { pickFile: async () => picked } });
  const plan = async () => {
    const { data } = await h.call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
    await fixtures.settle(h.call, data.id);
    await h.call(CHANNELS.requirementsPlan, data.id, ['5 次']);
    return fixtures.settle(h.call, data.id);
  };
  const { data: preview } = await h.call(CHANNELS.coursesPickImport);
  await h.call(CHANNELS.coursesImport, preview.ref.contentHash);
  await h.call(CHANNELS.coursesSelect, 'net');
  const pending = await plan();
  assert.equal(pending.plan.course.id, 'programming');
  assert.ok(h.agentCalls.every((call) => !call.systemPrompt?.includes('networks') && !call.prompt.includes('networks')));

  await h.call(CHANNELS.workspaceConfirmCourse, 'net', preview.ref.contentHash);
  const confirmed = await plan();
  assert.deepEqual(confirmed.plan.course, preview.ref);
  assert.match(h.agentCalls.at(-1)!.systemPrompt!, /a student learning networks/);
});
