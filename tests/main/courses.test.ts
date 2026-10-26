import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as courses from '../../src/main/courses.ts';
import * as courseFile from '../../src/main/course_file.ts';
import { OS_COURSE, PROGRAMMING_COURSE } from '../../src/shared/course_pack.ts';

const tempDir = async (prefix: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

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
  const resolved = await courses.resolveCourse(root, dataDir, none);
  assert.deepEqual(resolved.selected, { id: 'programming', from: 'default' });
  assert.deepEqual(resolved.state, { status: 'ok' });
  assert.equal(resolved.pack, PROGRAMMING_COURSE);
  assert.equal(resolved.ref.source, 'builtin');
  assert.equal(resolved.ref.version, PROGRAMMING_COURSE.version);
  assert.match(resolved.ref.contentHash, /^[0-9a-f]{64}$/);
  // Also without an open repository.
  assert.equal((await courses.resolveCourse(null, dataDir, none)).pack, PROGRAMMING_COURSE);
});

test("this machine's choice wins over taskpilot.toml's", async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const fromProject = await courses.resolveCourse(root, dataDir, { local: null, project: 'oslab' });
  assert.deepEqual(fromProject.selected, { id: 'oslab', from: 'project' });
  const fromLocal = await courses.resolveCourse(root, dataDir, { local: 'programming', project: 'oslab' });
  assert.deepEqual(fromLocal.selected, { id: 'programming', from: 'local' });
  assert.deepEqual(fromLocal.state, { status: 'ok' });
});

test('an unknown id is reported with the ids to choose from, and programming is used', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  const resolved = await courses.resolveCourse(root, dataDir, { local: null, project: 'database' });
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
  const pending = await courses.resolveCourse(root, dataDir, choice);
  assert.equal(pending.state.status, 'pending');
  assert.equal(pending.pack, PROGRAMMING_COURSE);
  assert.equal(pending.ref.id, 'programming');
  if (pending.state.status !== 'pending') return;
  assert.equal(pending.state.pack.title, '操作系统实验');
  assert.equal(pending.state.ref.source, 'repository');

  await courses.confirm(dataDir, pending.state.ref);
  const confirmed = await courses.resolveCourse(root, dataDir, choice);
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
  const first = await courses.resolveCourse(root, dataDir, choice);
  if (first.state.status !== 'pending') throw new Error('expected pending');
  await courses.confirm(dataDir, first.state.ref);
  // A comment is not content; the confirmation holds.
  await fs.appendFile(path.join(root, courses.COURSES_DIR, 'oslab.toml'), '\n# a note\n');
  assert.equal((await courses.resolveCourse(root, dataDir, choice)).state.status, 'ok');

  await fs.writeFile(path.join(root, courses.COURSES_DIR, 'oslab.toml'), packText('oslab', '操作系统（改）'));
  const changed = await courses.resolveCourse(root, dataDir, choice);
  assert.equal(changed.state.status, 'pending');
  assert.equal(changed.pack, PROGRAMMING_COURSE);
  assert.notEqual(changed.state.status === 'pending' && changed.state.ref.contentHash, first.state.ref.contentHash);
});

test('a broken trust file confirms nothing', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab') });
  await fs.writeFile(path.join(dataDir, courses.TRUST_FILENAME), '{ not json');
  assert.equal((await courses.resolveCourse(root, dataDir, { local: 'oslab', project: null })).state.status, 'pending');
});

test('a broken repository pack is reported with its field, and programming is used', async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('oslab').replace('dimension = "writing"', 'dimension = "safety"') });
  const resolved = await courses.resolveCourse(root, dataDir, { local: 'oslab', project: null });
  assert.equal(resolved.state.status, 'invalid');
  assert.equal(resolved.state.status === 'invalid' && resolved.state.error.field, 'rubric[1].dimension');
  assert.equal(resolved.pack, PROGRAMMING_COURSE);
});

test("a pack's id must match its file name", async () => {
  const { root, dataDir } = await setup({ 'oslab.toml': packText('kernel') });
  const resolved = await courses.resolveCourse(root, dataDir, { local: 'oslab', project: null });
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
  const resolved = await courses.resolveCourse(root, dataDir, none);
  assert.equal(resolved.pack, PROGRAMMING_COURSE);
  assert.deepEqual(resolved.available, [
    { id: 'programming', source: 'builtin' },
    { id: 'os', source: 'builtin' },
  ]);
});

test('the built-in os pack is used without confirming, with its own rubric', async () => {
  const { root, dataDir } = await setup();
  const resolved = await courses.resolveCourse(root, dataDir, { local: null, project: 'os' });
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

test('a repository os.toml cannot replace the built-in os pack', async () => {
  const { root, dataDir } = await setup({ 'os.toml': packText('os', '假的') });
  const resolved = await courses.resolveCourse(root, dataDir, { local: 'os', project: null });
  assert.equal(resolved.pack, OS_COURSE);
  assert.equal(resolved.ref.source, 'builtin');
});
