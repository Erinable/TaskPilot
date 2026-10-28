// Builds the ProjectProfile the agents are told (../shared/project_profile.ts)
// from the steps the repository actually runs and the preset taskpilot.toml
// names. This is the one layer that knows presets and config files; agents
// only get the result.
import { formatCommandLine } from '../checking/command_line.ts';
import * as presets from '../checking/presets/index.ts';
import { stepName } from '../../shared/check_steps.ts';
import { reportsOf } from '../../shared/project_profile.ts';
import type { ProfileCheck, ProjectProfile } from '../../shared/project_profile.ts';
import type { Resolution } from '../checking/effective_steps.ts';
import type { CheckStep } from '../checking/step_config.ts';

const checkOf = (step: CheckStep): ProfileCheck => ({
  id: step.id,
  label: stepName(step.id, step.label),
  stage: step.stage === 'submit' ? 'submit' : 'manual',
  blocking: step.blocking,
  commandLine: step.commands.map(formatCommandLine).join(' && '),
  reports: reportsOf(step.parser.format),
});

// The profile of a resolved repository. Without taskpilot.toml the languages
// are the detected ones and there is no test name format; testLayout comes
// from one language only, and version stays null until presets provide it.
export const buildProfile = (resolution: Resolution): ProjectProfile => {
  const preset = resolution.project.status === 'ok' ? presets.presetById(resolution.project.preset) : null;
  const detected = resolution.detected.flatMap((entry) => (entry.preset ? [presets.presetById(entry.preset)] : [])).filter((entry) => entry !== null);
  const languages = preset ? [preset] : [...new Map(detected.map((entry) => [entry.id, entry])).values()];
  return {
    languages: languages.map((entry) => ({ id: entry.id, label: entry.label })),
    manifests: preset ? preset.manifests : [...new Set(resolution.detected.map((entry) => entry.manifest))],
    testLayout: languages.length === 1 ? languages[0].testLayout : null,
    testNameFormat: preset ? preset.testNameFormat : null,
    checks: resolution.steps.flatMap((entry) => (entry.step ? [checkOf(entry.step)] : [])),
    version: null,
  };
};
