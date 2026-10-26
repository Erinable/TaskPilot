import { test } from 'vitest';
import assert from 'node:assert/strict';

import { reportIgnore } from '../../src/main/submit_checks.ts';
import type { CheckStep } from '../../src/main/step_config.ts';

const junit = {
  id: 'test',
  label: null,
  commands: [],
  cwd: 'app',
  stage: 'submit',
  blocking: true,
  parser: { format: 'junit', path: 'out/unit.xml' },
  env: {},
};

test("report files and TaskPilot's own output are not a package's changes, but course packs are", () => {
  const ignored = reportIgnore([junit as unknown as CheckStep]);
  assert.equal(ignored('app/out/unit.xml'), true);
  assert.equal(ignored('.taskpilot/reports/vitest.xml'), true);
  assert.equal(ignored('.taskpilot/analysis/complexity/complexity-report.json'), true);
  assert.equal(ignored('.taskpilot/courses/os.toml'), false);
  assert.equal(ignored('src/a.ts'), false);
});
