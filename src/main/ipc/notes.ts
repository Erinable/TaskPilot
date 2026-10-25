// Notes channels: one global folder of Markdown files; the store validates
// every field.
import { failWith, requireString } from '../coded_error.ts';
import * as tutorAgent from '../agents/tutor.ts';
import { throwIfCancelled } from '../agents/pipeline.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as ipc from '../../shared/ipc_types.ts';
import type { AppContext } from '../app_context.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { backgroundRuns, shell } = ctx;
  const requireNotes = () => ctx.notes ?? failWith('Notes are unavailable', 'unsupported');
  // The last folder the developer picked in the native dialog: the only
  // folder notes:set-directory accepts besides the default (null).
  let pickedNotesDirectory: string | null = null;

  ipcMain.handle(
    CHANNELS.notesList,
    wrap((_event, since): ipc.NoteList | null => {
      const store = requireNotes();
      return since === store.revision ? null : store.list();
    }),
  );
  ipcMain.handle(
    CHANNELS.notesGet,
    wrap((_event, rawId): ipc.Note => requireNotes().get(requireString(rawId, 'id'))),
  );
  ipcMain.handle(
    CHANNELS.notesSearch,
    wrap((_event, query): string[] => requireNotes().search(typeof query === 'string' ? query.slice(0, 200) : '')),
  );
  ipcMain.handle(
    CHANNELS.notesCreate,
    wrap((_event, input, autoRename): Promise<ipc.NoteSaved> => requireNotes().create(input, { autoRename: autoRename === true })),
  );
  ipcMain.handle(
    CHANNELS.notesUpdate,
    wrap((_event, rawId, edit): Promise<ipc.NoteSaved> => requireNotes().update(requireString(rawId, 'id'), edit)),
  );
  ipcMain.handle(
    CHANNELS.notesDelete,
    wrap(async (_event, rawId): Promise<boolean> => {
      await requireNotes().remove(requireString(rawId, 'id'));
      return true;
    }),
  );

  // Tutor condenses the note into the summary grading reads. Waits for the
  // answer; the edit it saves is pinned to the version it summarised.
  ipcMain.handle(
    CHANNELS.notesSummarize,
    wrap(async (_event, rawId, rawVersion): Promise<ipc.NoteSaved> => {
      const store = requireNotes();
      const id = requireString(rawId, 'id');
      const baseVersion = requireString(rawVersion, 'baseVersion');
      const note = store.get(id);
      if (note.version !== baseVersion) return failWith('The note changed on disk since it was opened', 'note_conflict');
      if (backgroundRuns.has('note-summary', id)) return failWith('A summary of this note is already being written', 'invalid_state');
      const controller = backgroundRuns.start({ kind: 'note-summary', key: id, busy: 'tutor', label: () => '笔记总结', once: true });
      const { path: envPath } = await ctx.commandPath();
      console.debug(`[notes] summarize id=${id} length=${note.body.length}`);
      const run = (async () => {
        try {
          const { output } = await ctx.runnerFor('tutor')({
            prompt: tutorAgent.summaryPrompt(note),
            systemPrompt: tutorAgent.SUMMARY_SYSTEM_PROMPT,
            schema: tutorAgent.SUMMARY_SCHEMA,
            envPath,
            signal: controller.signal,
          });
          throwIfCancelled(controller.signal);
          return await store.setSummary(id, tutorAgent.validateSummary(output), baseVersion);
        } finally {
          backgroundRuns.finish('note-summary', id, controller);
        }
      })();
      backgroundRuns.track(run);
      return run;
    }),
  );

  ipcMain.handle(
    CHANNELS.notesPickDirectory,
    wrap(async (): Promise<string | null> => {
      if (!shell.pickDirectory) return failWith('Directory picker is unavailable', 'unsupported');
      pickedNotesDirectory = await shell.pickDirectory(requireNotes().directory);
      return pickedNotesDirectory;
    }),
  );
  ipcMain.handle(
    CHANNELS.notesSetDirectory,
    wrap((_event, directory): Promise<ipc.NoteList> => {
      if (directory === null) return requireNotes().setDirectory(null);
      if (pickedNotesDirectory === null || directory !== pickedNotesDirectory)
        return failWith('Choose the folder with the folder picker', 'invalid_argument', 'directory');
      return requireNotes().setDirectory(pickedNotesDirectory);
    }),
  );
  ipcMain.handle(
    CHANNELS.notesOpenUrl,
    wrap(async (_event, raw): Promise<boolean> => {
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
    }),
  );
  ipcMain.handle(
    CHANNELS.notesReveal,
    wrap(async (): Promise<boolean> => {
      if (!shell.revealPath) return failWith('Opening the folder is unavailable', 'unsupported');
      await shell.revealPath(requireNotes().directory);
      return true;
    }),
  );
};
