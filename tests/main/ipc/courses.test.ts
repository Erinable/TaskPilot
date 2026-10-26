import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';

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

test('courses:default sends the built-in programming pack, whichever pack is in use', async () => {
  const h = await fixtures.harness();
  await fixtures.useOsPack(h, { confirm: true });
  const { data } = await h.call(CHANNELS.coursesDefault);
  assert.equal(data.id, 'programming');
  assert.deepEqual(
    data.rubric.map((item) => item.id),
    ['thinking', 'writing', 'style'],
  );
});

test('courses:copy writes a built-in pack under a new id into the global folder, unconfirmed', async () => {
  const h = await fixtures.harness();
  const { data } = await h.call(CHANNELS.coursesCopy, 'os', 'myos');
  const file = path.join(h.configDir, 'courses', 'myos.toml');
  assert.match(await fs.readFile(file, 'utf8'), /^schemaVersion = 1\nid = "myos"\n/);
  assert.equal(data.preview.ref.source, 'user');
  assert.equal(data.preview.trust, 'pending');
  assert.equal(data.preview.pack.id, 'myos');
  assert.deepEqual({ ...data.preview.pack, id: 'os' }, OS_COURSE);
  assert.deepEqual(data.list.entries.at(-1), {
    id: 'myos',
    source: 'user',
    title: OS_COURSE.title,
    version: OS_COURSE.version,
    languages: ['c', 'rust'],
    trust: 'pending',
    error: null,
  });

  // The file reads back as the content written, so its hash matches.
  const { data: preview } = await h.call(CHANNELS.coursesPreview, 'myos');
  assert.deepEqual(preview.ref, data.preview.ref);
});

test('courses:copy refuses an id that is taken or malformed, and an unknown source', async () => {
  const h = await fixtures.harness();
  await fixtures.useOsPack(h);
  await h.call(CHANNELS.coursesCopy, 'programming', 'mine');
  for (const id of ['programming', 'oslab', 'mine'])
    assert.deepEqual(
      [(await h.call(CHANNELS.coursesCopy, 'os', id)).error.code, (await h.call(CHANNELS.coursesCopy, 'os', id)).error.field],
      ['course_exists', 'id'],
      id,
    );
  assert.deepEqual((await h.call(CHANNELS.coursesCopy, 'os', 'My OS')).error.field, 'id');
  assert.equal((await h.call(CHANNELS.coursesCopy, 'cooking', 'cook')).error.code, 'unknown_course');
});

test('a repository pack can be copied, so it can be edited without touching the repository', async () => {
  const h = await fixtures.harness();
  await fixtures.useOsPack(h);
  const { data } = await h.call(CHANNELS.coursesCopy, 'oslab', 'oslab2');
  assert.equal(data.preview.pack.referenceGuide, 'Write the complete solution to this lab step.');
  assert.equal((await h.call(CHANNELS.coursesSave, 'oslab', { ...data.preview.pack, id: 'oslab' })).error.code, 'course_read_only');
});

test('courses:save validates on the main process, writes the file and needs confirming again', async () => {
  const h = await fixtures.harness();
  await h.call(CHANNELS.coursesCopy, 'os', 'myos');
  const { data: copied } = await h.call(CHANNELS.coursesSelect, 'myos');
  const first = copied.current.state.ref;
  await h.call(CHANNELS.workspaceConfirmCourse, 'myos', first.contentHash);
  assert.equal((await h.call(CHANNELS.workspaceGet)).data.course.ref.id, 'myos');

  const pack = (await h.call(CHANNELS.coursesPreview, 'myos')).data.pack;
  const invalid = await h.call(CHANNELS.coursesSave, 'myos', { ...pack, rubric: [{ ...pack.rubric[0], dimension: 'safety' }, pack.rubric[1]] });
  assert.deepEqual([invalid.error.code, invalid.error.field], ['invalid_course', 'rubric[0].dimension']);
  assert.equal((await h.call(CHANNELS.coursesSave, 'myos', { ...pack, id: 'other' })).error.field, 'id');

  const { data: saved } = await h.call(CHANNELS.coursesSave, 'myos', { ...pack, title: '我的操作系统课' });
  assert.equal(saved.preview.trust, 'pending');
  assert.equal(saved.preview.previous, 'known');
  assert.deepEqual(saved.preview.changes, [{ field: 'title', kind: 'changed' }]);
  // The saved pack is not used until it is confirmed again.
  const view = (await h.call(CHANNELS.workspaceGet)).data;
  assert.equal(view.course.state.status, 'pending');
  assert.equal(view.course.ref.id, 'programming');
  await h.call(CHANNELS.workspaceConfirmCourse, 'myos', saved.preview.ref.contentHash);
  const confirmed = (await h.call(CHANNELS.workspaceGet)).data.course;
  assert.deepEqual([confirmed.state.status, confirmed.ref.contentHash], ['ok', saved.preview.ref.contentHash]);
});

test('courses:save refuses built-in packs', async () => {
  const h = await fixtures.harness();
  const saved = await h.call(CHANNELS.coursesSave, 'os', OS_COURSE);
  assert.equal(saved.error.code, 'course_read_only');
});
