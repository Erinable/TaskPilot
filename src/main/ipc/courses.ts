// Course pack channels: the packs the open repository can pick from, a
// pack's full content (with what changed since this machine confirmed it),
// picking one in workspace.json, importing a file into userData/courses/,
// and copying a pack there and saving the copy from the pack editor.
// Confirming the pack in use is workspace:confirm-course (./workspace.ts).
//
// [人工决策-2026-10-26 15:38:21] 切换课程包只写本机 workspace.json 的 course，只影响之后的规划和判卷；
// 已有的计划、工作包和判卷记录带着各自的 CourseRef / rubric 快照，不改写。
import fs from 'node:fs/promises';

import { logger } from '../infrastructure/logger.ts';
import { failWith, requireString } from '../infrastructure/coded_error.ts';
import * as courses from '../courses/courses.ts';
import { registerContract } from './handler.ts';
import { coursesContract } from '../../shared/ipc/courses.ts';
import { courseChanges } from '../../shared/course_changes.ts';
import type * as courseTypes from '../../shared/ipc/courses.ts';
import { isCourseId } from '../../shared/course_pack.ts';
import type { CoursePack, CourseRef } from '../../shared/course_pack.ts';
import type { AppContext } from '../app/app_context.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { configDir, shell } = ctx;
  // The file the developer last picked in the native dialog, validated: the
  // only content courses:import copies, so the renderer never names a path.
  let pickedImport: { text: string; pack: CoursePack; ref: CourseRef } | null = null;

  // What this machine confirmed before, against `pack`'s content now.
  const previousOf = async (pack: CoursePack, ref: CourseRef): Promise<Pick<courseTypes.CoursePreview, 'previous' | 'changes'>> => {
    const confirmation = await courses.confirmationFor(ctx.coursePlaces(), ref);
    if (!confirmation) return { previous: 'none', changes: [] };
    if (!confirmation.pack) return { previous: 'unknown', changes: [] };
    return { previous: 'known', changes: courseChanges(confirmation.pack, pack) };
  };

  const list = async (): Promise<courseTypes.CourseList> => {
    const places = ctx.coursePlaces();
    const [{ pack: _pack, ...current }, profile] = await Promise.all([ctx.course(), ctx.profile()]);
    const entries = await Promise.all(
      current.available.map(async (entry): Promise<courseTypes.CourseEntry> => {
        try {
          const { pack, ref } = await courses.loadCourse(places, entry);
          const languages = pack.appliesTo?.languages ?? null;
          return { ...entry, title: pack.title, version: pack.version, languages, trust: await courses.trustOf(places, ref), error: null };
        } catch (error) {
          if ((error as { code?: string }).code !== 'invalid_course') throw error;
          return { ...entry, title: null, version: null, languages: null, trust: 'invalid', error: (error as Error).message };
        }
      }),
    );
    return { current, entries, languages: profile?.languages.map((language) => language.id) ?? [], userDir: courses.userCoursesDir(configDir) };
  };

  const previewOf = async (pack: CoursePack, ref: CourseRef): Promise<courseTypes.CoursePreview> => ({
    pack,
    ref,
    trust: await courses.trustOf(ctx.coursePlaces(), ref),
    ...(await previousOf(pack, ref)),
  });

  const entryOf = async (rawId: unknown) => {
    const id = requireString(rawId, 'id');
    const entry = (await courses.availableCourses(ctx.coursePlaces())).find((candidate) => candidate.id === id);
    return entry ?? failWith(`Course pack ${id} is not available here`, 'unknown_course', 'course');
  };

  registerContract(ipcMain, coursesContract, {
    list: () => list(),

    // The built-in default pack: what the renderer shows for packages, grades
    // and notes from before packs.

    default: (): CoursePack => courses.defaultCourse(ctx.builtinCourses).pack,

    preview: async (rawId): Promise<courseTypes.CoursePreview> => {
      const { pack, ref } = await courses.loadCourse(ctx.coursePlaces(), await entryOf(rawId));
      return previewOf(pack, ref);
    },

    // Writes this machine's choice to workspace.json; null leaves it to
    // taskpilot.toml. A pack that needs confirming is picked as it is and
    // reported pending, so programming stays in use until it is confirmed.

    select: async (rawId): Promise<courseTypes.CourseList> => {
      ctx.requireRoot();
      const course = rawId === null ? null : (await entryOf(rawId)).id;
      const saved = await ctx.repositories.saveConfig({ ...ctx.getConfig(), course });
      ctx.setConfig(saved);
      ctx.changed('courses', 'workspace');
      logger.debug(`[courses] selected id=${course ?? '(taskpilot.toml)'}`);
      return list();
    },

    // Picks a pack file and validates it, writing nothing. The preview is
    // shown in full before courses:import copies it.

    pickImport: async (): Promise<courseTypes.CourseImport | null> => {
      if (!shell.pickFile) return failWith('File picker is unavailable', 'unsupported');
      pickedImport = null;
      const file = await shell.pickFile(null, [{ name: 'Course pack', extensions: ['toml'] }]);
      if (file === null) return null;
      const stat = await fs.stat(file);
      if (!stat.isFile()) return failWith('The course pack must be a file', 'invalid_course', 'toml');
      if (stat.size > courses.MAX_COURSE_BYTES) return failWith('The course pack is larger than 64 KB', 'invalid_course', 'toml');
      const text = await fs.readFile(file, 'utf8');
      const { pack, ref } = courses.parseCourseText(text, 'user', 'The course pack');
      if (ctx.builtinCourses.has(pack.id)) return failWith(`id: "${pack.id}" is a built-in course pack`, 'invalid_course', 'id');
      const replaces = (await courses.listUserCourses(configDir)).includes(pack.id);
      const root = ctx.getConfig().root;
      const shadowed = root ? (await courses.listRepositoryCourses(root)).includes(pack.id) : false;
      pickedImport = { text, pack, ref };
      logger.debug(`[courses] picked import id=${pack.id} replaces=${replaces} shadowed=${shadowed}`);
      return { pack, ref, trust: await courses.trustOf(ctx.coursePlaces(), ref), ...(await previousOf(pack, ref)), replaces, shadowed };
    },

    // Copies the picked file into the global folder. `contentHash` is the one
    // shown; importing never confirms the pack.

    import: async (rawHash): Promise<courseTypes.CourseList> => {
      const contentHash = requireString(rawHash, 'contentHash');
      if (!pickedImport || pickedImport.ref.contentHash !== contentHash)
        return failWith('Choose the course pack file with the file picker', 'invalid_argument', 'contentHash');
      await courses.importCourse(configDir, pickedImport.text, pickedImport.ref);
      ctx.changed('courses');
      pickedImport = null;
      return list();
    },

    // [人工决策-2026-10-27 00:55:52] 内置包只读，想改就复制一份：复制品写进全局目录 userData/courses/<newId>.toml，
    // 来源是 user，要本机确认后才会用。仓库里的包也只能复制再改，不从这里写仓库文件。
    // Copies any pack here into the global folder under the id the user
    // gave. The id must be free: not built in, not the repository's, not
    // imported already. Copying never confirms.

    copy: async (rawSourceId, rawId): Promise<courseTypes.CourseSaved> => {
      const places = ctx.coursePlaces();
      const source = await courses.loadCourse(places, await entryOf(rawSourceId));
      const id = requireString(rawId, 'id');
      if (!isCourseId(id)) return failWith('id: must be lowercase letters, digits, - or _, start with a letter and be at most 32 long', 'invalid_course', 'id');
      if ((await courses.availableCourses(places)).some((entry) => entry.id === id) || (await courses.listUserCourses(configDir)).includes(id))
        return failWith(`id: "${id}" is already a course pack`, 'course_exists', 'id');
      const { pack, ref } = await courses.writeUserCourse(configDir, { ...source.pack, id });
      ctx.changed('courses');
      logger.debug(`[courses] copied from=${source.ref.id} id=${id}`);
      return { list: await list(), preview: await previewOf(pack, ref) };
    },

    // Saves a pack from the pack editor over its file in the global folder.
    // Only imported or copied packs can be saved, and only under their own
    // id; the content is validated again here, whatever the editor checked.
    // A saved pack has a new content hash, so it is pending again.

    save: async (rawId, rawPack): Promise<courseTypes.CourseSaved> => {
      const entry = await entryOf(rawId);
      if (entry.source !== 'user') return failWith(`Course pack ${entry.id} is read-only here; copy it to edit it`, 'course_read_only', 'course');
      if ((rawPack as { id?: unknown } | null)?.id !== entry.id) return failWith(`id: must stay "${entry.id}"`, 'invalid_course', 'id');
      const { pack, ref } = await courses.writeUserCourse(configDir, rawPack);
      ctx.changed('courses');
      return { list: await list(), preview: await previewOf(pack, ref) };
    },
  });
};
