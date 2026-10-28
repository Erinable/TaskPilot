// Shared fakes for the release page tests: state builders and the release
// namespace's installFakeApi() defaults: every other call rejects as not faked.

import type * as releaseTypes from '../../src/shared/ipc/release.ts';
import type * as requirementTypes from '../../src/shared/ipc/requirements.ts';
import { installFakeApi, ok } from './ipc_fakes.ts';

export const plan = (overrides: Partial<releaseTypes.ReleasePlan> = {}): releaseTypes.ReleasePlan => ({
  bump: 'minor',
  reason: '新增了 `release` 页面',
  currentVersion: '0.1.0',
  nextVersion: '0.2.0',
  notes: { added: ['发布页'], fixed: [], changed: [], notes: [] },
  checklist: [
    { text: '运行 `npm test`', evidence: ['tests/renderer/release.test.ts'] },
    { text: '更新 README', evidence: [] },
  ],
  ...overrides,
});

export const draft = (overrides: Partial<releaseTypes.ReleaseDraft> = {}): releaseTypes.ReleaseDraft => ({
  status: 'ready',
  error: null,
  startCommit: 'aaaaaaa1',
  endCommit: 'bbbbbbb2',
  input: { commitCount: 12, commitsTruncated: false, fileCount: 30, filesTruncated: false, packageIds: ['p1', 'p2'] },
  plan: plan(),
  notesText: '## 新增\n- 发布页',
  checked: [],
  costUsd: 0.02,
  startedAt: '2026-10-06T02:00:00.000Z',
  updatedAt: '2026-10-06T02:01:00.000Z',
  ...overrides,
});

export const release = (overrides: Partial<releaseTypes.Release> = {}): releaseTypes.Release => ({
  id: 'rel1',
  version: '0.1.0',
  startCommit: 'a',
  endCommit: 'b',
  notesText: '## 初始版本',
  checklist: [{ text: '运行测试', evidence: [], checked: true }],
  packageIds: ['p0'],
  finishedAt: '2026-10-01T04:05:06.000Z',
  ...overrides,
});

export const releaseState = (overrides: Partial<releaseTypes.ReleaseState> = {}): releaseTypes.ReleaseState => ({
  configured: true,
  draft: null,
  milestones: [],
  history: [],
  startPoint: { kind: 'release', commit: 'aaaaaaa1', label: '0.1.0' },
  running: false,
  ...overrides,
});

// Tests import the envelope helpers beside the fixtures.
export { fail, ok } from './ipc_fakes.ts';

// `state.current` is what release.get() returns; generate/updateDraft merge into it.
export const installReleaseApi = (state: { current: releaseTypes.ReleaseState }) => {
  const api = installFakeApi({
    release: {
      get: () => ok(state.current),
      recentCommits: () =>
        ok<releaseTypes.ReleaseCommit[]>([
          { sha: 'c0ffee1234', subject: '<b>初始提交</b>', date: '2026-09-30T16:30:00.000Z' },
          { sha: 'deadbeef99', subject: '第二个提交', date: '2026-10-02T03:00:00.000Z' },
        ]),
      generate: (_startCommit?: string) => {
        state.current = { ...state.current, running: true, draft: draft({ status: 'generating', plan: null, input: null, notesText: '' }) };
        return ok(state.current);
      },
      updateDraft: (input: releaseTypes.ReleaseDraftInput) => {
        const current = state.current.draft!;
        state.current = { ...state.current, draft: { ...current, notesText: input.notes ?? current.notesText, checked: input.checked ?? current.checked } };
        return ok(state.current);
      },
      finish: () => ok(finishedRelease(state)),
      writeNotes: (input: releaseTypes.ReleaseWriteInput) => ok<releaseTypes.ReleaseWriteResult>({ path: input.path }),
      cancel: () => ok(true),
      createMilestone: (input: releaseTypes.MilestoneInput) => {
        const milestone: releaseTypes.MilestoneView = {
          id: `ms${state.current.milestones.length + 1}`,
          ...input,
          createdAt: '',
          releasedAt: null,
          requirements: [],
          done: 0,
          total: 0,
          complete: false,
        };
        state.current = { ...state.current, milestones: [...state.current.milestones, milestone] };
        return ok(state.current);
      },
      updateMilestone: (_id: string, _input: releaseTypes.MilestoneInput) => ok(state.current),
      deleteMilestone: (id: string) => {
        state.current = { ...state.current, milestones: state.current.milestones.filter((item) => item.id !== id) };
        return ok(state.current);
      },
      assignMilestone: (_requirementId: string, _milestoneId: string | null) => ok(state.current),
    },
    // The milestone form lists published requirements.
    requirements: { list: () => ok<requirementTypes.Requirement[]>([]) },
  });
  // Release tests read the release namespace directly.
  return Object.assign(api.release, { emitState: api.emitState });
};

const finishedRelease = (state: { current: releaseTypes.ReleaseState }) => release({ id: 'rel2', version: state.current.draft?.plan?.nextVersion ?? '0.2.0' });
