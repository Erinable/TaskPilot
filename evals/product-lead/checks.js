// Deterministic checks on one Product Lead run. Each check returns
// { pass, detail }. They measure shape and grounding, not quality; the
// rubric judge (judge.js) covers what code can't.

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/;

const inRange = (value, [min, max]) => value >= min && value <= max;

/** Directories that exist in the file list, including every ancestor. */
function knownDirs(files) {
  const dirs = new Set(['']);
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

/** The repo's test convention, from existing test file locations. */
function testConventions(files) {
  return files.filter((file) => TEST_FILE.test(file)).map((file) => file.split('/').slice(0, -1).join('/'));
}

function check(testCase, run) {
  const { files, expect } = testCase;
  const { clarify, plan } = run;
  const packages = plan.packages;
  const scope = packages.flatMap((pkg) => pkg.fileScope);
  const fileSet = new Set(files);
  const dirs = knownDirs(files);
  const results = {};

  results.questionCount = {
    pass: inRange(clarify.questions.length, expect.questions),
    detail: `${clarify.questions.length} (want ${expect.questions.join('–')})`,
  };
  results.packageCount = {
    pass: inRange(packages.length, expect.packages),
    detail: `${packages.length} (want ${expect.packages.join('–')})`,
  };
  const hours = packages.reduce((sum, pkg) => sum + pkg.estimateHours, 0);
  results.totalHours = { pass: inRange(hours, expect.hours), detail: `${hours}h (want ${expect.hours.join('–')})` };

  // Every package should be a few hours at most.
  const oversized = packages.filter((pkg) => pkg.estimateHours > 4).map((pkg) => pkg.title);
  results.packageSize = { pass: oversized.length === 0, detail: oversized.length ? `over 4h: ${oversized.join(', ')}` : 'ok' };

  if (expect.mustTouch) {
    const missing = expect.mustTouch.filter((file) => !scope.includes(file));
    results.mustTouch = { pass: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : 'ok' };
  }

  // Grounding: new files should land in directories that already exist (or
  // one level below), when there is a repo to ground in.
  if (files.length) {
    const ungrounded = [...new Set(scope)].filter((file) => {
      if (fileSet.has(file)) return false;
      const parent = file.split('/').slice(0, -1).join('/');
      const grandparent = parent.split('/').slice(0, -1).join('/');
      return !dirs.has(parent) && !dirs.has(grandparent);
    });
    results.grounded = { pass: ungrounded.length === 0, detail: ungrounded.length ? `new dirs: ${ungrounded.join(', ')}` : 'ok' };

    // Test files follow the repo's existing convention.
    const conventions = testConventions(files);
    const pattern = expect.testPattern;
    const newTests = [...new Set(scope)].filter((file) => TEST_FILE.test(file) && !fileSet.has(file));
    const offConvention = newTests.filter((file) => {
      if (pattern) return !pattern.test(file);
      const dir = file.split('/').slice(0, -1).join('/');
      // Same top-level test root as an existing test (tests/, app/tests, src/**/__tests__).
      return !conventions.some((existing) => dir.split('/')[0] === existing.split('/')[0] && (dir.includes('__tests__') === existing.includes('__tests__')));
    });
    results.testConvention = {
      pass: offConvention.length === 0,
      detail: offConvention.length ? `off-convention: ${offConvention.join(', ')}` : newTests.length ? 'ok' : 'no new tests',
    };
  }

  // Overlap: the same file in several packages risks merge conflicts and
  // muddy boundaries. One shared file is tolerable.
  const counts = new Map();
  for (const file of scope) counts.set(file, (counts.get(file) ?? 0) + 1);
  const shared = [...counts].filter(([, n]) => n > 1).map(([file]) => file);
  results.overlap = { pass: shared.length <= 1, detail: shared.length ? `shared: ${shared.join(', ')}` : 'none' };

  // Every package should have at least one test-backed criterion.
  const untested = packages.filter((pkg) => !pkg.acceptance.some((a) => a.test)).map((pkg) => pkg.title);
  results.testable = { pass: untested.length === 0, detail: untested.length ? `no test names: ${untested.join(', ')}` : 'ok' };

  const testNames = packages.flatMap((pkg) => pkg.acceptance.map((a) => a.test).filter(Boolean));
  const dupes = testNames.filter((name, i) => testNames.indexOf(name) !== i);
  results.uniqueTests = { pass: dupes.length === 0, detail: dupes.length ? `dupes: ${[...new Set(dupes)].join(', ')}` : 'ok' };

  // Things the scripted answers ruled out shouldn't show up in the plan.
  if (expect.mustNotInvent) {
    const text = JSON.stringify(plan).toLowerCase();
    const found = expect.mustNotInvent.filter((word) => text.includes(word.toLowerCase()));
    results.noInvention = { pass: found.length === 0, detail: found.length ? `mentions ${found.join(', ')}` : 'ok' };
  }

  return results;
}

module.exports = { check, TEST_FILE };
