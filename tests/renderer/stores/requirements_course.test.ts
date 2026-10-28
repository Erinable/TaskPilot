// @vitest-environment happy-dom
// Course requirement actions over their injected requirement-store edges: a
// result is applied only for the revision it started in, failures toast,
// and a draft is confirmed at the content hash it was saved with.
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import * as feedback from '@/lib/feedback.ts';
import { createRequirementsCourseActions } from '@/stores/requirements_course.ts';
import { installApi, requirement } from '../requirements_fakes.ts';
import { fail, ok } from '../ipc_fakes.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), announceAgent: vi.fn(), confirmAction: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;
let revision: number;
const deps = {
  upsert: vi.fn(),
  renderDetail: vi.fn(),
  open: vi.fn(async () => {}),
  startWatching: vi.fn(),
  runStep: vi.fn(async () => {}),
  revision: () => revision,
};
const item = requirement({ id: 'r1', kind: 'course' });

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  revision = 0;
  api = installApi({ list: [] });
});

test('an answer that lands after the requirement store moved on is dropped', async () => {
  const held = Promise.withResolvers<IpcResult<requirementTypes.Requirement>>();
  api.requirements.coursePath.mockReturnValueOnce(held.promise);
  const actions = createRequirementsCourseActions(deps);
  const saving = actions.savePath(item, []);
  expect(actions.courseBusy.value).toBe(true);
  revision += 1;
  held.resolve({ ok: true, data: requirement({ id: 'r1', status: 'reviewing' }) });
  expect(await saving).toBeNull();
  expect(deps.upsert).not.toHaveBeenCalled();
  expect(deps.renderDetail).not.toHaveBeenCalled();
  expect(actions.courseBusy.value).toBe(false);
});

test('a failed action toasts and leaves the requirement alone', async () => {
  api.requirements.publish.mockReturnValueOnce(fail('invalid_state', 'not reviewing'));
  const logged = expectConsole('error', /not reviewing/);
  const actions = createRequirementsCourseActions(deps);
  await actions.confirmPath(item);
  expect(logged).toHaveLength(1);
  expect(feedback.showToast).toHaveBeenCalledWith(expect.stringMatching(/^确认路径失败：/));
  expect(deps.upsert).not.toHaveBeenCalled();
});

test('generating uses the concept the estimate was for, then watches the run', async () => {
  const actions = createRequirementsCourseActions(deps);
  await actions.loadLabEstimate(item, 'round-robin');
  expect(api.requirements.labEstimate).toHaveBeenCalledWith('r1', 'round-robin');
  await actions.generateLab(item);
  expect(api.requirements.labGenerate).toHaveBeenCalledWith('r1', 'round-robin');
  expect(actions.labEstimate.value).toBeNull();
  expect(deps.startWatching).toHaveBeenCalledTimes(1);
});

test("an estimate for another requirement does not pick this one's concept", async () => {
  const actions = createRequirementsCourseActions(deps);
  await actions.loadLabEstimate(requirement({ id: 'other', kind: 'course' }), 'mlfq');
  await actions.generateLab(item);
  expect(api.requirements.labGenerate).toHaveBeenCalledWith('r1', undefined);
});

test('a saved draft is confirmed at its saved hash, then planning starts', async () => {
  const actions = createRequirementsCourseActions(deps);
  expect(await actions.saveDraft(item, OS_COURSE)).toBeNull();
  expect(actions.draftSaved.value?.ref.contentHash).toBe('saved-hash');
  await actions.confirmDraft(item);
  expect(api.requirements.courseConfirmDraft).toHaveBeenCalledWith('r1', 'saved-hash');
  expect(actions.draftSaved.value).toBeNull();
  expect(deps.runStep).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 'plan');
});

test('a draft refused on a field returns it for the form instead of a toast', async () => {
  api.requirements.courseSaveDraft.mockReturnValueOnce(fail('invalid_course', 'too long', 'title'));
  expectConsole('error', /too long/);
  const actions = createRequirementsCourseActions(deps);
  expect(await actions.saveDraft(item, OS_COURSE)).toEqual({ field: 'title', message: expect.any(String) });
  expect(feedback.showToast).not.toHaveBeenCalled();
  expect(actions.draftSaved.value).toBeNull();
});

test('adding a lab reloads the queue and names the lab', async () => {
  const actions = createRequirementsCourseActions(deps);
  expect(await actions.addLab(item)).toBe(true);
  expect(api.tasks.list).toHaveBeenCalled();
  expect(feedback.showToast).toHaveBeenCalledWith('已把「时间片轮转调度」加入实验仓库。');
  api.requirements.labPlace.mockReturnValueOnce(ok(requirement({ id: 'r1' })));
  expect(await actions.addLab(item)).toBe(true);
  expect(feedback.showToast).toHaveBeenLastCalledWith('已把「lab」加入实验仓库。');
});
