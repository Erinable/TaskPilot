// The exact, trusted course content a generated lab belongs to.
import { failWith } from '../infrastructure/coded_error.ts';
import * as courses from './courses.ts';
import * as courseFile from './course_file.ts';
import { isCourseId } from '../../shared/course_pack.ts';
import type { CoursePack, CourseRef } from '../../shared/course_pack.ts';

export type LabCourse = { pack: CoursePack; ref: CourseRef };

export const checkLabCourse = (pack: CoursePack, ref: CourseRef): LabCourse => {
  const normalized = courseFile.normalizeCourse(pack);
  if (normalized.id !== ref.id || normalized.version !== ref.version || courseFile.contentHash(normalized) !== ref.contentHash)
    return failWith('The generated lab course no longer matches its learning path', 'course_changed', 'course');
  return { pack: normalized, ref };
};

export const repositoryLabCourse = async (places: courses.CoursePlaces, id: string, supplied?: LabCourse): Promise<LabCourse | null> => {
  if (!isCourseId(id)) return failWith(`course: "${id}" is not a course pack`, 'unknown_course', 'course');
  if (supplied) {
    const snapshot = checkLabCourse(supplied.pack, supplied.ref);
    if (snapshot.ref.id !== id) return failWith(`course: "${id}" is not the generated course pack`, 'unknown_course', 'course');
    await trustedLabCourse(places, snapshot.ref);
    return snapshot;
  }
  if (!(await courses.availableCourses({ ...places, root: null })).some((entry) => entry.id === id))
    return failWith(`course: "${id}" is not a course pack`, 'unknown_course', 'course');
  return null;
};

export const trustedLabCourse = async (places: courses.CoursePlaces, expected: CourseRef): Promise<LabCourse> => {
  const entry = (await courses.availableCourses(places)).find((candidate) => candidate.id === expected.id);
  if (!entry) return failWith(`Course pack ${expected.id} is gone`, 'unknown_course', 'course');
  const loaded = await courses.loadCourse(places, entry);
  if (loaded.ref.source !== expected.source || loaded.ref.version !== expected.version || loaded.ref.contentHash !== expected.contentHash)
    return failWith(`Course pack ${expected.id} changed since the path was planned`, 'course_changed', 'course');
  if ((await courses.trustOf(places, loaded.ref)) === 'pending')
    return failWith(`Course pack ${expected.id} is not confirmed on this machine`, 'course_not_confirmed', 'course');
  return loaded;
};
