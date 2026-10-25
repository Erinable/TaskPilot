// The language presets taskpilot.toml can name, and which one a repository
// looks like it wants. Recognised languages without a preset yet are
// reported so the user knows why none is offered.
import { typescriptPreset } from './typescript.ts';
import type { Preset } from './preset.ts';

export const PRESETS: Preset[] = [typescriptPreset as Preset];

export const PRESET_IDS = PRESETS.map((preset) => preset.id);

export const presetById = (id: string | null) => PRESETS.find((preset) => preset.id === id) ?? null;

// Manifests TaskPilot recognises, with the preset each points to; null
// when no preset for that language exists yet.
const LANGUAGES: { manifest: string; language: string; preset: string | null }[] = [
  { manifest: 'package.json', language: 'TypeScript / JavaScript', preset: 'typescript' },
  { manifest: 'Cargo.toml', language: 'Rust', preset: null },
  { manifest: 'pyproject.toml', language: 'Python', preset: null },
];

export type Detection = { manifest: string; language: string; preset: string | null };

// What the tracked root manifests suggest, best match first.
export const detectLanguages = (tracked: ReadonlySet<string>): Detection[] =>
  LANGUAGES.filter((entry) => tracked.has(entry.manifest) && (entry.preset === null || presetById(entry.preset)?.detect(tracked)));
