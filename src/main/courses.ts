// The course pack a repository teaches with. Picked, highest first, by this
// machine's workspace.json `course`, the repository's taskpilot.toml
// `course`, or else `programming`. A pack is built in or a file in the
// repository, `.taskpilot/courses/<id>.toml` (./course_file.ts).
//
// [人工决策-2026-10-26 15:38:21] 一期只支持内置包和仓库内 .taskpilot/courses/*.toml；仓库内的包第一次加载、
// 或 contentHash 变化后，未经本机确认不注入（退回 programming，UI 提示"课程包待确认"），确认记录存在本机。
//
// SECURITY: a repository's pack is instructions to the agents, written by
// whoever wrote the repository. Until this machine confirms its content hash
// it is never returned as the pack in use. Confirmations live in the
// repository's data directory (course_trust.json), never in the repository.
import fs from 'node:fs/promises';
import path from 'node:path';

import { jsonText, writeFileAtomic } from './atomic_json_file.ts';
import { WorkspaceError } from './command_line.ts';
import * as courseFile from './course_file.ts';
import { BUILTIN_COURSES, PROGRAMMING_COURSE, isCourseId } from '../shared/course_pack.ts';
import type { CoursePack, CourseRef } from '../shared/course_pack.ts';
import type { CourseState, CourseView } from '../shared/ipc/workspace.ts';
import type { LooseJson } from './loose_json.ts';

export const COURSES_DIR = '.taskpilot/courses';
export const TRUST_FILENAME = 'course_trust.json';
const DEFAULT_COURSE = PROGRAMMING_COURSE.id;
const MAX_COURSE_BYTES = 64 * 1024;
// More files than this in the folder are not listed.
const MAX_COURSE_FILES = 32;

const builtinRef = (pack: CoursePack): CourseRef => ({ id: pack.id, version: pack.version, contentHash: courseFile.contentHash(pack), source: 'builtin' });

// [人工决策-2026-10-26 15:38:21] 内置包：programming（默认）和 os（T7e 加入，用来验证结构）；仓库里的同名文件不能替换内置包。
const BUILTIN: ReadonlyMap<string, { pack: CoursePack; ref: CourseRef }> = new Map(BUILTIN_COURSES.map((pack) => [pack.id, { pack, ref: builtinRef(pack) }]));

// The pack in use, and how the repository's choice resolved.
export type CourseResolution = CourseView & { pack: CoursePack };

// ========== Confirmations ==========
// Per repository: the content hash this machine confirmed for each pack id.
// A changed pack needs confirming again.
const readTrust = async (dataDir: string): Promise<Record<string, string>> => {
  let raw: LooseJson;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dataDir, TRUST_FILENAME), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // A broken file confirms nothing; the user is asked again.
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  const confirmed = raw?.confirmed && typeof raw.confirmed === 'object' ? (raw.confirmed as LooseJson) : {};
  return Object.fromEntries(Object.entries(confirmed).filter(([id, hash]) => isCourseId(id) && typeof hash === 'string'));
};

const isConfirmed = async (dataDir: string, ref: CourseRef) => (await readTrust(dataDir))[ref.id] === ref.contentHash;

export const confirm = async (dataDir: string, ref: CourseRef) => {
  const confirmed = { ...(await readTrust(dataDir)), [ref.id]: ref.contentHash };
  await fs.mkdir(dataDir, { recursive: true });
  await writeFileAtomic(path.join(dataDir, TRUST_FILENAME), jsonText({ version: 1, confirmed }));
  console.debug(`[courses] confirmed id=${ref.id} hash=${ref.contentHash.slice(0, 12)}`);
};

// ========== Repository files ==========
// The ids of the pack files in the repository, from their file names.
// Only regular files are listed, never symlinks.
export const listRepositoryCourses = async (root: string): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, COURSES_DIR), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
  const ids = entries.flatMap((entry) => (entry.isFile() && entry.name.endsWith('.toml') ? [entry.name.slice(0, -'.toml'.length)] : []));
  return ids.filter(isCourseId).sort().slice(0, MAX_COURSE_FILES);
};

// Reads and validates `.taskpilot/courses/<id>.toml`. The file's `id` must
// match its name.
export const readRepositoryCourse = async (root: string, id: string): Promise<{ pack: CoursePack; ref: CourseRef }> => {
  const relative = `${COURSES_DIR}/${id}.toml`;
  const stat = await fs.lstat(path.join(root, relative));
  if (!stat.isFile()) throw new WorkspaceError(`${relative} must be a regular file`, 'invalid_course', 'toml');
  if (stat.size > MAX_COURSE_BYTES) throw new WorkspaceError(`${relative} is larger than 64 KB`, 'invalid_course', 'toml');
  const pack = courseFile.parseCourse(await fs.readFile(path.join(root, relative), 'utf8'));
  if (pack.id !== id) throw new WorkspaceError(`id: must be "${id}", the file's name`, 'invalid_course', 'id');
  return { pack, ref: { id, version: pack.version, contentHash: courseFile.contentHash(pack), source: 'repository' } };
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
  return { id: DEFAULT_COURSE, from: 'default' };
};

// The pack `choice` names, or the built-in programming pack when it is
// unknown, broken or not yet confirmed on this machine; `state` says which.
// `root` is null without an open repository, so only built-in packs exist.
export const resolveCourse = async (root: string | null, dataDir: string, choice: Choice): Promise<CourseResolution> => {
  const selected = selection(choice);
  const repositoryIds = root ? (await listRepositoryCourses(root)).filter((id) => !BUILTIN.has(id)) : [];
  const available: CourseView['available'] = [
    ...[...BUILTIN.keys()].map((id) => ({ id, source: 'builtin' as const })),
    ...repositoryIds.map((id) => ({ id, source: 'repository' as const })),
  ];
  const fallback = BUILTIN.get(DEFAULT_COURSE)!;
  const result = (state: CourseState, used = fallback): CourseResolution => ({ selected, available, state, ref: used.ref, pack: used.pack });

  const builtin = BUILTIN.get(selected.id);
  if (builtin) return result({ status: 'ok' }, builtin);
  if (!root || !repositoryIds.includes(selected.id)) {
    const message = `course: "${selected.id}" is not a course pack; use one of ${available.map((entry) => entry.id).join(', ')}`;
    return result({ status: 'invalid', error: { code: 'unknown_course', message, field: 'course' } });
  }
  let loaded;
  try {
    loaded = await readRepositoryCourse(root, selected.id);
  } catch (error) {
    return result({ status: 'invalid', error: errorInfo(error) });
  }
  if (!(await isConfirmed(dataDir, loaded.ref))) return result({ status: 'pending', pack: loaded.pack, ref: loaded.ref });
  return result({ status: 'ok' }, loaded);
};
