// The language presets taskpilot.toml can name, and which one a repository
// looks like it wants. Recognised languages without a preset yet are
// reported so the user knows why none is offered.
import { typescriptPreset } from './typescript.ts';
import { rustPreset } from './rust.ts';
import { pythonPreset } from './python.ts';
import type { CommittedVersion, Preset } from './preset.ts';

export const PRESETS: Preset[] = [typescriptPreset as Preset, rustPreset as Preset, pythonPreset as Preset];

export const PRESET_IDS = PRESETS.map((preset) => preset.id);

export const presetById = (id: string | null) => PRESETS.find((preset) => preset.id === id) ?? null;

// The presets of a repository's languages, as its project profile lists them.
export const presetsOf = (ids: readonly string[]) => PRESETS.filter((preset) => ids.includes(preset.id));

// How Release Manager reads the committed version: from the first
// language's preset, or package.json without one, as before presets.
export const versionReaderOf = (ids: readonly string[]): ((root: string, commit: string) => Promise<CommittedVersion>) =>
  (presetById(ids[0] ?? null) ?? typescriptPreset).version;

// The Environment Steward's adapter for a repository: that of its first
// language with one; null when none has.
export const setupOf = (ids: readonly string[]) => presetsOf(ids).find((preset) => preset.setup)?.setup ?? null;

// Manifests TaskPilot recognises, with the preset each points to; null
// when no preset for that language exists yet.
const LANGUAGES: { manifest: string; language: string; preset: string | null }[] = [
  { manifest: 'package.json', language: 'TypeScript / JavaScript', preset: 'typescript' },
  { manifest: 'Cargo.toml', language: 'Rust', preset: 'rust' },
  { manifest: 'pyproject.toml', language: 'Python', preset: 'python' },
  { manifest: 'requirements.txt', language: 'Python', preset: 'python' },
  { manifest: 'setup.py', language: 'Python', preset: 'python' },
];

export type Detection = { manifest: string; language: string; preset: string | null };

// What the tracked root manifests suggest, best match first.
export const detectLanguages = (tracked: ReadonlySet<string>): Detection[] =>
  LANGUAGES.filter((entry) => tracked.has(entry.manifest) && (entry.preset === null || presetById(entry.preset)?.detect(tracked)));
