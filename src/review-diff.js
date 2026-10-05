// Collects a work package's changes for QA to review, within a fixed boundary.
//
// SECURITY: this is the only place QA-bound diff contents come from. Unlike
// ./repo-reader.js it has to read the working tree, because the work under
// review is uncommitted and often untracked. To keep that safe:
//   - only paths git itself reports as changed since the baseline are read;
//   - every path must resolve inside the workspace root;
//   - secret-looking paths are refused before anything is read, using the
//     same patterns as repo-reader.js;
//   - binary changes, oversized patches and totals past the budget are skipped.
// Every skip is reported so QA (and the user) know what was not reviewed.
const git = require('./git');
const { looksSecret } = require('./repo-reader');
const { isInside } = require('./workspace');

const DEFAULT_LIMITS = { maxFiles: 20, maxPatchBytes: 32 * 1024, maxTotalBytes: 160 * 1024 };

/**
 * @param root workspace root (a git top level)
 * @param baseline commit recorded when the package was claimed
 * @param options.prioritize optional (path) => boolean; matching files are
 *   read first, so the budget goes to the files the package was meant to touch
 * @param options.changes optional precomputed git.changesSince() result
 * @returns {{ changes, files: [{path, patch, bytes, untracked}], skipped: [{path, reason}] }}
 */
async function collectChanges(root, baseline, { limits = {}, prioritize = () => false, changes, ignore = () => false } = {}) {
  const { maxFiles, maxPatchBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  // `ignore` drops files TaskPilot's own checks produced (test reports), so
  // they are neither reviewed nor counted as the package's changes.
  const all = (changes ?? await git.changesSince(root, baseline)).filter((c) => !ignore(c.path));
  // Stable: preferred files first, otherwise git's order.
  const ordered = [...all.filter((c) => prioritize(c.path)), ...all.filter((c) => !prioritize(c.path))];
  const files = [];
  const skipped = [];
  let total = 0;

  for (const change of ordered) {
    const skip = (reason) => skipped.push({ path: change.path, reason });
    // Renames are reported as "old → new" by git.status(); there is no single
    // path to read, so they are listed rather than diffed.
    if (change.path.includes(' → ')) { skip('rename'); continue; }
    if (!isInside(root, change.path)) { skip('outside_workspace'); continue; }
    if (looksSecret(change.path)) { skip('secret'); continue; }
    if (change.binary) { skip('binary'); continue; }
    if (files.length >= maxFiles) { skip('file_limit'); continue; }

    let patch;
    try {
      patch = await git.diffFile(root, baseline, change.path);
    } catch {
      skip('unreadable');
      continue;
    }
    const bytes = Buffer.byteLength(patch);
    if (bytes > maxPatchBytes) { skip('too_large'); continue; }
    if (total + bytes > maxTotalBytes) { skip('budget'); continue; }
    total += bytes;
    files.push({ path: change.path, patch, bytes, untracked: change.untracked === true });
  }
  return { changes: all, files, skipped };
}

module.exports = { DEFAULT_LIMITS, collectChanges };
