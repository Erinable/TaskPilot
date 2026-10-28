// Tutor channels (../agents/tutor.ts): one step's hint ladder, one level at
// a time, on request. The rules are in ../tutor_service.ts.
import { requireString } from '../infrastructure/coded_error.ts';
import { createTutorService } from '../work_packages/tutor_service.ts';
import { registerContract } from './handler.ts';
import { tutorContract } from '../../shared/ipc/tutor.ts';
import type * as tutorTypes from '../../shared/ipc/tutor.ts';
import type { AppContext } from '../app/app_context.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const tutor = createTutorService(ctx);

  registerContract(ipcMain, tutorContract, {
    get: (rawId, rawIndex): tutorTypes.TutorState => tutor.state(tutor.requireStep(requireString(rawId, 'id'), rawIndex)),

    // Opens the next level; a level already opened is returned as is and costs nothing.

    ask: (rawId, rawIndex, rawLevel): Promise<tutorTypes.TutorState> => tutor.ask(tutor.requireStep(requireString(rawId, 'id'), rawIndex), rawLevel),

    cancel: (rawId, rawIndex): boolean => tutor.cancel(tutor.requireStep(requireString(rawId, 'id'), rawIndex)),

    // The developer copied a Tutor snippet; counted for independence (T10).

    copied: (rawId): Promise<number> => tutor.countCopy(requireString(rawId, 'id')),
  });
};
