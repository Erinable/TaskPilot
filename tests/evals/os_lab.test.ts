// The OS lab fixture (evals/shared/os_lab/) as TaskPilot sees it: its
// taskpilot.toml picks the built-in os pack and a custom:grade step, which
// fails on the unfinished lab and passes with the reference solutions.
import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import * as courses from '../../src/main/courses/courses.ts';
import * as effectiveSteps from '../../src/main/checking/effective_steps.ts';
import * as projectConfig from '../../src/main/repository/project_config.ts';
import * as verification from '../../src/main/checking/verification.ts';
import * as workspace from '../../src/main/repository/workspace.ts';
import { env } from '../../src/main/infrastructure/env.ts';
import { PRESET_IDS } from '../../src/main/checking/presets/index.ts';
import { BUILTIN, OS_COURSE } from '../fixtures/builtin_courses.ts';
import { tempDir } from '../fixtures/temp_dir.ts';
import * as requiredTools from '../fixtures/required_tools.ts';
import { fixtureRepo } from '../../evals/shared/harness.ts';
import { OS_LAB, osReference } from '../../evals/shared/os_lab.ts';

const repo = async () => {
  const fixture = await fixtureRepo('os-lab', OS_LAB);
  onTestFinished(fixture.cleanup);
  return fixture.root;
};

test('the OS lab picks the built-in os pack without confirming it', async () => {
  const root = await repo();
  const project = projectConfig.parseProject((await projectConfig.readProjectText(root))!, PRESET_IDS);
  const dataDir = await tempDir('tp-os-lab-data-');
  const resolved = await courses.resolveCourse({ root, dataDir, configDir: null, builtin: BUILTIN }, { local: null, project: project.course });
  assert.deepEqual(resolved.selected, { id: 'os', from: 'project' });
  assert.deepEqual(resolved.state, { status: 'ok' });
  assert.equal(resolved.pack, OS_COURSE);
  assert.deepEqual(
    resolved.pack.rubric.map((item) => item.id),
    ['concept', 'mechanism', 'safety'],
  );
});

const hasTools = await requiredTools.hasTools('cc', 'make', 'perl');

test.skipIf(!hasTools)(
  'custom:grade fails on the unfinished lab and passes with the reference solutions',
  async () => {
    const root = await repo();
    const resolution = await effectiveSteps.resolve(workspace.normalize({ version: 3, root, steps: {} }), { envPath: env.path });
    const grade = effectiveSteps.runnable(resolution).find((step) => step.id === 'custom:grade')!;
    assert.equal(grade.blocking, true);
    const outcome = async () => {
      const result = await verification.runStep(root, grade, { envPath: env.path });
      assert.equal(result.report.trusted, true, result.output.slice(-2000));
      return Object.fromEntries(result.results.map((entry) => [entry.name, entry.passed]));
    };
    const unfinished = await outcome();
    assert.equal(Object.keys(unfinished).length, 5);
    assert.equal(unfinished['pingpong prints ping then pong'], false);

    for (const program of ['pingpong', 'copy', 'counter', 'bbuf']) await fs.writeFile(path.join(root, `src/${program}.c`), osReference(`src/${program}.c`));
    const finished = await outcome();
    assert.deepEqual(
      Object.keys(finished).filter((name) => !finished[name]),
      [],
    );
  },
  120_000,
);
