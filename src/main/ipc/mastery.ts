// Mastery channels: the notes due for review on the business day, and the
// learner's own verdict on one (remembered or not), which moves it through
// the Leitner boxes (../lab_progress.ts). Schedules live in mastery.json.
//
// [人工决策-2026-10-27 00:36:21] 带 concepts 的笔记按 Leitner 1 / 3 / 7 / 14 / 30 天排期；自评「记得」进下一档，「不记得」回第 1 档；
// 到期日按业务时区（env.businessTimeZone）的日界算。
import { failWith, requireString } from '../coded_error.ts';
import * as progress from '../lab_progress.ts';
import { businessDay } from '../activity_log.ts';
import { env as appEnv } from '../env.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as masteryTypes from '../../shared/ipc/mastery.ts';
import type { AppContext } from '../app_context.ts';
import type { IpcMainLike } from './handler.ts';

// Notes listed as due at most; the rest wait for the next day's list.
const MAX_DUE = 50;

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const requireMastery = () => ctx.mastery ?? failWith('Mastery is unavailable', 'unsupported');
  const requireNotes = () => ctx.notes ?? failWith('Notes are unavailable', 'unsupported');
  const today = () => businessDay(new Date(), appEnv.businessTimeZone);
  const schedules = () => progress.schedulesOf(requireNotes().list().notes, requireMastery().reviews(), appEnv.businessTimeZone);

  ipcMain.handle(
    CHANNELS.masteryReviews,
    wrap((): masteryTypes.ReviewList => {
      const day = today();
      const notes = new Map(
        requireNotes()
          .list()
          .notes.map((note) => [note.id, note]),
      );
      const all = schedules();
      const due = all
        .filter((schedule) => progress.isDue(schedule, day))
        .sort((a, b) => a.dueDay.localeCompare(b.dueDay))
        .slice(0, MAX_DUE)
        .map((schedule) => ({ ...schedule, title: notes.get(schedule.noteId)!.title, concepts: notes.get(schedule.noteId)!.concepts }));
      return { today: day, due, total: all.length };
    }),
  );

  // Only a note due today can be reviewed, so answering early cannot skip boxes.
  ipcMain.handle(
    CHANNELS.masteryReview,
    wrap(async (_event, rawId, remembered): Promise<masteryTypes.ReviewSchedule> => {
      const noteId = requireString(rawId, 'noteId');
      if (typeof remembered !== 'boolean') return failWith('remembered must be true or false', 'invalid_argument', 'remembered');
      const all = schedules();
      const schedule = all.find((entry) => entry.noteId === noteId) ?? failWith('This note has no concepts to review', 'not_reviewable', 'noteId');
      const day = today();
      if (!progress.isDue(schedule, day)) return failWith(`This note is due on ${schedule.dueDay}`, 'not_due', 'noteId');
      const next = progress.reviewed(schedule, remembered, day);
      await requireMastery().setReview(next, new Set(all.map((entry) => entry.noteId)));
      return next;
    }),
  );
};
