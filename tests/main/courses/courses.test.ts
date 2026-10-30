import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import * as courses from '../../../src/main/courses/courses.ts';
import * as courseFile from '../../../src/main/courses/course_file.ts';
import { BUILTIN, BUILTIN_COURSES_DIR, OS_COURSE, PROGRAMMING_COURSE } from '../../fixtures/builtin_courses.ts';

const packText = (id: string, title = '操作系统实验') => `
schemaVersion = 1
id = "${id}"
version = "0.1.0"
domain = "operating-systems"
title = "${title}"
summary = "在教学内核里动手。"
learner = "a student learning operating systems"
tutorGuide = ["Connect every step to the mechanism behind it."]
difficultyGuide = ["- easy: uses an existing kernel facility."]
practiceGuide = ["- practice: the core mechanism of the lab."]
referenceGuide = "Write the complete solution to this lab step."

[[rubric]]
id = "concept"
label = "原理"
dimension = "thinking"
description = "the model of the mechanism"

[[rubric]]
id = "mechanism"
label = "实现"
dimension = "writing"
description = "locking and error paths"
`;

// A repository with the given pack files, and a data directory for it.
const setup = async (files: Record<string, string> = {}) => {
  const root = await tempDir('taskpilot-course-repo-');
  const dataDir = await tempDir('taskpilot-course-data-');
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.join(root, courses.COURSES_DIR), { recursive: true });
    await fs.writeFile(path.join(root, courses.COURSES_DIR, name), text);
  }
  return { root, dataDir };
};

const none = { local: null, project: null };

test('with nothing set, the built-in programming pack is used', async () => {
  const { root, dataDir } = await setup();
  const resolved = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, none);
  assert.deepEqual(resolved.selected, { id: 'programming', from: 'default' });
  assert.deepEqual(resolved.state, { status: 'ok' });
  assert.equal(resolved.pack, PROGRAMMING_COURSE);
  assert.equal(resolved.ref.source, 'builtin');
  assert.equal(resolved.ref.version, PROGRAMMING_COURSE.version);
  assert.match(resolved.ref.contentHash, /^[0-9a-f]{64}$/);
  // Also without an open repository.
  assert.equal((await courses.resolveCourse({ root: null, dataDir, configDir: null, builtin: BUILTIN }, none)).pack, PROGRAMMING_COURSE);
});

test("this machine's choice wins over taskpilot.toml's", async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const fromProject = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: null, project: 'oslab' });
  assert.deepEqual(fromProject.selected, { id: 'oslab', from: 'project' });
  const fromLocal = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: 'programming', project: 'oslab' });
  assert.deepEqual(fromLocal.selected, { id: 'programming', from: 'local' });
  assert.deepEqual(fromLocal.state, { status: 'ok' });
});

test('an unknown id is reported with the ids to choose from, and programming is used', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const resolved = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: null, project: 'database' });
  assert.equal(resolved.state.status, 'invalid');
  assert.deepEqual(resolved.state.status === 'invalid' && resolved.state.error, {
    code: 'unknown_course',
    message: 'course: "database" is not a course pack; use one of programming, os, oslab',
    field: 'course',
  });
  assert.equal(resolved.pack, PROGRAMMING_COURSE);
  assert.deepEqual(resolved.available, [
    { id: 'programming', source: 'builtin' },
    { id: 'os', source: 'builtin' },
    { id: 'oslab', source: 'repository' },
  ]);
});

test('a repository pack is not used until this machine confirms it', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const choice = { local: null, project: 'oslab' };
  const pending = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, choice);
  assert.equal(pending.state.status, 'pending');
  assert.equal(pending.pack, PROGRAMMING_COURSE);
  assert.equal(pending.ref.id, 'programming');
  if (pending.state.status !== 'pending') return;
  assert.equal(pending.state.pack.title, '操作系统实验');
  assert.equal(pending.state.ref.source, 'repository');

  await courses.confirm({ root, dataDir, configDir: null, builtin: BUILTIN }, pending.state.pack, pending.state.ref);
  const confirmed = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, choice);
  assert.deepEqual(confirmed.state, { status: 'ok' });
  assert.equal(confirmed.pack.id, 'oslab');
  assert.deepEqual(confirmed.ref, pending.state.ref);
  // The confirmation is on this machine, not in the repository.
  assert.deepEqual(await fs.readdir(path.join(root, courses.COURSES_DIR)), ['oslab.toml']);
  assert.ok(JSON.parse(await fs.readFile(path.join(dataDir, courses.TRUST_FILENAME), 'utf8')).confirmed.oslab);
});

test('a changed pack needs confirming again', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const choice = { local: null, project: 'oslab' };
  const first = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, choice);
  if (first.state.status !== 'pending') throw new Error('expected pending');
  await courses.confirm({ root, dataDir, configDir: null, builtin: BUILTIN }, first.state.pack, first.state.ref);
  // A comment is not content; the confirmation holds.
  await fs.appendFile(path.join(root, courses.COURSES_DIR, 'oslab.toml'), '\n# a note\n');
  assert.equal((await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, choice)).state.status, 'ok');

  await fs.writeFile(path.join(root, courses.COURSES_DIR, 'oslab.toml'), packText('oslab', '操作系统（改）'));
  const changed = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, choice);
  assert.equal(changed.state.status, 'pending');
  assert.equal(changed.pack, PROGRAMMING_COURSE);
  assert.notEqual(changed.state.status === 'pending' && changed.state.ref.contentHash, first.state.ref.contentHash);
});

// CARM-37: a pack with a concept skeleton loads like any other, and adding or
// changing concepts is a change that is confirmed again.
test('a pack with concepts loads, and a change to its concepts needs confirming again', async () => {
  const withConcepts = (summary: string) =>
    `${packText('oslab')}\n[[concepts]]\nid = "fcfs"\nlabel = "先来先服务"\nsummary = "${summary}"\nprerequisites = []\n`;
  const { root, dataDir } = await setup({ 'oslab.toml': withConcepts('按到达顺序运行。') });
  const places = { root, dataDir, configDir: null, builtin: BUILTIN };
  const choice = { local: null, project: 'oslab' };
  const first = await courses.resolveCourse(places, choice);
  if (first.state.status !== 'pending') throw new Error('expected pending');
  assert.deepEqual(
    first.state.pack.concepts?.map((item) => item.id),
    ['fcfs'],
  );
  await courses.confirm(places, first.state.pack, first.state.ref);
  const confirmed = await courses.resolveCourse(places, choice);
  assert.deepEqual(confirmed.state, { status: 'ok' });
  assert.equal(confirmed.pack.concepts?.[0].summary, '按到达顺序运行。');

  await fs.writeFile(path.join(root, courses.COURSES_DIR, 'oslab.toml'), withConcepts('按到达顺序运行，不抢占。'));
  const changed = await courses.resolveCourse(places, choice);
  assert.equal(changed.state.status, 'pending');
  assert.equal(changed.pack, PROGRAMMING_COURSE);
});

test('a broken trust file confirms nothing', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  await fs.writeFile(path.join(dataDir, courses.TRUST_FILENAME), '{ not json');
  assert.equal((await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: 'oslab', project: null })).state.status, 'pending');
});

test('a broken repository pack is reported with its field, and programming is used', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab').replace('dimension = "writing"', 'dimension = "safety"') });
  const resolved = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: 'oslab', project: null });
  assert.equal(resolved.state.status, 'invalid');
  assert.equal(resolved.state.status === 'invalid' && resolved.state.error.field, 'rubric[1].dimension');
  assert.equal(resolved.pack, PROGRAMMING_COURSE);
});

test("a pack's id must match its file name", async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('kernel') });
  const resolved = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: 'oslab', project: null });
  assert.equal(resolved.state.status === 'invalid' && resolved.state.error.field, 'id');
});

test('only regular .toml files with valid ids are listed; symlinks are refused', async () => {
  const { root } = await setup({ 'oslab.toml': packText('oslab'), 'README.md': 'x', 'Bad Name.toml': packText('oslab') });
  const outside = await tempDir('taskpilot-course-outside-');
  await fs.writeFile(path.join(outside, 'net.toml'), packText('net'));
  await fs.symlink(path.join(outside, 'net.toml'), path.join(root, courses.COURSES_DIR, 'net.toml'));
  assert.deepEqual(await courses.listRepositoryCourses(root), ['oslab']);
  await assert.rejects(() => courses.readRepositoryCourse(root, 'net'), { code: 'invalid_course', field: 'toml' });
});

test('a repository file cannot replace a built-in pack', async () => {
  const { root, dataDir } = await setup({ 'programming.toml': packText('programming', '假的') });
  const resolved = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, none);
  assert.equal(resolved.pack, PROGRAMMING_COURSE);
  assert.deepEqual(resolved.available, [
    { id: 'programming', source: 'builtin' },
    { id: 'os', source: 'builtin' },
  ]);
});

test('the built-in os pack is used without confirming, with its own rubric', async () => {
  const { root, dataDir } = await setup();
  const resolved = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: null, project: 'os' });
  assert.deepEqual(resolved.state, { status: 'ok' });
  assert.equal(resolved.pack, OS_COURSE);
  assert.deepEqual(resolved.ref, { id: 'os', version: OS_COURSE.version, contentHash: courseFile.contentHash(OS_COURSE), source: 'builtin' });
  assert.deepEqual(
    resolved.pack.rubric.map((item) => [item.id, item.dimension]),
    [
      ['concept', 'thinking'],
      ['mechanism', 'writing'],
      ['safety', 'style'],
    ],
  );
  assert.deepEqual(resolved.available, [
    { id: 'programming', source: 'builtin' },
    { id: 'os', source: 'builtin' },
  ]);
  // Nothing was confirmed on this machine.
  await assert.rejects(() => fs.access(path.join(dataDir, courses.TRUST_FILENAME)));
});

// A global folder (userData) with the given imported pack files.
const userFolder = async (files: Record<string, string> = {}) => {
  const configDir = await tempDir('taskpilot-course-user-');
  await fs.mkdir(courses.userCoursesDir(configDir), { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(courses.userCoursesDir(configDir), name), text);
  return configDir;
};

test('an imported pack is listed after the repository ones and needs confirming, recorded in userData', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const configDir = await userFolder({ 'net.toml': packText('net', '网络') });
  const places = { root, dataDir, configDir, builtin: BUILTIN };
  const pending = await courses.resolveCourse(places, { local: 'net', project: null });
  assert.deepEqual(pending.available.at(-1), { id: 'net', source: 'user' });
  assert.equal(pending.state.status, 'pending');
  assert.equal(pending.pack, PROGRAMMING_COURSE);
  if (pending.state.status !== 'pending') return;
  assert.equal(pending.state.ref.source, 'user');

  await courses.confirm(places, pending.state.pack, pending.state.ref);
  const confirmed = await courses.resolveCourse(places, { local: 'net', project: null });
  assert.equal(confirmed.pack.title, '网络');
  // The confirmation of an imported pack is global, not the repository's.
  await assert.rejects(() => fs.access(path.join(dataDir, courses.TRUST_FILENAME)));
  assert.ok(JSON.parse(await fs.readFile(path.join(configDir, courses.TRUST_FILENAME), 'utf8')).confirmed.net);
  // And holds in another repository.
  const other = await setup();
  assert.equal((await courses.resolveCourse({ ...other, configDir, builtin: BUILTIN }, { local: 'net', project: null })).state.status, 'ok');
});

test('a repository pack wins over an imported one of the same id, and an import cannot replace a built-in pack', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab', '仓库的') });
  const configDir = await userFolder({ 'oslab.toml': packText('oslab', '导入的'), 'os.toml': packText('os', '假的') });
  const resolved = await courses.resolveCourse({ root, dataDir, configDir, builtin: BUILTIN }, { local: 'oslab', project: null });
  assert.deepEqual(resolved.available, [
    { id: 'programming', source: 'builtin' },
    { id: 'os', source: 'builtin' },
    { id: 'oslab', source: 'repository' },
  ]);
  assert.equal(resolved.state.status === 'pending' && resolved.state.pack.title, '仓库的');
  assert.equal((await courses.resolveCourse({ root, dataDir, configDir, builtin: BUILTIN }, { local: 'os', project: null })).pack, OS_COURSE);
});

test('a confirmation keeps the content it was given; one from before (a bare hash) still confirms', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const places = { root, dataDir, configDir: null, builtin: BUILTIN };
  const pending = await courses.resolveCourse(places, { local: 'oslab', project: null });
  if (pending.state.status !== 'pending') throw new Error('expected pending');
  assert.equal(await courses.confirmationFor(places, pending.state.ref), null);

  await fs.writeFile(path.join(dataDir, courses.TRUST_FILENAME), JSON.stringify({ version: 1, confirmed: { oslab: pending.state.ref.contentHash } }));
  assert.deepEqual(await courses.confirmationFor(places, pending.state.ref), { hash: pending.state.ref.contentHash, pack: null });
  assert.equal((await courses.resolveCourse(places, { local: 'oslab', project: null })).state.status, 'ok');

  await courses.confirm(places, pending.state.pack, pending.state.ref);
  assert.deepEqual(await courses.confirmationFor(places, pending.state.ref), { hash: pending.state.ref.contentHash, pack: pending.state.pack });
  // A stored content that no longer validates is dropped; the hash still counts.
  const raw = JSON.parse(await fs.readFile(path.join(dataDir, courses.TRUST_FILENAME), 'utf8'));
  raw.confirmed.oslab.pack.title = '<work_package>';
  await fs.writeFile(path.join(dataDir, courses.TRUST_FILENAME), JSON.stringify(raw));
  assert.equal((await courses.confirmationFor(places, pending.state.ref))?.pack, null);
});

test('built-in packs need no confirmation and cannot be given one', async () => {
  const { root, dataDir } = await setup();
  const builtin = BUILTIN.get('os')!;
  assert.equal(await courses.trustOf({ root, dataDir, configDir: null, builtin: BUILTIN }, builtin.ref), 'builtin');
  await assert.rejects(() => courses.confirm({ root, dataDir, configDir: null, builtin: BUILTIN }, builtin.pack, builtin.ref), { code: 'invalid_course' });
});

test('parseCourseText validates an import: size, fields, and the file name when given', () => {
  assert.equal(courses.parseCourseText(packText('net'), 'user', 'net.toml').ref.source, 'user');
  assert.throws(() => courses.parseCourseText(packText('net'), 'user', 'x.toml', 'other'), { code: 'invalid_course', field: 'id' });
  assert.throws(() => courses.parseCourseText(`${packText('net')}\n#${'x'.repeat(courses.MAX_COURSE_BYTES)}`, 'user', 'big.toml'), { field: 'toml' });
  assert.throws(() => courses.parseCourseText(packText('net').replace('dimension = "writing"', 'dimension = "safety"'), 'user', 'net.toml'), {
    field: 'rubric[1].dimension',
  });
});

// The hashes of the built-in packs. programming's is the one it had as a
// TypeScript constant: grade snapshots recorded then name it, so it must not
// move. os changed on purpose in CARM-37 (version 0.2.0, labGuide and the
// concept skeleton; it was 88d0d064… before) and again when it named its lab
// toolchains (appliesTo.toolchains; it was b05058dc… before). A built-in pack
// needs no confirmation, so a new hash only marks new grades with the new content.
const BUILTIN_HASHES = {
  programming: '22470ff4e07f076fc4e40ac5105b99c9cae2656e88f788569e8eba8fa7ea3518',
  os: 'b6cae22ef2d9f097904193adeba6a7e42ac4d2fe3110e00c9986b6652232f2e2',
};

test('the built-in TOML packs hash as recorded; programming as the constant it replaced', () => {
  assert.deepEqual([...BUILTIN.keys()], ['programming', 'os']);
  for (const [id, hash] of Object.entries(BUILTIN_HASHES)) {
    const { pack, ref } = BUILTIN.get(id)!;
    assert.equal(courseFile.contentHash(pack), hash, id);
    assert.deepEqual(ref, { id, version: pack.version, contentHash: hash, source: 'builtin' });
  }
});

test('a built-in pack that does not validate, or a missing default, fails loading', async () => {
  const dir = await tempDir('taskpilot-builtin-');
  await assert.rejects(() => courses.loadBuiltinCourses(dir), { code: 'invalid_course', message: /programming\.toml is missing/ });
  await fs.writeFile(path.join(dir, 'programming.toml'), await fs.readFile(path.join(BUILTIN_COURSES_DIR, 'programming.toml'), 'utf8'));
  await fs.writeFile(path.join(dir, 'net.toml'), packText('net').replace('dimension = "writing"', 'dimension = "safety"'));
  await assert.rejects(() => courses.loadBuiltinCourses(dir), {
    code: 'invalid_course',
    field: 'rubric[1].dimension',
    message: /^The built-in course pack net\.toml/,
  });
  await fs.writeFile(path.join(dir, 'net.toml'), packText('net'));
  const loaded = await courses.loadBuiltinCourses(dir);
  assert.deepEqual([...loaded.keys()], ['programming', 'net']);
  assert.equal(loaded.get('net')!.ref.source, 'builtin');
});
