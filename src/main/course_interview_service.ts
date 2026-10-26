// Course mode's goal interview, over the requirement state machine
// (./requirement_store.ts): Tutor picks a course pack and asks at most three
// questions (clarifying), then plans the learner's path through the pack's
// skeleton or, when no pack fits, drafts a pack (planning). The learner
// adjusts the path or edits, saves and confirms the draft (reviewing), then
// confirms the path (published). Runs are registered like Product Lead's, so
// a switch or quit cancels them.
//
// [人工决策-2026-10-27 00:55:52] 访谈结束后由 AI 起草课程包：草稿按课程包规则（course_file.ts）校验，不通过就把报错喂回去
// 重试 1 次；通过后学生在编辑器里预览、编辑，保存进 userData/courses/，并在本机确认后才能用来规划路径。
// 学习路径先存在需求上；实验仓库的 .taskpilot/course_plan.toml 由 T3 的脚手架写入。
//
// SECURITY: only packs this machine trusts (built in, or confirmed at their
// content) are offered to Tutor or planned from: a pack's text is
// instructions. A drafted pack is model output and is never used before the
// learner saved it and confirmed it like any imported pack.
import { asAgentError, failWith } from './coded_error.ts';
import * as courses from './courses.ts';
import * as courseFile from './course_file.ts';
import * as interview from './agents/course_interview.ts';
import { throwIfCancelled } from './agents/pipeline.ts';
import * as plans from '../shared/course_plan.ts';
import { checkCourse } from '../shared/course_rules.ts';
import type { AppContext } from './app_context.ts';
import type { CourseChoice, Requirement, RequirementStep } from './requirement_store.ts';
import type { CoursePack, CourseRef } from '../shared/course_pack.ts';

type Trusted = { pack: CoursePack; ref: CourseRef };

// The activity feed's requirement_finished / requirement_failed events name
// Product Lead, so interview runs are not recorded there; their spend is,
// through ctx.runnerFor('tutor').
export const createCourseInterviewService = (ctx: AppContext) => {
  const { backgroundRuns } = ctx;

  const requireRequirements = () => ctx.requirements ?? failWith('Requirements are unavailable', 'unsupported');

  // Every pack this machine may use that has a concept skeleton.
  const trustedPacks = async (): Promise<Trusted[]> => {
    const places = ctx.coursePlaces();
    const loaded = await Promise.all(
      (await courses.availableCourses(places)).map(async (entry) => {
        try {
          const course = await courses.loadCourse(places, entry);
          return course.pack.concepts?.length && (await courses.trustOf(places, course.ref)) !== 'pending' ? [course] : [];
        } catch (error) {
          // A broken file is listed as broken on the 课程 view; it is just not offered.
          if ((error as { code?: string }).code !== 'invalid_course') throw error;
          return [];
        }
      }),
    );
    return loaded.flat();
  };

  const goalOf = (item: Requirement): interview.GoalInput => ({ goal: item.text, form: item.course!.form, questions: item.questions });

  // Runs one interview step in the background and records the outcome, as
  // ./ipc/requirements.ts does for Product Lead.
  const startRun = async (id: string, step: RequirementStep, work: (item: Requirement, signal: AbortSignal) => Promise<unknown>) => {
    const store = requireRequirements();
    const item = await store.begin(id, step);
    const controller = backgroundRuns.start({
      kind: 'requirement',
      key: id,
      busy: 'requirement',
      agent: () => 'tutor',
      label: () => store.get(id).title || id,
    });
    console.debug(`[course-interview] start requirement=${id} step=${step}`);
    const settled = (async () => {
      let failure: unknown = null;
      try {
        await store.setPhase(id, 'tutor');
        await work(item, controller.signal);
      } catch (error) {
        failure = error;
      }
      backgroundRuns.finish('requirement', id, controller);
      const title = store.get(id).title || item.text.slice(0, 40);
      if (failure === null) {
        console.debug(`[course-interview] finished requirement=${id} step=${step} title=${title}`);
        return;
      }
      const agentError = asAgentError(failure);
      if (agentError.code !== 'agent_cancelled' && agentError.code !== 'agent_bad_output') console.error(failure);
      console.debug(`[course-interview] failed requirement=${id} step=${step} title=${title} code=${agentError.code ?? 'unknown'}`);
      await store.failRun(id, step, agentError).catch((error) => console.error(error));
    })();
    backgroundRuns.track(settled);
    return item;
  };

  const run = async (id: string, options: { prompt: string; schema: Record<string, unknown>; signal: AbortSignal }) => {
    throwIfCancelled(options.signal);
    const { path: envPath } = await ctx.commandPath();
    return ctx.runnerFor('tutor', { kind: 'requirement', id })({ ...options, systemPrompt: interview.systemPrompt(), envPath });
  };

  // ========== Interview ==========
  const clarify = (id: string) =>
    startRun(id, 'clarifying', async (item, signal) => {
      const offered = await trustedPacks();
      const courseIds = offered.map((entry) => entry.pack.id);
      const options = offered.map(({ pack }) => ({ id: pack.id, title: pack.title, summary: pack.summary, domain: pack.domain, concepts: pack.concepts! }));
      const { output, costUsd } = await run(id, {
        prompt: interview.clarifyPrompt({ ...goalOf(item), questions: [], courses: options }),
        schema: interview.clarifySchema(courseIds),
        signal,
      });
      const clarified = interview.validateClarify(output, courseIds);
      const pick = { course: clarified.course, reason: clarified.reason, options: offered.map(({ pack }) => ({ id: pack.id, title: pack.title })) };
      await requireRequirements().finishCourseClarify(id, { ...clarified, pick }, costUsd);
    });

  // ========== Path or draft ==========
  const planPath = async (id: string, item: Requirement, courseId: string, signal: AbortSignal) => {
    const chosen = (await trustedPacks()).find((entry) => entry.pack.id === courseId);
    if (!chosen) return failWith(`Course pack ${courseId} is not confirmed on this machine or has no concepts`, 'course_not_confirmed', 'course');
    const goal = goalOf(item);
    const { output, costUsd } = await run(id, {
      prompt: interview.pathPrompt({ ...goal, course: chosen.pack }),
      schema: interview.pathSchema((chosen.pack.concepts ?? []).map((concept) => concept.id)),
      signal,
    });
    const planned = interview.validatePath(output, chosen.pack);
    const knownConcepts = planned.path.filter((entry) => entry.status === 'known').map((entry) => entry.conceptId);
    const onPath = new Set(planned.path.map((entry) => entry.conceptId));
    const plan: plans.CoursePlan = {
      course: chosen.ref,
      goal: { kind: 'course', goal: item.text, ...goal.form, knownConcepts },
      summary: planned.summary,
      path: planned.path,
      extraConcepts: planned.extraConcepts,
    };
    const pathConcepts = (chosen.pack.concepts ?? []).filter((concept) => onPath.has(concept.id));
    console.debug(`[course-interview] path requirement=${id} course=${courseId} concepts=${planned.path.length} extras=${planned.extraConcepts.length}`);
    await requireRequirements().finishCoursePlan(id, plan, pathConcepts, costUsd);
  };

  // The draft's id, made free: a taken id gets a number, so the draft never
  // replaces a pack that exists.
  const freeId = async (wanted: string) => {
    const places = ctx.coursePlaces();
    const taken = new Set([...(await courses.availableCourses(places)).map((entry) => entry.id), ...(await courses.listUserCourses(ctx.configDir))]);
    let candidate = wanted;
    for (let index = 2; taken.has(candidate); index += 1) candidate = `${wanted.slice(0, 28)}-${index}`;
    return candidate;
  };

  // One retry: the first draft's errors are fed back to Tutor.
  const draftPack = async (id: string, item: Requirement, signal: AbortSignal) => {
    const goal = goalOf(item);
    let errors: ReturnType<typeof checkCourse>['errors'] = [];
    let costUsd = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await run(id, { prompt: interview.draftPrompt({ ...goal, errors }), schema: interview.DRAFT_SCHEMA, signal });
      costUsd += result.costUsd ?? 0;
      const drafted = interview.draftPack(result.output) as { id?: unknown };
      if (typeof drafted === 'object' && drafted && typeof drafted.id === 'string') drafted.id = await freeId(drafted.id);
      const checked = checkCourse(drafted);
      if (checked.pack) {
        // course_file.ts is the check that counts, as for every pack TaskPilot reads or saves.
        const pack = courseFile.normalizeCourse(checked.pack);
        console.debug(`[course-interview] draft requirement=${id} id=${pack.id} attempt=${attempt} concepts=${pack.concepts?.length ?? 0}`);
        await requireRequirements().finishCourseDraft(id, { pack, contentHash: courseFile.contentHash(pack) }, costUsd);
        return;
      }
      errors = checked.errors;
      console.debug(`[course-interview] draft refused requirement=${id} attempt=${attempt} errors=${errors.length}`);
    }
    return failWith(`The drafted course pack does not validate: ${errors.map((error) => error.message).join('; ')}`, 'agent_bad_output');
  };

  const checkChoice = (raw: unknown): CourseChoice => {
    const value = raw as { course?: unknown; draft?: unknown } | null;
    if (value?.draft === true) return { draft: true };
    if (typeof value?.course === 'string') return { course: value.course };
    return failWith('choice must name a course pack or ask for a draft', 'invalid_argument', 'choice');
  };

  // Saves the answers and the learner's choice when given, then plans with
  // the stored choice.
  const plan = async (id: string, answers: unknown, rawChoice: unknown) => {
    const store = requireRequirements();
    if (answers !== undefined) await store.setAnswers(id, answers);
    if (rawChoice !== undefined) await store.setCourseChoice(id, checkChoice(rawChoice));
    const choice = store.get(id).course?.choice ?? failWith('Choose a course pack or ask for a draft first', 'invalid_state', 'choice');
    return startRun(id, 'planning', (item, signal) => ('draft' in choice ? draftPack(id, item, signal) : planPath(id, item, choice.course, signal)));
  };

  // ========== Review ==========
  // The learner reordered the path or marked concepts known or skipped.
  // Only the order and statuses change; the concepts stay the planned ones.
  const savePath = async (id: string, rawPath: unknown) => {
    const store = requireRequirements();
    const course = store.get(id).course;
    if (!course?.plan) return failWith('There is no path to change', 'invalid_state');
    if (!Array.isArray(rawPath)) return failWith('path must be a list', 'invalid_argument', 'path');
    const path = rawPath.map((entry) => ({ conceptId: (entry as plans.PathEntry)?.conceptId, status: (entry as plans.PathEntry)?.status }) as plans.PathEntry);
    const planned = course.plan.path.map((entry) => entry.conceptId);
    if (path.length !== planned.length || !planned.every((conceptId) => path.some((entry) => entry.conceptId === conceptId)))
      return failWith('path must keep the planned concepts', 'invalid_argument', 'path');
    const problem = plans.pathProblem(path, course.pathConcepts, course.plan.extraConcepts);
    if (problem) return failWith(problem, 'invalid_argument', 'path');
    return store.setCoursePath(id, path);
  };

  const confirmPath = (id: string) => requireRequirements().confirmCoursePath(id);

  // Saves the learner's edit of the draft into the global folder, like a
  // copied pack, and chooses it for the path. Never confirms: the learner
  // confirms the saved pack on this machine before planning with it.
  const saveDraft = async (id: string, rawPack: unknown) => {
    const store = requireRequirements();
    const course = store.get(id).course;
    if (!course?.draft) return failWith('There is no drafted course pack', 'invalid_state');
    const pack = rawPack as { id?: unknown } | null;
    if (pack?.id !== course.draft.pack.id) return failWith(`id: must stay "${course.draft.pack.id}"`, 'invalid_course', 'id');
    const places = ctx.coursePlaces();
    if ((await courses.availableCourses(places)).some((entry) => entry.id === pack.id) || (await courses.listUserCourses(ctx.configDir)).includes(pack.id))
      return failWith(`id: "${pack.id}" is already a course pack`, 'course_exists', 'id');
    const saved = await courses.writeUserCourse(ctx.configDir, rawPack);
    console.debug(`[course-interview] draft saved requirement=${id} id=${saved.ref.id} hash=${saved.ref.contentHash.slice(0, 12)}`);
    return { requirement: await store.useCourseDraft(id, { id: saved.pack.id, title: saved.pack.title }), ref: saved.ref };
  };

  // Confirms the saved draft on this machine at the content the learner was
  // shown (`contentHash`), like any imported pack; a changed file is refused.
  const confirmDraft = async (id: string, contentHash: string) => {
    const choice = requireRequirements().get(id).course?.choice;
    if (!choice || 'draft' in choice) return failWith('There is no saved course pack to confirm', 'invalid_state');
    const places = ctx.coursePlaces();
    const entry = (await courses.availableCourses(places)).find((candidate) => candidate.id === choice.course);
    if (entry?.source !== 'user') return failWith(`Course pack ${choice.course} is not a saved draft`, 'invalid_state', 'course');
    const { pack, ref } = await courses.loadCourse(places, entry);
    if (ref.contentHash !== contentHash) return failWith(`Course pack ${ref.id} changed since it was shown`, 'course_changed', 'course');
    await courses.confirm(places, pack, ref);
    return requireRequirements().get(id);
  };

  return { clarify, plan, savePath, confirmPath, saveDraft, confirmDraft };
};

export type CourseInterviewService = ReturnType<typeof createCourseInterviewService>;
