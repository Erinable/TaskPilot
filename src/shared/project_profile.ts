// What the agents are told about the repository they work in: its language,
// manifests and check steps, built in the main process from taskpilot.toml,
// its preset and this machine's settings (see ../main/project_profile.ts).
// Agents only receive this data and render it (../main/agents/prompt_blocks.ts);
// they never read a config file themselves.

// How a step's result is reported: test results, diagnostics, or only an
// exit code.
export type ProfileCheckReport = 'tests' | 'diagnostics' | 'exit';

// What a parser format (check_steps.ts PARSER_FORMATS) reports.
export const reportsOf = (format: string): ProfileCheckReport => {
  if (format === 'tests' || format === 'junit') return 'tests';
  return format === 'exitcode' ? 'exit' : 'diagnostics';
};

export type ProfileCheck = {
  id: string;
  label: string;
  // `manual` runs when the developer asks; `submit` runs before QA.
  stage: 'submit' | 'manual';
  blocking: boolean;
  commandLine: string;
  reports: ProfileCheckReport;
};

export interface ProjectProfile {
  languages: { id: string; label: string }[];
  manifests: string[];
  // Where the repository keeps its tests, e.g. "tests/ 下 test_*.py"; null
  // when the preset does not say.
  testLayout: string | null;
  // [人工决策-2026-10-25 23:51:35] 测试名保持精确匹配，只在 prompt 里注入名字格式（CARM-16 决策 A）。
  // The exact form a linked test name takes in the runner's results, e.g.
  // pytest's bare function name; null without a preset.
  testNameFormat: string | null;
  checks: ProfileCheck[];
  // The committed version and the file it is read from; null until a preset
  // can read one.
  version: { file: string; value: string | null } | null;
}
