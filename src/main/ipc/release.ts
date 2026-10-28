// Release Manager channels: argument validation and routing only.
import { failWith, requireString } from '../infrastructure/coded_error.ts';
import { registerContract } from './handler.ts';
import { releaseContract } from '../../shared/ipc/release.ts';
import type * as releaseTypes from '../../shared/ipc/release.ts';
import type { AppContext } from '../app/app_context.ts';
import type { ReleaseService } from '../release/release_service.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext, { release }: { release: ReleaseService }) => {
  registerContract(ipcMain, releaseContract, {
    createMilestone: async (raw): Promise<releaseTypes.ReleaseState> => release.createMilestone(raw),

    updateMilestone: async (rawId, raw): Promise<releaseTypes.ReleaseState> => release.updateMilestone(requireString(rawId, 'id'), raw),

    deleteMilestone: async (rawId): Promise<releaseTypes.ReleaseState> => release.deleteMilestone(requireString(rawId, 'id')),

    assignMilestone: async (rawRequirementId, rawMilestoneId): Promise<releaseTypes.ReleaseState> => {
      const requirementId = requireString(rawRequirementId, 'requirementId');
      if (!(ctx.requirements?.list() ?? []).some((item) => item.id === requirementId)) failWith('Unknown requirement', 'invalid_argument', 'requirementId');
      const milestoneId = rawMilestoneId === null ? null : requireString(rawMilestoneId, 'milestoneId');
      return release.assignMilestone(requirementId, milestoneId);
    },

    get: (): Promise<releaseTypes.ReleaseState> => release.getState(),

    recentCommits: (): Promise<releaseTypes.ReleaseCommit[]> => release.recentCommits(),

    generate: async (rawStart): Promise<releaseTypes.ReleaseState> => {
      const start = rawStart === undefined || rawStart === null ? rawStart : requireString(rawStart, 'startCommit');
      return release.generate(start);
    },

    updateDraft: async (raw): Promise<releaseTypes.ReleaseState> => release.updateDraft(raw),

    finish: (): Promise<releaseTypes.Release> => release.finish(),

    writeNotes: async (raw): Promise<releaseTypes.ReleaseWriteResult> => {
      const requested = requireString((raw as releaseTypes.ReleaseWriteInput | null | undefined)?.path, 'path').trim();
      return release.writeNotes(requested);
    },

    cancel: (): boolean => release.cancel(),
  });
};
