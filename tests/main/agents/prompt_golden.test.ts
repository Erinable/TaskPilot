// Golden prompts: every prompt Product Lead, Architect, QA, Tutor and Coding
// Agent send, rendered from fixed inputs. Recorded before the project profile
// existed (CARM-17); with no profile, or with the default TypeScript profile,
// each must stay byte for byte the same. Re-record only for an intended
// prompt change: `npx vitest run tests/main/agents/prompt_golden.test.ts -u`.
import { describe, expect, test } from 'vitest';

import * as productLead from '../../../src/main/agents/product_lead.ts';
import * as architect from '../../../src/main/agents/architect.ts';
import * as qa from '../../../src/main/agents/qa.ts';
import * as tutor from '../../../src/main/agents/tutor.ts';
import * as releaseManager from '../../../src/main/agents/release_manager.ts';
import { createCodingRuntime } from '../../../src/main/coding_runtime.ts';
import type { AppContext } from '../../../src/main/app_context.ts';
import type { CheckOutcome, EvidenceItem } from '../../../src/main/evidence.ts';
import type { TaskDefinition } from '../../../src/main/tasks.ts';
import type { ProjectProfile } from '../../../src/shared/project_profile.ts';

// What effective_steps gives a TypeScript repository with taskpilot.toml.
const TS_PROFILE: ProjectProfile = {
  languages: [{ id: 'typescript', label: 'TypeScript / JavaScript' }],
  manifests: ['package.json'],
  testLayout: null,
  testNameFormat: null,
  checks: [
    { id: 'test', label: 'test', stage: 'submit', blocking: true, commandLine: 'npm test', reports: 'tests' },
    { id: 'lint', label: 'lint', stage: 'manual', blocking: false, commandLine: 'npm run lint', reports: 'exit' },
  ],
  version: null,
};
const PROFILES: [string, ProjectProfile | null | undefined][] = [
  ['no profile', undefined],
  ['null profile', null],
  ['default profile', TS_PROFILE],
];

const golden = (name: string) => `./__golden__/${name}.txt`;

const FILES = ['package.json', 'src/auth/login.ts', 'src/auth/session.ts', 'tests/auth/login.test.ts'];
const INTERFACES = '## src/auth/login.ts\nlogin(email: string, password: string): Promise<Session>';
const REQUIREMENT = { title: '登录失败锁定', text: '连续 5 次密码错误后锁定账户 15 分钟。', files: FILES };
const SOURCES = [
  { path: 'src/auth/login.ts', content: 'export const login = async (email: string, password: string) => {};' },
  { path: 'tests/auth/login.test.ts', content: "test('login succeeds', () => {});" },
];
const SKIPPED = [{ path: '.env', reason: 'secret' }];
const ACCEPTANCE = [{ text: '第 5 次失败后锁定', test: 'locks after five failures' }, { text: '锁定提示不泄露账户是否存在' }];
const PACKAGE = {
  title: '实现登录锁定',
  description: '在 login 里记录失败次数并锁定。',
  steps: ['在 `src/auth/login.ts` 记录失败次数。', '在 `tests/auth/login.test.ts` 加测试。'],
  fileScope: ['src/auth/login.ts', 'tests/auth/login.test.ts'],
  acceptance: ACCEPTANCE,
};
const TASK = { id: 'p1', intro: PACKAGE.description, ...PACKAGE } as unknown as TaskDefinition;

const CHECK_RUN: CheckOutcome = {
  kind: 'test',
  command: 'npm test',
  exitCode: 1,
  timedOut: false,
  durationMs: 10,
  output: '',
  results: [
    { name: 'locks after five failures', passed: false, skipped: false, todo: false },
    { name: 'login succeeds', passed: true, skipped: false, todo: false },
  ],
  diagnostics: [],
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, ok: false },
  report: { format: 'tests', trusted: true, problem: null },
  check: { stage: 'submit', blocking: true },
};
const CHECK_EVIDENCE: EvidenceItem = {
  kind: 'test',
  stage: 'submit',
  blocking: true,
  baseline: 'measured',
  status: 'fail',
  reason: 'new_failures',
  newFailures: ['locks after five failures'],
  preexisting: ['legacy flake'],
  fixed: [],
};
const CRITERIA = [
  { text: ACCEPTANCE[0].text, test: ACCEPTANCE[0].test, status: 'failed' as const },
  { text: ACCEPTANCE[1].text, manual: true },
];
const DIFF = {
  files: [{ path: 'src/auth/login.ts', patch: '@@ -1 +1,2 @@\n+let failures = 0;\n', untracked: false }],
  skipped: [{ path: 'dist/app.js', reason: 'too_large' }],
  outOfScope: ['README.md'],
};

test('system prompts', async () => {
  await expect(productLead.SYSTEM_PROMPT).toMatchFileSnapshot(golden('product_lead_system'));
  await expect(architect.SYSTEM_PROMPT).toMatchFileSnapshot(golden('architect_system'));
  await expect(architect.ADJUDICATE_SYSTEM_PROMPT).toMatchFileSnapshot(golden('architect_adjudicate_system'));
  await expect(qa.SYSTEM_PROMPT).toMatchFileSnapshot(golden('qa_system'));
  await expect(tutor.SYSTEM_PROMPT).toMatchFileSnapshot(golden('tutor_system'));
  await expect(tutor.GRADE_SYSTEM_PROMPT).toMatchFileSnapshot(golden('tutor_grade_system'));
  await expect(releaseManager.SYSTEM_PROMPT).toMatchFileSnapshot(golden('release_system'));
});

// Release Manager takes no profile; a TypeScript repository's version comes
// from package.json.
test('Release Manager', async () => {
  const input = {
    currentVersion: '1.4.2',
    versionFile: 'package.json',
    startCommit: '0'.repeat(40),
    startLabel: 'v1.4.2',
    endCommit: 'f'.repeat(40),
    commits: [{ sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', subject: 'feat: 登录锁定' }],
    commitsTruncated: false,
    files: [{ path: 'src/auth/login.ts', added: 40, removed: 2, binary: false }],
    filesTruncated: false,
    packages: [{ id: 'p1', title: PACKAGE.title, description: PACKAGE.description, acceptance: ACCEPTANCE.map((item) => item.text) }],
  };
  await expect(releaseManager.planPrompt(input)).toMatchFileSnapshot(golden('release_plan'));
  await expect(releaseManager.planPrompt({ ...input, currentVersion: null })).toMatchFileSnapshot(golden('release_plan_no_version'));
});

describe.each(PROFILES)('%s', (_name, profile) => {
  test('Product Lead clarify', async () => {
    await expect(productLead.clarifyPrompt({ ...REQUIREMENT, interfaces: null, profile })).toMatchFileSnapshot(golden('product_lead_clarify'));
    await expect(productLead.clarifyPrompt({ ...REQUIREMENT, interfaces: INTERFACES, profile })).toMatchFileSnapshot(golden('product_lead_clarify_interfaces'));
    await expect(productLead.clarifyPrompt({ text: REQUIREMENT.text, files: [], profile })).toMatchFileSnapshot(golden('product_lead_clarify_no_repo'));
  });

  test('Product Lead plan', async () => {
    const questions = [{ text: '锁定时长？', answer: '15 分钟' }, { text: '是否通知用户？' }];
    await expect(productLead.planPrompt({ ...REQUIREMENT, questions, interfaces: INTERFACES, linkTests: true, profile })).toMatchFileSnapshot(
      golden('product_lead_plan_tests'),
    );
    await expect(productLead.planPrompt({ ...REQUIREMENT, questions: [], interfaces: null, linkTests: false, profile })).toMatchFileSnapshot(
      golden('product_lead_plan_no_tests'),
    );
  });

  test('Architect select and summarize', async () => {
    await expect(architect.selectPrompt({ ...REQUIREMENT, profile })).toMatchFileSnapshot(golden('architect_select'));
    await expect(architect.summarizePrompt({ ...REQUIREMENT, sources: SOURCES, skipped: SKIPPED, profile })).toMatchFileSnapshot(golden('architect_summarize'));
    await expect(architect.summarizePrompt({ ...REQUIREMENT, sources: SOURCES, skipped: [], profile })).toMatchFileSnapshot(
      golden('architect_summarize_all_read'),
    );
  });

  test('Architect adjudicate', async () => {
    const deviations = [
      {
        note: '已有 RateLimiter，不需要新计数器',
        stepIndex: 0,
        filePath: 'src/auth/login.ts',
        resolution: { decision: 'dismiss', reason: '按原计划', contested: true },
      },
      { note: '仍然冲突', stepIndex: null },
    ];
    const input = { task: PACKAGE, deviations, interfaces: INTERFACES, sources: SOURCES, skipped: SKIPPED, profile };
    await expect(architect.adjudicatePrompt({ ...input, mustReplan: true })).toMatchFileSnapshot(golden('architect_adjudicate_replan'));
    await expect(architect.adjudicatePrompt({ ...input, mustReplan: false, interfaces: null, sources: [], skipped: [] })).toMatchFileSnapshot(
      golden('architect_adjudicate'),
    );
  });

  test('QA review', async () => {
    const checks = [{ evidence: CHECK_EVIDENCE, run: CHECK_RUN }];
    await expect(qa.reviewPrompt({ task: PACKAGE, acceptance: CRITERIA, checks, diff: DIFF, interfaces: INTERFACES, profile })).toMatchFileSnapshot(
      golden('qa_review'),
    );
    await expect(
      qa.reviewPrompt({ task: PACKAGE, acceptance: CRITERIA, diff: { files: [], skipped: [], outOfScope: [] }, interfaces: null, profile }),
    ).toMatchFileSnapshot(golden('qa_review_no_checks'));
  });

  test('Tutor step and grade', async () => {
    const task = { title: PACKAGE.title, intro: PACKAGE.description, steps: PACKAGE.steps, fileScope: PACKAGE.fileScope, acceptance: ACCEPTANCE };
    await expect(tutor.tutorPrompt({ task, stepIndex: 1, sources: SOURCES, missing: ['tests/auth/lock.test.ts'], profile })).toMatchFileSnapshot(
      golden('tutor_step'),
    );
    await expect(tutor.tutorPrompt({ task, stepIndex: 0, sources: [], missing: [], profile })).toMatchFileSnapshot(golden('tutor_step_no_sources'));
    const submission = [{ path: 'src/auth/login.ts', patch: '+let failures = 0;' }];
    const review = { passed: false, summary: '没有锁定', issues: ['缺少计数重置'] };
    const notes = [
      { category: 'thinking' as const, title: '边界', summary: '先列出边界情况' },
      { category: null, title: '命名', summary: '' },
    ];
    await expect(tutor.gradePrompt({ task, submission, reference: '+const MAX = 5;', review, notes, profile })).toMatchFileSnapshot(golden('tutor_grade'));
    await expect(tutor.gradePrompt({ task, submission, reference: null, review: null, profile })).toMatchFileSnapshot(golden('tutor_grade_no_reference'));
  });

  test('Coding Agent', async () => {
    const ctx = { getPreferences: () => ({}), configDir: '/config', interfacesFor: () => INTERFACES } as unknown as AppContext;
    const bare = { ...ctx, interfacesFor: () => null } as unknown as AppContext;
    await expect(createCodingRuntime(ctx).codingPrompt(TASK, '先写测试。', null, profile)).toMatchFileSnapshot(golden('coding'));
    await expect(createCodingRuntime(bare).codingPrompt(TASK, '修复失败的测试。', 'locks after five failures failed', profile)).toMatchFileSnapshot(
      golden('coding_feedback'),
    );
  });
});
