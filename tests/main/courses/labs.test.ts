// A lab's checks and the files and packages it becomes (src/main/courses/labs.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as labs from '../../../src/main/courses/labs.ts';
import * as projectConfig from '../../../src/main/repository/project_config.ts';
import { PRESET_IDS } from '../../../src/main/checking/presets/index.ts';
import { FCFS_LAB, RR_LAB } from '../fixtures/sched_lab.ts';

const COURSE = { id: 'os', version: '0.2.0', contentHash: 'h', source: 'builtin' as const };

const refused = (lab: labs.LabArtifact, field: string, stage = 1) => assert.throws(() => labs.checkLab(lab, stage), { code: 'invalid_lab', field });

test('a lab keeps its files inside the repository and out of TaskPilot files', () => {
  assert.equal(labs.checkLab(FCFS_LAB, 1).files['src/fcfs.c'], FCFS_LAB.files['src/fcfs.c']);
  refused({ ...FCFS_LAB, files: { '../escape.c': 'x' } }, 'files["../escape.c"]');
  refused({ ...FCFS_LAB, files: { '/etc/passwd': 'x' } }, 'files["/etc/passwd"]');
  for (const owned of ['Makefile', 'taskpilot.toml', 'tests/public/01_x.sh', '.taskpilot/course_plan.toml', 'labs/01-fcfs/README.md', '.gitignore'])
    refused({ ...FCFS_LAB, files: { [owned]: 'x' } }, `files[${JSON.stringify(owned)}]`);
  refused({ ...FCFS_LAB, files: { '.env': 'x' } }, 'files[".env"]');
  refused({ ...FCFS_LAB, fileScope: ['Makefile'] }, 'fileScope[0]');
  refused({ ...FCFS_LAB, private: { ...FCFS_LAB.private, hidden: { '../x.sh': 'x' } } }, 'private.hidden["../x.sh"]');
});

test('public tests carry their stage number, and the program builds from starter files', () => {
  refused(FCFS_LAB, 'publicTests["01_fcfs.sh"]', 2);
  refused({ ...FCFS_LAB, publicTests: {} }, 'publicTests');
  refused({ ...FCFS_LAB, program: 'Bad Name' }, 'program');
  refused({ ...FCFS_LAB, sources: [] }, 'sources');
  refused({ ...FCFS_LAB, sources: ['src/missing.c'] }, 'sources[0]');
  refused({ ...FCFS_LAB, files: { 'src/a b.c': 'x' }, fileScope: ['src/a b.c'], sources: ['src/a b.c'] }, 'sources[0]');
  refused({ ...FCFS_LAB, id: 'FCFS' }, 'id');
  refused({ ...FCFS_LAB, concepts: ['Not An Id'] }, 'concepts');
  refused({ ...FCFS_LAB, private: { ...FCFS_LAB.private, hints: [{ level: 6, text: 'x', code: null }] } }, 'private.hints[0].level');
  refused({ ...FCFS_LAB, private: { ...FCFS_LAB.private, reference: 'x'.repeat(600 * 1024) } }, 'private.reference');
  refused({ ...FCFS_LAB, private: { ...FCFS_LAB.private, rubric: [{ id: 'Not An Id', note: 'x' }] } }, 'private.rubric[0].id');
  refused({ ...FCFS_LAB, private: { ...FCFS_LAB.private, rubric: [{ id: 'mechanism', note: '' }] } }, 'private.rubric[0].note');
});

test("a lab's repository files are what the student sees, never the private parts", () => {
  const files = labs.repositoryFiles(labs.checkLab(RR_LAB, 2), 2);
  assert.deepEqual(Object.keys(files).sort(), ['labs/02-round-robin/README.md', 'src/rr.c', 'tests/public/02_rr.sh']);
  const text = JSON.stringify(files);
  assert.ok(!text.includes('reference-marker') && !text.includes('hidden-marker'));
});

test('labs become a chain of practice packages, each waiting for the stage before', () => {
  const first = labs.toTaskDefinition(FCFS_LAB, { stage: 1, previous: null, course: COURSE, requirementId: 'course-labs' });
  const second = labs.toTaskDefinition(RR_LAB, { stage: 2, previous: first.id, course: COURSE, requirementId: 'course-labs' });
  assert.equal(first.id, 'lab-fcfs');
  assert.deepEqual(first.dependsOn, []);
  assert.deepEqual(second.dependsOn, ['lab-fcfs']);
  assert.deepEqual(second.lab, { id: 'round-robin', stage: 2, difficulty: 'medium' });
  assert.deepEqual(second.concepts, ['round-robin']);
  assert.equal(second.recommendedMode?.mode, 'practice');
  assert.equal(second.course, COURSE);
});

test("a new repository's taskpilot.toml names the pack, the toolchain, the grade step and every lab", () => {
  const text = labs.projectText('os', 'c', [labs.labEntry(FCFS_LAB, 1)]);
  const project = projectConfig.parseProject(text, PRESET_IDS);
  assert.equal(project.course, 'os');
  assert.equal(project.toolchain, 'c');
  assert.deepEqual(project.labs, [{ id: 'fcfs', stage: 1, dir: 'labs/01-fcfs', concepts: ['fcfs'], program: 'fcfs', sources: ['src/fcfs.c'] }]);
  assert.equal(project.steps['custom:grade']?.blocking, true);
  assert.equal(project.steps['custom:grade']?.stage, 'submit');
  // A later stage is appended as text, keeping the rest of the file.
  const grown = projectConfig.parseProject(`${text}\n# my note\n\n${labs.labsText([labs.labEntry(RR_LAB, 2)])}`, PRESET_IDS);
  assert.deepEqual(
    grown.labs.map((lab) => lab.stage),
    [1, 2],
  );
});
