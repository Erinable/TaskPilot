import { expect, test } from 'vitest';

import { isBlankProject } from '../../src/shared/blank_project.ts';

test('a repository with only a README, git files, notes and taskpilot.toml is blank', () => {
  expect(isBlankProject(['README.md', '.gitignore', 'LICENSE', 'docs/idea.md', 'taskpilot.toml', '.editorconfig'])).toBe(true);
  expect(isBlankProject([])).toBe(true);
});

test('any code, manifest or config file means the project has a skeleton', () => {
  for (const file of ['package.json', 'src/main.rs', 'Makefile', 'app.py', '.github/workflows/ci.yml'])
    expect(isBlankProject(['README.md', file]), file).toBe(false);
});
