// Tutor channels (../agents/tutor.ts): one step's hint ladder, one level at
// a time, on request. The rules are in ../tutor_service.ts.
import { requireString } from '../coded_error.ts';
import { createTutorService } from '../tutor_service.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as tutorTypes from '../../shared/ipc/tutor.ts';
import type { AppContext } from '../app_context.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const tutor = createTutorService(ctx);

  ipcMain.handle(
    CHANNELS.tutorGet,
    wrap((_event, rawId, rawIndex): tutorTypes.TutorState => tutor.state(tutor.requireStep(requireString(rawId, 'id'), rawIndex))),
  );

  // Opens the next level; a level already opened is returned as is and costs nothing.
  ipcMain.handle(
    CHANNELS.tutorAsk,
    wrap((_event, rawId, rawIndex, rawLevel): Promise<tutorTypes.TutorState> => tutor.ask(tutor.requireStep(requireString(rawId, 'id'), rawIndex), rawLevel)),
  );

  ipcMain.handle(
    CHANNELS.tutorCancel,
    wrap((_event, rawId, rawIndex): boolean => tutor.cancel(tutor.requireStep(requireString(rawId, 'id'), rawIndex))),
  );

  // The developer copied a Tutor snippet; counted for independence (T10).
  ipcMain.handle(
    CHANNELS.tutorCopied,
    wrap((_event, rawId): Promise<number> => tutor.countCopy(requireString(rawId, 'id'))),
  );
};
