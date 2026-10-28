// Mastery channels: the notes due for review on the business day, and the
// learner's own verdict on one (remembered or not), which moves it through
// the Leitner boxes (../lab_progress.ts). Schedules live in mastery.json.
//
// [人工决策-2026-10-27 00:36:21] 带 concepts 的笔记按 Leitner 1 / 3 / 7 / 14 / 30 天排期；自评「记得」进下一档，「不记得」回第 1 档；
// 到期日按业务时区（env.businessTimeZone）的日界算。
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { failWith, requireString } from '../infrastructure/coded_error.ts';
import * as courses from '../courses/courses.ts';
import * as projectConfig from '../repository/project_config.ts';
import { PRESET_IDS } from '../checking/presets/index.ts';
import * as progress from '../courses/lab_progress.ts';
import { businessDay } from '../activity/activity_log.ts';
import { env as appEnv } from '../infrastructure/env.ts';
import { registerContract } from './handler.ts';
import { masteryContract } from '../../shared/ipc/mastery.ts';
import type * as masteryTypes from '../../shared/ipc/mastery.ts';
import type { AppContext } from '../app/app_context.ts';
import type { IpcMainLike } from './handler.ts';

// Notes listed as due at most; the rest wait for the next day's list.
const MAX_DUE = 50;

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const requireMastery = () => ctx.mastery ?? failWith('Mastery is unavailable', 'unsupported');
  const requireNotes = () => ctx.notes ?? failWith('Notes are unavailable', 'unsupported');
  const today = () => businessDay(new Date(), appEnv.businessTimeZone);
  const schedules = () => progress.schedulesOf(requireNotes().list().notes, requireMastery().reviews(), appEnv.businessTimeZone);

  // The registered lab repositories teaching `course`: one taskpilot.toml
  // read per repository in the registry, which the learner keeps short. A
  // missing or broken file is not a lab repository.
  const labRepositories = async (course: string) => {
    const current = ctx.repositories.current?.id ?? null;
    const found = await Promise.all(
      ctx.repositories.list().map(async (entry) => {
        try {
          const text = await projectConfig.readProjectText(entry.root);
          const project = text === null ? null : projectConfig.parseProject(text, PRESET_IDS);
          return project?.course === course && project.labs.length
            ? [{ id: entry.id, name: path.basename(entry.root), labs: project.labs.length, current: entry.id === current }]
            : [];
        } catch (error) {
          logger.debug(`[mastery] not a lab repository id=${entry.id} code=${(error as { code?: string }).code ?? 'unknown'}`);
          return [];
        }
      }),
    );
    return found.flat();
  };

  registerContract(ipcMain, masteryContract, {
    reviews: (): masteryTypes.ReviewList => {
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
    },

    // One course pack's concepts with how each stands, for the mastery page:
    // the pack in use when no id is given. Built-in packs, the repository's
    // and imported ones can be read; a pack's content is shown already on the
    // 课程 page, and mastery records are global.

    course: async (rawId): Promise<masteryTypes.CourseMastery> => {
      const places = ctx.coursePlaces();
      let pack;
      if (rawId === undefined || rawId === null) pack = (await ctx.course()).pack;
      else {
        const id = requireString(rawId, 'course');
        const entry = (await courses.availableCourses(places)).find((candidate) => candidate.id === id);
        pack = (await courses.loadCourse(places, entry ?? failWith(`Course pack ${id} is not available here`, 'unknown_course', 'course'))).pack;
      }
      return {
        ...progress.courseMastery({ id: pack.id, title: pack.title, concepts: pack.concepts ?? [] }, requireMastery().ofCourse(pack.id)),
        repositories: await labRepositories(pack.id),
      };
    },

    // Only a note due today can be reviewed, so answering early cannot skip boxes.

    review: async (rawId, remembered): Promise<masteryTypes.ReviewSchedule> => {
      const noteId = requireString(rawId, 'noteId');
      if (typeof remembered !== 'boolean') return failWith('remembered must be true or false', 'invalid_argument', 'remembered');
      const all = schedules();
      const schedule = all.find((entry) => entry.noteId === noteId) ?? failWith('This note has no concepts to review', 'not_reviewable', 'noteId');
      const day = today();
      if (!progress.isDue(schedule, day)) return failWith(`This note is due on ${schedule.dueDay}`, 'not_due', 'noteId');
      const next = progress.reviewed(schedule, remembered, day);
      await requireMastery().setReview(next, new Set(all.map((entry) => entry.noteId)));
      return next;
    },
  });
};
