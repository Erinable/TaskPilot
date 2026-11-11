// A repository without a project skeleton yet: every tracked file is one a
// fresh repository starts with (a README, a licence, git and editor
// settings, Markdown notes, taskpilot.toml). Nothing tells TaskPilot the
// language, so checks and environment setup wait for the skeleton, and
// Product Lead plans it as the first package. Shared by the main process
// (steward, planning) and the renderer (getting started).
const NON_CODE = [
  /^(readme|licen[cs]e|copying|changelog|contributing|authors|notice)(\.[a-z]+)?$/i,
  /^\.git(ignore|attributes|keep)$/,
  /^\.editorconfig$/,
  /^taskpilot\.toml$/,
  /\.(md|markdown|txt)$/i,
];

export const isBlankProject = (tracked: Iterable<string>): boolean => {
  for (const file of tracked) if (!NON_CODE.some((pattern) => pattern.test(file))) return false;
  return true;
};
