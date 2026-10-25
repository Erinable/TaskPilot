// Builds the ProjectProfile the agents are told (../shared/project_profile.ts)
// from the steps the repository actually runs and the preset taskpilot.toml
// names. This is the one layer that knows presets and config files; agents
// only get the result.
import { formatCommandLine } from './command_line.ts';
import * as presets from './presets/index.ts';
import type { ProfileCheck, ProfileCheckReport, ProjectProfile } from '../shared/project_profile.ts';
import type { Resolution } from './effective_steps.ts';
import type { CheckStep } from './step_config.ts';

const reportsOf = (step: CheckStep): ProfileCheckReport => {
  if (step.parser.format === 'tests' || step.parser.format === 'junit') return 'tests';
  return step.parser.format === 'exitcode' ? 'exit' : 'diagnostics';
};

const checkOf = (step: CheckStep): ProfileCheck => ({
  id: step.id,
  label: step.label ?? step.id,
  stage: step.stage === 'submit' ? 'submit' : 'manual',
  blocking: step.blocking,
  commandLine: step.commands.map(formatCommandLine).join(' && '),
  reports: reportsOf(step),
});

// The profile of a resolved repository. Without taskpilot.toml the languages
// are the detected ones; testLayout, testNameFormat and version stay null
// until presets provide them.
export const buildProfile = (resolution: Resolution): ProjectProfile => {
  const preset = resolution.project.status === 'ok' ? presets.presetById(resolution.project.preset) : null;
  const detected = resolution.detected.flatMap((entry) => (entry.preset ? [presets.presetById(entry.preset)] : [])).filter((entry) => entry !== null);
  const languages = preset ? [preset] : [...new Map(detected.map((entry) => [entry.id, entry])).values()];
  return {
    languages: languages.map((entry) => ({ id: entry.id, label: entry.label })),
    manifests: preset ? preset.manifests : [...new Set(resolution.detected.map((entry) => entry.manifest))],
    testLayout: null,
    testNameFormat: null,
    checks: resolution.steps.flatMap((entry) => (entry.step ? [checkOf(entry.step)] : [])),
    version: null,
  };
};
