// The built-in course packs as the app loads them: resources/courses/*.toml
// through src/main/courses.ts, so tests see exactly what ships.
import path from 'node:path';

import * as courses from '../../src/main/courses.ts';

export const BUILTIN_COURSES_DIR = path.join(import.meta.dirname, '..', '..', courses.BUILTIN_COURSES_DIR);

export const BUILTIN = await courses.loadBuiltinCourses(BUILTIN_COURSES_DIR);
export const BUILTIN_COURSES = [...BUILTIN.values()].map((entry) => entry.pack);
export const PROGRAMMING_COURSE = BUILTIN.get('programming')!.pack;
export const OS_COURSE = BUILTIN.get('os')!.pack;
