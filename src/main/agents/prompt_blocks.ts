// The <project_profile> block agents add to their prompts. Each prompt names
// the sections it uses; a section with nothing to say is left out, and with
// no profile (or nothing left) the block is not rendered at all, so prompts
// stay exactly as they were for repositories the profile says nothing new
// about. Data only: nothing here reads a config file or knows a preset.
import type { ProjectProfile } from '../../shared/project_profile.ts';

export type ProfileSection = 'languages' | 'manifests' | 'testLayout' | 'testNameFormat' | 'checks' | 'version';

const REPORTS = { tests: 'test results', diagnostics: 'diagnostics', exit: 'exit code only' } as const;

const sectionLines = (profile: ProjectProfile, section: ProfileSection): string[] => {
  switch (section) {
    case 'languages':
      return profile.languages.length ? [`Languages: ${profile.languages.map((language) => language.label).join(', ')}`] : [];
    case 'manifests':
      return profile.manifests.length ? [`Manifests: ${profile.manifests.join(', ')}`] : [];
    case 'testLayout':
      return profile.testLayout ? [`Test layout: ${profile.testLayout}`] : [];
    case 'testNameFormat':
      return profile.testNameFormat ? [`Test names: ${profile.testNameFormat}`] : [];
    case 'checks':
      return profile.checks.length
        ? [
            'Checks:',
            ...profile.checks.map(
              (check) =>
                `- ${check.label} (${check.stage === 'submit' ? 'runs before review' : 'manual'}, ${check.blocking ? 'blocking' : 'advisory'}, ${REPORTS[check.reports]}): ${check.commandLine}`,
            ),
          ]
        : [];
    case 'version':
      return profile.version ? [`Version: ${profile.version.value ?? '(none)'} (from ${profile.version.file})`] : [];
  }
};

// Lines to spread into a prompt, starting with a blank separator line.
export const profileBlock = (profile: ProjectProfile | null | undefined, sections: readonly ProfileSection[]): string[] => {
  if (!profile) return [];
  const lines = sections.flatMap((section) => sectionLines(profile, section));
  return lines.length ? ['', '<project_profile>', ...lines, '</project_profile>'] : [];
};
