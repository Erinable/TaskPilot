// The built-in course packs as the app loads them: resources/courses/*.toml
// through src/main/courses/courses.ts, so tests see exactly what ships.
import path from 'node:path';
import { vi } from 'vitest';

import * as courses from '../../src/main/courses/courses.ts';

export const BUILTIN_COURSES_DIR = path.join(import.meta.dirname, '..', '..', courses.BUILTIN_COURSES_DIR);

const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
export const BUILTIN = await courses.loadBuiltinCourses(BUILTIN_COURSES_DIR);
debug.mockRestore();
export const BUILTIN_COURSES = [...BUILTIN.values()].map((entry) => entry.pack);
export const PROGRAMMING_COURSE = BUILTIN.get('programming')!.pack;
export const OS_COURSE = BUILTIN.get('os')!.pack;
