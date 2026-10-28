// Notes channels: one global folder of Markdown files; the store validates
// every field.
import { logger } from '../infrastructure/logger.ts';
import { failWith, requireString } from '../infrastructure/coded_error.ts';
import * as noteSummary from '../agents/note_summary.ts';
import * as courses from '../courses/courses.ts';
import { throwIfCancelled } from '../agents/pipeline.ts';
import { registerContract } from './handler.ts';
import { notesContract } from '../../shared/ipc/notes.ts';
import type * as noteTypes from '../../shared/ipc/notes.ts';
import type { AppContext } from '../app/app_context.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { backgroundRuns, shell } = ctx;
  const requireNotes = () => ctx.notes ?? failWith('Notes are unavailable', 'unsupported');
  // The last folder the developer picked in the native dialog: the only
  // folder notes:set-directory accepts besides the default (null).
  let pickedNotesDirectory: string | null = null;

  registerContract(ipcMain, notesContract, {
    list: (since): noteTypes.NoteList | null => {
      const store = requireNotes();
      return since === store.revision ? null : store.list();
    },
    // The pack in use and the built-in ones, so the page can name categories;
    // a repository pack not yet confirmed is not in use (../courses.ts).

    courses: async (): Promise<noteTypes.NoteCourses> => {
      const { pack } = await ctx.course();
      return {
        current: pack.id,
        packs: courses.knownPacks(ctx.builtinCourses, pack).map((entry) => ({
          id: entry.id,
          title: entry.title,
          rubric: entry.rubric.map((item) => ({ id: item.id, label: item.label, dimension: item.dimension })),
        })),
      };
    },

    get: (rawId): noteTypes.Note => requireNotes().get(requireString(rawId, 'id')),

    search: (query): string[] => requireNotes().search(typeof query === 'string' ? query.slice(0, 200) : ''),

    create: (input, autoRename): Promise<noteTypes.NoteSaved> => requireNotes().create(input, { autoRename: autoRename === true }),

    update: (rawId, edit): Promise<noteTypes.NoteSaved> => requireNotes().update(requireString(rawId, 'id'), edit),

    remove: async (rawId): Promise<boolean> => {
      await requireNotes().remove(requireString(rawId, 'id'));
      return true;
    },

    // Tutor condenses the note into the summary grading reads. Waits for the
    // answer; the edit it saves is pinned to the version it summarised.

    summarize: async (rawId, rawVersion): Promise<noteTypes.NoteSaved> => {
      const store = requireNotes();
      const id = requireString(rawId, 'id');
      const baseVersion = requireString(rawVersion, 'baseVersion');
      const note = store.get(id);
      if (note.version !== baseVersion) return failWith('The note changed on disk since it was opened', 'note_conflict');
      if (backgroundRuns.has('note-summary', id)) return failWith('A summary of this note is already being written', 'invalid_state');
      const controller = backgroundRuns.start({ kind: 'note-summary', key: id, busy: 'tutor', agent: () => 'tutor', label: () => '笔记总结', once: true });
      const { path: envPath } = await ctx.commandPath();
      logger.debug(`[notes] summarize id=${id} length=${note.body.length}`);
      const run = (async () => {
        try {
          const { output } = await ctx.runnerFor('tutor')({
            prompt: noteSummary.summaryPrompt(note),
            systemPrompt: noteSummary.SUMMARY_SYSTEM_PROMPT,
            schema: noteSummary.SUMMARY_SCHEMA,
            envPath,
            signal: controller.signal,
          });
          throwIfCancelled(controller.signal);
          return await store.setSummary(id, noteSummary.validateSummary(output), baseVersion);
        } finally {
          backgroundRuns.finish('note-summary', id, controller);
        }
      })();
      backgroundRuns.track(run);
      return run;
    },

    pickDirectory: async (): Promise<string | null> => {
      if (!shell.pickDirectory) return failWith('Directory picker is unavailable', 'unsupported');
      pickedNotesDirectory = await shell.pickDirectory(requireNotes().directory);
      return pickedNotesDirectory;
    },

    setDirectory: (directory): Promise<noteTypes.NoteList> => {
      if (directory === null) return requireNotes().setDirectory(null);
      if (pickedNotesDirectory === null || directory !== pickedNotesDirectory)
        return failWith('Choose the folder with the folder picker', 'invalid_argument', 'directory');
      return requireNotes().setDirectory(pickedNotesDirectory);
    },

    openUrl: async (raw): Promise<boolean> => {
      if (!shell.openUrl) return failWith('Opening links is unavailable', 'unsupported');
      const url = requireString(raw, 'url');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return failWith('Not a link', 'invalid_argument', 'url');
      }
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return failWith('Only web and mail links open', 'invalid_argument', 'url');
      await shell.openUrl(parsed.href);
      return true;
    },

    reveal: async (): Promise<boolean> => {
      if (!shell.revealPath) return failWith('Opening the folder is unavailable', 'unsupported');
      await shell.revealPath(requireNotes().directory);
      return true;
    },
  });
};
