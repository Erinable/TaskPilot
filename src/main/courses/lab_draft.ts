// Private lab draft and self-check persistence. These files contain the
// generated solution and never cross the main-process boundary. Drafts from
// before lab toolchains (v1 or unversioned) have no toolchain and no
// program, so they are refused as lab_outdated: the lab is generated again.
import fs from 'node:fs/promises';
import path from 'node:path';

import { failWith } from '../infrastructure/coded_error.ts';
import { readStoredJson, writeStoredJson } from '../infrastructure/persisted_json.ts';
import type * as labVerify from './lab_verify.ts';
import type { LabDraft } from './lab_artifact.ts';
import { draftPath, verifyPath } from './lab_artifact.ts';

const VERSION = 2;
type VersionedDraft = { version: typeof VERSION } & LabDraft;
type VersionedReport = { version: number } & labVerify.LabVerifyReport;

const currentDraft = (value: unknown): LabDraft => {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== VERSION)
    return failWith('This lab was generated before lab toolchains; generate it again', 'lab_outdated');
  const stored = value as VersionedDraft;
  return { requirementId: stored.requirementId, request: stored.request, lab: stored.lab, costUsd: stored.costUsd };
};

const currentReport = (value: unknown): labVerify.LabVerifyReport | null => {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'version' in value) {
    const { version: _version, ...report } = value as VersionedReport;
    return report;
  }
  return value as labVerify.LabVerifyReport | null;
};

export const writeDraft = async (configDir: string, draft: LabDraft): Promise<void> => {
  const file = draftPath(configDir, draft.requirementId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeStoredJson(file, { version: VERSION, ...draft }, { mode: 0o600 });
};

export const readDraft = async (configDir: string, requirementId: string): Promise<LabDraft> => {
  const file = draftPath(configDir, requirementId);
  try {
    return currentDraft(await readStoredJson(file, VERSION));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return failWith('No lab has been generated for this requirement', 'no_lab_draft');
    }
    throw error;
  }
};

export const writeReport = async (configDir: string, requirementId: string, report: labVerify.LabVerifyReport): Promise<void> => {
  await writeStoredJson(verifyPath(configDir, requirementId), { version: VERSION, ...report }, { mode: 0o600 });
};

export const readReport = async (configDir: string, requirementId: string): Promise<labVerify.LabVerifyReport | null> => {
  try {
    return currentReport(await readStoredJson(verifyPath(configDir, requirementId), VERSION));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};
