// A course pack file: `.taskpilot/courses/<id>.toml` in the repository.
// Parsed and validated field by field, in the style of ./project_config.ts;
// every error names its field, e.g. `rubric[1].dimension`.
//
//   schemaVersion = 1
//   id = "os"
//   version = "0.1.0"
//   domain = "operating-systems"
//   title = "操作系统实验"
//   summary = "..."
//   learner = "a student learning operating systems who can already write basic C"
//   tutorGuide = ["..."]           # 1 to 8 lines, each at most 300 characters
//   difficultyGuide = ["..."]
//   practiceGuide = ["..."]
//   referenceGuide = "..."
//   appliesTo = { languages = ["c", "rust"] }
//
//   [[rubric]]                     # 2 to 6 items
//   id = "concept"
//   label = "原理"
//   dimension = "thinking"         # thinking, writing or style
//   description = "..."
//   examples = [{ observation = "...", betterWay = "..." }]   # at most 2
//
// SECURITY: a pack's text is told to Product Lead and Tutor as instructions,
// so it cannot be treated as plain data. Its reach is limited instead: fixed
// fields, length caps, no control characters and no tags like the ones the
// prompts use as data boundaries (<work_package>, </submission>). A
// repository's pack is only used after this machine confirmed its content
// hash (./courses.ts).
import { createHash } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';

import { WorkspaceError } from './command_line.ts';
import { checkCourse } from '../shared/course_rules.ts';
import type { CoursePack } from '../shared/course_pack.ts';

// Validates a parsed pack with the rules the pack editor shows
// (../shared/course_rules.ts), failing on the first error. The result has
// its fields in a fixed order, so equal content always hashes the same.
export const normalizeCourse = (value: unknown): CoursePack => {
  const { pack, errors } = checkCourse(value);
  if (pack) return pack;
  const [first] = errors;
  throw new WorkspaceError(first.message, 'invalid_course', first.field);
};

// Parses a file's text; a syntax error names its line and column.
export const parseCourse = (text: string): CoursePack => {
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError)
      throw new WorkspaceError(`line ${error.line}, column ${error.column}: ${error.message.split('\n')[0]}`, 'invalid_course', 'toml');
    throw error;
  }
  return normalizeCourse(value);
};

// What a confirmation is given for: the validated content, so only a change
// the agents would see asks again.
export const contentHash = (pack: CoursePack) => createHash('sha256').update(JSON.stringify(pack)).digest('hex');

// A validated pack as the text of its file. It parses back to the same
// content, so the same hash.
export const courseText = (pack: CoursePack) => `${stringifyToml(pack)}\n`;
