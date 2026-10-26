// Requirement channels: Product Lead clarifies and plans, Architect
// summarizes the code it touches, and the human publishes the plan. Course
// requirements go to Tutor's goal interview (../course_interview_service.ts)
// on the same channels, plus the path and draft channels below.
import { asAgentError, failWith, requireString } from '../coded_error.ts';
import * as git from '../git.ts';
import * as productLead from '../agents/product_lead.ts';
import { summarizeForRequirement, throwIfCancelled } from '../agents/pipeline.ts';
import { toWireRequirement } from '../app_context.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as claudeCli from '../agents/claude_cli.ts';
import type * as requirementTypes from '../../shared/ipc/requirements.ts';
import type { AppContext } from '../app_context.ts';
import type { RequirementStore } from '../requirement_store.ts';
import type { IpcMainLike } from './handler.ts';
import type { ProjectProfile } from '../../shared/project_profile.ts';
import type { CoursePack, CourseRef } from '../../shared/course_pack.ts';
import type { CourseInterviewService } from '../course_interview_service.ts';
import { goalFormProblem } from '../../shared/course_plan.ts';
import type { GoalForm } from '../../shared/course_plan.ts';

type RequirementItem = Awaited<ReturnType<RequirementStore['get']>>;
type PromptInput = Omit<RequirementItem, 'interfaces' | 'course'> & {
  files: string[];
  interfaces: string | null;
  profile: ProjectProfile | null;
  course: CoursePack;
};

// The form as stored: checked by goalFormProblem() first, then trimmed.
const formOf = (form: GoalForm): GoalForm => ({ level: form.level, target: form.target, environment: form.environment.trim(), weeklyHours: form.weeklyHours });

// Repository paths Product Lead sees: tracked files only (gitignored and
// untracked files are left out), capped, and never their contents.
const repositoryFiles = async (root: string | null): Promise<string[]> => {
  if (!root) return [];
  try {
    return await git.listFiles(root, { limit: 400 });
  } catch {
    return [];
  }
};

export const register = (ipcMain: IpcMainLike, ctx: AppContext, { courseInterview }: { courseInterview: CourseInterviewService }) => {
  const { backgroundRuns, record } = ctx;

  const requireRequirements = () => {
    if (!ctx.requirements) return failWith('Requirements are unavailable', 'unsupported');
    return ctx.requirements;
  };

  // Runs one Product Lead step in the background and records the outcome.
  const startRun = async <Output>(
    id: string,
    step: requirementTypes.RequirementStep,
    buildPrompt: (input: PromptInput) => string,
    schema: claudeCli.JsonSchema,
    validate: (raw: unknown) => Output,
    finish: (id: string, output: Output, costUsd: number, course: CourseRef) => Promise<unknown>,
  ) => {
    const store = requireRequirements();
    const architectRunner = ctx.runnerFor('architect', { kind: 'requirement', id });
    const productRunner = ctx.runnerFor('product-lead', { kind: 'requirement', id });
    const item = await store.begin(id, step);
    // One in-flight run per requirement, so it can be cancelled.
    const controller = backgroundRuns.start({
      kind: 'requirement',
      key: id,
      busy: 'requirement',
      agent: () => (store.get(id).phase === 'architect' ? 'architect' : 'product-lead'),
      label: () => store.get(id).title || id,
    });
    const config = ctx.getConfig();
    const { root } = config;
    const files = await repositoryFiles(root);
    const { path: envPath } = await ctx.commandPath();
    // Not awaited: the renderer polls requirements:get for the result.
    const settled = (async () => {
      let outcome: { output: Output; costUsd: number; course: CourseRef } | { error: unknown };
      try {
        const profile = await ctx.profile(config);
        // The pack in use now; a repository pack not yet confirmed is never it (../courses.ts).
        const course = await ctx.course(config);
        // Architect summarizes the touched code once, during clarification;
        // planning reuses it. Re-clarifying refreshes it.
        let interfaces = item.interfaces?.text ?? null;
        let architectCost = 0;
        if (step === 'clarifying') {
          await store.setPhase(id, 'architect');
          const result = await summarizeForRequirement(item, {
            runAgent: architectRunner,
            root,
            files,
            profile,
            envPath,
            signal: controller.signal,
          });
          architectCost = result.costUsd;
          await store.setInterfaces(
            id,
            result.summary
              ? { summary: result.summary, text: result.text, read: result.read, skipped: result.skipped, error: null }
              : { summary: null, text: null, read: [], skipped: result.skipped, error: result.error },
          );
          interfaces = result.text;
          await store.setPhase(id, 'product-lead');
        }
        throwIfCancelled(controller.signal);
        const { output, costUsd } = await productRunner({
          prompt: buildPrompt({ ...item, files, interfaces, profile, course: course.pack }),
          systemPrompt: productLead.systemPrompt(course.pack),
          schema,
          envPath,
          signal: controller.signal,
        });
        outcome = { output: validate(output), costUsd: (costUsd ?? 0) + architectCost, course: course.ref };
      } catch (error) {
        outcome = { error };
      }
      // Drop the run before recording the result, so nobody sees a settled
      // requirement that still looks cancellable.
      backgroundRuns.finish('requirement', id, controller);
      const title = store.get(id).title || item.text.slice(0, 40);
      const fail = (error: unknown) => {
        const agentError = asAgentError(error);
        record({ kind: 'requirement_failed', requirementId: id, title, step, code: agentError.code ?? 'unknown' });
        return store.failRun(id, step, agentError).catch(() => {});
      };
      if ('error' in outcome) await fail(outcome.error);
      else {
        const { costUsd } = outcome;
        await finish(id, outcome.output, costUsd, outcome.course)
          .then(() => record({ kind: 'requirement_finished', requirementId: id, title: store.get(id).title || title, step, costUsd }))
          .catch(fail);
      }
    })();
    backgroundRuns.track(settled);
    return toWireRequirement(item);
  };

  const isCourse = (id: string) => requireRequirements().get(id).kind === 'course';

  const clarify = (id: string) => (isCourse(id) ? courseInterview.clarify(id).then(toWireRequirement) : clarifyProject(id));

  const clarifyProject = (id: string) =>
    startRun(id, 'clarifying', productLead.clarifyPrompt, productLead.CLARIFY_SCHEMA, productLead.validateClarify, (rid, output, cost) =>
      requireRequirements().finishClarify(rid, output, cost),
    );

  ipcMain.handle(
    CHANNELS.requirementsList,
    wrap((): requirementTypes.Requirement[] => requireRequirements().list().map(toWireRequirement)),
  );

  ipcMain.handle(
    CHANNELS.requirementsGet,
    wrap((_event, id): requirementTypes.Requirement => toWireRequirement(requireRequirements().get(requireString(id, 'id')))),
  );

  // The store validates title and text.
  ipcMain.handle(
    CHANNELS.requirementsCreate,
    wrap(async (_event, rawInput): Promise<requirementTypes.Requirement> => {
      const input = rawInput as { title?: unknown; text?: unknown; course?: unknown } | null | undefined;
      const problem = input?.course === undefined ? null : goalFormProblem(input.course);
      if (problem) failWith(problem.message, 'invalid_argument', problem.field);
      const course = input?.course === undefined ? undefined : formOf(input.course as GoalForm);
      const item = await requireRequirements().create({ title: input?.title, text: input?.text, course });
      record({ kind: 'requirement_created', requirementId: item.id, title: item.title || item.text.slice(0, 40) });
      // Clarification starts right away; the page shows it running.
      return clarify(item.id);
    }),
  );

  ipcMain.handle(
    CHANNELS.requirementsClarify,
    wrap((_event, id): Promise<requirementTypes.Requirement> => clarify(requireString(id, 'id'))),
  );

  // The store checks the answers against the questions.
  ipcMain.handle(
    CHANNELS.requirementsAnswer,
    wrap((_event, id, answers): Promise<requirementTypes.Requirement> =>
      requireRequirements().setAnswers(requireString(id, 'id'), answers).then(toWireRequirement),
    ),
  );

  ipcMain.handle(
    CHANNELS.requirementsPlan,
    wrap(async (_event, id, answers, choice): Promise<requirementTypes.Requirement> => {
      const rid = requireString(id, 'id');
      if (isCourse(rid)) return toWireRequirement(await courseInterview.plan(rid, answers, choice));
      // Answers submitted with the plan request are saved first, in one step.
      if (answers !== undefined) await requireRequirements().setAnswers(rid, answers);
      // Linked tests are checked against the submit-stage test run only.
      const linkTests = (await ctx.runnableSteps().catch(() => [])).some((step) => step.id === 'test' && step.stage === 'submit');
      return startRun(
        rid,
        'planning',
        (input) => productLead.planPrompt({ ...input, linkTests }),
        productLead.PLAN_SCHEMA,
        (raw) => productLead.validatePlan(raw, { linkTests }),
        // [人工决策-2026-10-26 15:38:21] 规划时把生效课程包的 CourseRef 快照到计划上，发布时带到工作包定义。
        (r, output, cost, course) => requireRequirements().finishPlan(r, { ...output, course }, cost),
      );
    }),
  );

  ipcMain.handle(
    CHANNELS.requirementsCancel,
    wrap((_event, id): boolean => {
      const controller = backgroundRuns.get('requirement', requireString(id, 'id'));
      if (!controller) return false;
      controller.abort();
      return true;
    }),
  );

  // Publishing turns the reviewed plan into queue entries.
  ipcMain.handle(
    CHANNELS.requirementsPublish,
    wrap(async (_event, id): Promise<requirementTypes.Requirement> => {
      const store = requireRequirements();
      const item = store.get(requireString(id, 'id'));
      // A course path is confirmed, not published: its labs come later.
      if (item.kind === 'course') return toWireRequirement(await courseInterview.confirmPath(item.id));
      if (item.status !== 'reviewing' || !item.plan) return failWith('There is no plan to publish', 'invalid_state');
      const definitions = productLead.toTaskDefinitions(item, item.plan.packages, item.plan.course);
      const published = await store.publish(item.id, definitions);
      ctx.store.add(definitions);
      ctx.onPackagesPublished?.(definitions);
      record({ kind: 'requirement_published', requirementId: item.id, title: published.title || item.text.slice(0, 40), packageCount: definitions.length });
      return toWireRequirement(published);
    }),
  );

  ipcMain.handle(
    CHANNELS.requirementsRemove,
    wrap(async (_event, id): Promise<true> => {
      const store = requireRequirements();
      const item = store.get(requireString(id, 'id'));
      // Published packages may already be claimed; removing them would orphan
      // that progress, so only unpublished requirements can be deleted.
      if (item.status === 'published') failWith('Published requirements cannot be deleted', 'invalid_state');
      await store.remove(item.id);
      return true;
    }),
  );

  // ========== Course interview ==========
  ipcMain.handle(
    CHANNELS.requirementsCoursePath,
    wrap(async (_event, id, path): Promise<requirementTypes.Requirement> => toWireRequirement(await courseInterview.savePath(requireString(id, 'id'), path))),
  );

  ipcMain.handle(
    CHANNELS.requirementsCourseSaveDraft,
    wrap(async (_event, id, pack): Promise<requirementTypes.CourseDraftSaved> => {
      const { requirement, ref } = await courseInterview.saveDraft(requireString(id, 'id'), pack);
      return { requirement: toWireRequirement(requirement), ref };
    }),
  );

  ipcMain.handle(
    CHANNELS.requirementsCourseConfirmDraft,
    wrap(async (_event, id, contentHash): Promise<requirementTypes.Requirement> =>
      toWireRequirement(await courseInterview.confirmDraft(requireString(id, 'id'), requireString(contentHash, 'contentHash'))),
    ),
  );
};
