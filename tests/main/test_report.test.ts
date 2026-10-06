import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as testReport from '../../src/main/test_report.ts';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<!-- <testcase name="in a comment"/> -->
<testsuites>
  <testsuite name="auth">
    <testcase classname="login" name="succeeds &amp; returns a token"/>
    <testcase classname="login" name="rejects bad password">
      <failure message="expected 401"><![CDATA[<testcase name="inside cdata"/>]]></failure>
    </testcase>
    <testcase classname="login" name="locks out"><skipped/></testcase>
    <testsuite name="nested">
      <testcase name="errors"><error message="boom"/></testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

async function tempRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-report-')));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('parseJunit() reads cases, failures, errors and skips with suite paths', () => {
  const results = testReport.parseJunit(JUNIT);
  assert.deepEqual(results.map((x) => [x.fullName, x.passed, x.skipped]), [
    ['auth › login › succeeds & returns a token', true, false],
    ['auth › login › rejects bad password', false, false],
    ['auth › login › locks out', true, true],
    ['auth › nested › errors', false, false],
  ]);
  assert.equal(results[0].name, 'succeeds & returns a token');
});

test('parseJunit() refuses text that is not a JUnit report', () => {
  assert.throws(() => testReport.parseJunit('<html><body>hi</body></html>'), { code: 'invalid_report' });
});

test('readReport() trusts only a fresh regular file inside the workspace', async () => {
  const root = await tempRoot();
  const report = { format: 'junit', path: 'reports/unit.xml' };
  assert.equal((await testReport.readReport(root, report, null)).problem, 'missing');

  await fs.mkdir(path.join(root, 'reports'));
  await fs.writeFile(path.join(root, report.path), JUNIT);
  const before = await testReport.statReport(root, report.path);
  assert.equal((await testReport.readReport(root, report, before)).problem, 'stale');

  const fresh = await testReport.readReport(root, report, null);
  assert.equal(fresh.trusted, true);
  assert.equal(fresh.results.length, 4);

  await fs.writeFile(path.join(root, report.path), 'not xml');
  assert.equal((await testReport.readReport(root, report, null)).problem, 'invalid');
});

test('readReport() refuses symlinks, including a symlinked directory out of the workspace', { skip: process.platform === 'win32' }, async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  await fs.writeFile(path.join(outside, 'unit.xml'), JUNIT);

  await fs.symlink(path.join(outside, 'unit.xml'), path.join(root, 'link.xml'));
  assert.equal((await testReport.readReport(root, { format: 'junit', path: 'link.xml' }, null)).problem, 'not_a_file');

  await fs.symlink(outside, path.join(root, 'out'));
  assert.equal((await testReport.readReport(root, { format: 'junit', path: 'out/unit.xml' }, null)).problem, 'outside');
});

test('readReport() refuses oversized reports', async () => {
  const root = await tempRoot();
  const handle = await fs.open(path.join(root, 'big.xml'), 'w');
  await handle.truncate(testReport.MAX_REPORT_BYTES + 1);
  await handle.close();
  assert.equal((await testReport.readReport(root, { format: 'junit', path: 'big.xml' }, null)).problem, 'too_large');
});
