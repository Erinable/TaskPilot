// The course pack a repository teaches with. Picked, highest first, by this
// machine's workspace.json `course`, the repository's taskpilot.toml
// `course`, or else `programming`. A pack is built in, a file in the
// repository, `.taskpilot/courses/<id>.toml`, or one the user imported into
// the global folder, `userData/courses/<id>.toml` (./course_file.ts). A
// repository file wins over an imported one of the same id; neither can
// replace a built-in pack. Built-in packs ship with TaskPilot as files too
// (resources/courses/<id>.toml) and are loaded once at startup.
//
// [人工决策-2026-10-26 15:38:21] 一期只支持内置包和仓库内 .taskpilot/courses/*.toml；仓库内的包第一次加载、
// 或 contentHash 变化后，未经本机确认不注入（退回 programming，UI 提示"课程包待确认"），确认记录存在本机。
// 二期（T7f）加全局目录 userData/courses/：导入是校验后复制进去，同样未经确认不注入。
// [人工决策-2026-10-27 00:55:52] 内置课程包改为随应用打包的 TOML，与用户课程包走同一个加载器；仍然只读、不需要确认、
// 不能被同 id 的仓库包或导入包覆盖。用户想改就复制一份再改。
//
// SECURITY: a repository's pack is instructions to the agents, written by
// whoever wrote the repository. Until this machine confirms its content hash
// it is never returned as the pack in use. Confirmations live on this
// machine (course_trust.json), never in the repository: a repository's in
// its data directory, an imported pack's in userData.
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { readStoredJson, writeStoredJson } from '../infrastructure/persisted_json.ts';
import { codedError } from '../infrastructure/coded_error.ts';
import { WorkspaceError } from '../checking/command_line.ts';
import * as courseFile from './course_file.ts';
import { DEFAULT_COURSE_ID, isCourseId } from '../../shared/course_pack.ts';
import type { CoursePack, CourseRef, CourseSource } from '../../shared/course_pack.ts';
import type { CourseState, CourseView } from '../../shared/ipc/workspace.ts';
import type { LooseJson } from '../infrastructure/loose_json.ts';
import { writeFileAtomic } from '../infrastructure/atomic_json_file.ts';

export const COURSES_DIR = '.taskpilot/courses';
// Under userData: the packs the user imported.
const USER_COURSES_DIRNAME = 'courses';
export const TRUST_FILENAME = 'course_trust.json';
const TRUST_VERSION = 2;
// The built-in packs, relative to the project root in development; a
// packaged app has them in its Resources/courses (electron-builder.yml).
export const BUILTIN_COURSES_DIR = 'resources/courses';
export const MAX_COURSE_BYTES = 64 * 1024;
// More files than this in a folder are not listed.
const MAX_COURSE_FILES = 32;

// The packs that ship with TaskPilot, by id, the default first.
export type BuiltinCourses = ReadonlyMap<string, { pack: CoursePack; ref: CourseRef }>;

// The packs whose rubrics name note categories here: every built-in pack,
// in registry order, then the one in use when it is not built in.
export const knownPacks = (builtin: BuiltinCourses, inUse: CoursePack): CoursePack[] => {
  const packs = [...builtin.values()].map((entry) => entry.pack);
  return builtin.has(inUse.id) ? packs : [...packs, inUse];
};

export const defaultCourse = (builtin: BuiltinCourses) => builtin.get(DEFAULT_COURSE_ID)!;

// The pack in use, and how the repository's choice resolved.
export type CourseResolution = CourseView & { pack: CoursePack };

// Where packs and their confirmations are found. `root` is null without an
// open repository; `configDir` (userData) is null where there is no global
// folder (tests that only look at repository packs); `builtin` is what
// loadBuiltinCourses() read at startup.
export type CoursePlaces = { root: string | null; dataDir: string; configDir: string | null; builtin: BuiltinCourses };

export const userCoursesDir = (configDir: string) => path.join(configDir, USER_COURSES_DIRNAME);

// ========== Confirmations ==========
// Per repository (or userData, for imported packs): what this machine
// confirmed for each pack id, its content hash and the content itself, so
// a changed pack can list what changed. Version 1 kept only the hash.
export type Confirmation = { hash: string; pack: CoursePack | null };

const trustDir = (places: CoursePlaces, source: CourseSource) => {
  if (source === 'user') return places.configDir ?? null;
  return source === 'repository' ? places.dataDir : null;
};

// The stored pack is read back like any file on disk: validated, or dropped.
const storedPack = (value: unknown): CoursePack | null => {
  try {
    return courseFile.normalizeCourse(value);
  } catch (error) {
    if (error instanceof WorkspaceError) return null;
    throw error;
  }
};

const confirmationOf = (value: unknown): Confirmation | null => {
  if (typeof value === 'string') return { hash: value, pack: null };
  const raw = value as LooseJson;
  if (!raw || typeof raw !== 'object' || typeof raw.hash !== 'string') return null;
  return { hash: raw.hash, pack: raw.pack === undefined ? null : storedPack(raw.pack) };
};

const readTrust = async (dir: string): Promise<Record<string, Confirmation>> => {
  let raw: LooseJson;
  try {
    raw = (await readStoredJson(path.join(dir, TRUST_FILENAME), TRUST_VERSION)) as LooseJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  const confirmed = raw?.confirmed && typeof raw.confirmed === 'object' ? (raw.confirmed as LooseJson) : {};
  return Object.fromEntries(
    Object.entries(confirmed).flatMap(([id, value]) => {
      const confirmation = isCourseId(id) ? confirmationOf(value) : null;
      return confirmation ? [[id, confirmation]] : [];
    }),
  );
};

// What this machine last confirmed for the pack `ref` names; null when
// nothing, and always null for a built-in pack.
export const confirmationFor = async (places: CoursePlaces, ref: CourseRef): Promise<Confirmation | null> => {
  const dir = trustDir(places, ref.source);
  return dir ? ((await readTrust(dir))[ref.id] ?? null) : null;
};

const isConfirmed = async (places: CoursePlaces, ref: CourseRef) => (await confirmationFor(places, ref))?.hash === ref.contentHash;

// Confirms `pack` at its content on this machine. Built-in packs need none.
export const confirm = async (places: CoursePlaces, pack: CoursePack, ref: CourseRef) => {
  const dir = trustDir(places, ref.source);
  if (!dir) throw new WorkspaceError(`Course pack ${ref.id} needs no confirmation`, 'invalid_course', 'course');
  const confirmed = { ...(await readTrust(dir)), [ref.id]: { hash: ref.contentHash, pack } };
  await fs.mkdir(dir, { recursive: true });
  await writeStoredJson(path.join(dir, TRUST_FILENAME), { version: TRUST_VERSION, confirmed });
  logger.debug(`[courses] confirmed id=${ref.id} source=${ref.source} hash=${ref.contentHash.slice(0, 12)}`);
};

// ========== Pack files ==========
// The ids of the pack files in `dir`, from their file names. Only regular
// files are listed, never symlinks.
const listCourseFiles = async (dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
  const ids = entries.flatMap((entry) => (entry.isFile() && entry.name.endsWith('.toml') ? [entry.name.slice(0, -'.toml'.length)] : []));
  return ids.filter(isCourseId).sort().slice(0, MAX_COURSE_FILES);
};

// Validates a pack file's text; `label` names the file in errors. The
// file's `id` must be `id` when given (its name).
export const parseCourseText = (text: string, source: CourseSource, label: string, id: string | null = null): { pack: CoursePack; ref: CourseRef } => {
  if (Buffer.byteLength(text) > MAX_COURSE_BYTES) throw new WorkspaceError(`${label} is larger than 64 KB`, 'invalid_course', 'toml');
  const pack = courseFile.parseCourse(text);
  if (id !== null && pack.id !== id) throw new WorkspaceError(`id: must be "${id}", the file's name`, 'invalid_course', 'id');
  return { pack, ref: { id: pack.id, version: pack.version, contentHash: courseFile.contentHash(pack), source } };
};

const readCourseFile = async (dir: string, id: string, source: CourseSource, label: string) => {
  const file = path.join(dir, `${id}.toml`);
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new WorkspaceError(`${label} must be a regular file`, 'invalid_course', 'toml');
  if (stat.size > MAX_COURSE_BYTES) throw new WorkspaceError(`${label} is larger than 64 KB`, 'invalid_course', 'toml');
  return parseCourseText(await fs.readFile(file, 'utf8'), source, label, id);
};

export const listRepositoryCourses = (root: string) => listCourseFiles(path.join(root, COURSES_DIR));

// Reads and validates `.taskpilot/courses/<id>.toml`.
export const readRepositoryCourse = (root: string, id: string) => readCourseFile(path.join(root, COURSES_DIR), id, 'repository', `${COURSES_DIR}/${id}.toml`);

export const listUserCourses = (configDir: string) => listCourseFiles(userCoursesDir(configDir));

const readUserCourse = (configDir: string, id: string) => readCourseFile(userCoursesDir(configDir), id, 'user', `${USER_COURSES_DIRNAME}/${id}.toml`);

// Copies a validated pack's text into the global folder, as `<id>.toml`.
export const importCourse = async (configDir: string, text: string, ref: CourseRef) => {
  const dir = userCoursesDir(configDir);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, `${ref.id}.toml`), text);
  logger.debug(`[courses] imported id=${ref.id} hash=${ref.contentHash.slice(0, 12)}`);
};

// [人工决策-2026-10-27 00:55:52] 用户想改课程包就复制一份再改：复制品和编辑后的包都写进全局目录，来源是 user，
// 照常要本机确认后才会用（沿用 [人工决策-2026-10-26 15:38:21] 的信任模型）。
// Validates a pack from the pack editor and writes it into the global
// folder as `<id>.toml`. The text is generated from the validated content,
// so reading the file back gives the same pack and hash. Never confirms.
export const writeUserCourse = async (configDir: string, value: unknown): Promise<{ pack: CoursePack; ref: CourseRef }> => {
  const pack = courseFile.normalizeCourse(value);
  const text = courseFile.courseText(pack);
  const written = parseCourseText(text, 'user', `${USER_COURSES_DIRNAME}/${pack.id}.toml`, pack.id);
  const dir = userCoursesDir(configDir);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, `${pack.id}.toml`), text);
  logger.debug(`[courses] saved id=${pack.id} hash=${written.ref.contentHash.slice(0, 12)}`);
  return written;
};

// [人工决策-2026-10-26 15:38:21] 内置包：programming（默认）和 os（T7e 加入，用来验证结构）；仓库里的同名文件不能替换内置包。
// Reads every pack file in `dir` (resources/courses/, in the app bundle
// Resources/courses/) as built in. A file that does not validate, or a
// missing default pack, is TaskPilot's own bug, so startup fails with it.
export const loadBuiltinCourses = async (dir: string): Promise<BuiltinCourses> => {
  const ids = await listCourseFiles(dir);
  if (!ids.includes(DEFAULT_COURSE_ID))
    throw new WorkspaceError(`The built-in course pack ${DEFAULT_COURSE_ID}.toml is missing from ${dir}`, 'invalid_course', 'course');
  const ordered = [DEFAULT_COURSE_ID, ...ids.filter((id) => id !== DEFAULT_COURSE_ID)];
  const loaded = await Promise.all(
    ordered.map(async (id) => {
      try {
        return await readCourseFile(dir, id, 'builtin', `${id}.toml`);
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        throw new WorkspaceError(`The built-in course pack ${id}.toml does not validate: ${error.message}`, error.code, error.field);
      }
    }),
  );
  logger.debug(`[courses] built-in loaded dir=${dir} ids=${ordered.join(',')}`);
  return new Map(loaded.map((entry) => [entry.pack.id, entry]));
};

const errorInfo = (error: unknown) => {
  if (!(error instanceof WorkspaceError)) throw error;
  return { code: error.code, message: error.message, field: error.field ?? null };
};

// ========== Resolution ==========
type Choice = { local: string | null; project: string | null };

// Which id the repository asks for, and which layer asked.
const selection = ({ local, project }: Choice): CourseView['selected'] => {
  if (local) return { id: local, from: 'local' };
  if (project) return { id: project, from: 'project' };
  return { id: DEFAULT_COURSE_ID, from: 'default' };
};

// Every pack that can be picked here: built-in, then the repository's, then
// imported ones the repository does not have.
export const availableCourses = async ({ root, configDir, builtin }: CoursePlaces): Promise<CourseView['available']> => {
  const repositoryIds = root ? (await listRepositoryCourses(root)).filter((id) => !builtin.has(id)) : [];
  const userIds = configDir ? (await listUserCourses(configDir)).filter((id) => !builtin.has(id) && !repositoryIds.includes(id)) : [];
  return [
    ...[...builtin.keys()].map((id) => ({ id, source: 'builtin' as const })),
    ...repositoryIds.map((id) => ({ id, source: 'repository' as const })),
    ...userIds.map((id) => ({ id, source: 'user' as const })),
  ];
};

// Reads the pack `entry` names; a built-in one is returned as loaded at startup.
export const loadCourse = async (places: CoursePlaces, entry: CourseView['available'][number]): Promise<{ pack: CoursePack; ref: CourseRef }> => {
  const builtin = places.builtin.get(entry.id);
  if (builtin) return builtin;
  if (entry.source === 'repository' && places.root) return readRepositoryCourse(places.root, entry.id);
  if (entry.source === 'user' && places.configDir) return readUserCourse(places.configDir, entry.id);
  throw codedError(`course: "${entry.id}" is not a course pack`, 'unknown_course', 'course');
};

// Whether this machine may use a loaded pack: built-in ones always, others
// once confirmed at their content.
export const trustOf = async (places: CoursePlaces, ref: CourseRef) => {
  if (ref.source === 'builtin') return 'builtin' as const;
  return (await isConfirmed(places, ref)) ? ('confirmed' as const) : ('pending' as const);
};

// The pack `choice` names, or the built-in programming pack when it is
// unknown, broken or not yet confirmed on this machine; `state` says which.
export const resolveCourse = async (places: CoursePlaces, choice: Choice): Promise<CourseResolution> => {
  const selected = selection(choice);
  const available = await availableCourses(places);
  const fallback = defaultCourse(places.builtin);
  const result = (state: CourseState, used = fallback): CourseResolution => ({ selected, available, state, ref: used.ref, pack: used.pack });

  const entry = available.find((candidate) => candidate.id === selected.id);
  if (!entry) {
    const message = `course: "${selected.id}" is not a course pack; use one of ${available.map((candidate) => candidate.id).join(', ')}`;
    return result({ status: 'invalid', error: { code: 'unknown_course', message, field: 'course' } });
  }
  let loaded;
  try {
    loaded = await loadCourse(places, entry);
  } catch (error) {
    return result({ status: 'invalid', error: errorInfo(error) });
  }
  if ((await trustOf(places, loaded.ref)) === 'pending') return result({ status: 'pending', pack: loaded.pack, ref: loaded.ref });
  return result({ status: 'ok' }, loaded);
};
