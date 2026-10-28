// Requirement orchestration: Product Lead clarification and planning, with
// Architect's repository summary and cancellable background runs, plus
// creating, publishing and removing requirements.
import * as git from '../repository/git.ts';
import { asAgentError, failWith } from '../infrastructure/coded_error.ts';
import * as productLead from '../agents/product_lead.ts';
import { summarizeForRequirement, throwIfCancelled } from '../agents/pipeline.ts';
import type * as claudeCli from '../runtimes/claude_cli.ts';
import type * as requirementTypes from '../../shared/ipc/requirements.ts';
import type { AppContext } from '../app/app_context.ts';
import type { RequirementStore } from './requirement_store.ts';
import type { CourseInterviewService } from './course_interview_service.ts';
import type { ProjectProfile } from '../../shared/project_profile.ts';
import type { CoursePack, CourseRef } from '../../shared/course_pack.ts';

type RequirementServiceContext = Pick<
  AppContext,
  | 'backgroundRuns'
  | 'commandPath'
  | 'course'
  | 'getConfig'
  | 'onPackagesPublished'
  | 'profile'
  | 'record'
  | 'requirements'
  | 'runnableSteps'
  | 'runnerFor'
  | 'store'
>;

type RequirementItem = Awaited<ReturnType<RequirementStore['get']>>;
type PromptInput = Omit<RequirementItem, 'interfaces' | 'course'> & {
  files: string[];
  interfaces: string | null;
  profile: ProjectProfile | null;
  course: CoursePack;
};

const repositoryFiles = async (root: string | null): Promise<string[]> => {
  if (!root) return [];
  try {
    return await git.listFiles(root, { limit: 400 });
  } catch {
    return [];
  }
};

export const createRequirementService = (ctx: RequirementServiceContext, { courseInterview }: { courseInterview: CourseInterviewService }) => {
  const { backgroundRuns, record } = ctx;
  const requireRequirements = () => {
    if (!ctx.requirements) return failWith('Requirements are unavailable', 'unsupported');
    return ctx.requirements;
  };

  const startRun = async <Output>(
    id: string,
    step: requirementTypes.RequirementStep,
    buildPrompt: (input: PromptInput) => string,
    schema: (course: CoursePack) => claudeCli.JsonSchema,
    validate: (raw: unknown, course: CoursePack) => Output,
    finish: (id: string, output: Output, costUsd: number, course: CourseRef) => Promise<unknown>,
  ) => {
    const store = requireRequirements();
    const architectRunner = ctx.runnerFor('architect', { kind: 'requirement', id });
    const productRunner = ctx.runnerFor('product-lead', { kind: 'requirement', id });
    const item = await store.begin(id, step);
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
    const settled = (async () => {
      let outcome: { output: Output; costUsd: number; course: CourseRef } | { error: unknown };
      try {
        const profile = await ctx.profile(config);
        const course = await ctx.course(config);
        let interfaces = item.interfaces?.text ?? null;
        let architectCost = 0;
        if (step === 'clarifying') {
          await store.setPhase(id, 'architect');
          const result = await summarizeForRequirement(item, { runAgent: architectRunner, root, files, profile, envPath, signal: controller.signal });
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
          schema: schema(course.pack),
          envPath,
          signal: controller.signal,
        });
        outcome = { output: validate(output, course.pack), costUsd: (costUsd ?? 0) + architectCost, course: course.ref };
      } catch (error) {
        outcome = { error };
      }
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
    return item;
  };

  const clarify = (id: string) => {
    const store = requireRequirements();
    return store.get(id).kind === 'course'
      ? courseInterview.clarify(id)
      : startRun(
          id,
          'clarifying',
          productLead.clarifyPrompt,
          () => productLead.CLARIFY_SCHEMA,
          productLead.validateClarify,
          (rid, output, cost) => store.finishClarify(rid, output, cost),
        );
  };

  // Answers submitted with the plan request are saved first, in one step.
  const plan = async (id: string, answers: unknown, choice: unknown) => {
    const store = requireRequirements();
    if (store.get(id).kind === 'course') return courseInterview.plan(id, answers, choice);
    if (answers !== undefined) await store.setAnswers(id, answers);
    // Linked tests are checked against the submit-stage test run only.
    const linkTests = (await ctx.runnableSteps().catch(() => [])).some((step) => step.id === 'test' && step.stage === 'submit');
    return startRun(
      id,
      'planning',
      (input) => productLead.planPrompt({ ...input, linkTests }),
      productLead.planSchema,
      // Concepts only from the skeleton of the pack planned with.
      (raw, course) => productLead.validatePlan(raw, { linkTests, concepts: (course.concepts ?? []).map((concept) => concept.id) }),
      (rid, output, cost, course) => store.finishPlan(rid, { ...output, course }, cost),
    );
  };

  // A new requirement goes straight into clarification.
  const create = async (input: Parameters<RequirementStore['create']>[0]) => {
    const item = await requireRequirements().create(input);
    record({ kind: 'requirement_created', requirementId: item.id, title: item.title || item.text.slice(0, 40) });
    return clarify(item.id);
  };

  // Returns whether a running clarification or planning run was cancelled.
  const cancel = (id: string) => {
    const controller = backgroundRuns.get('requirement', id);
    if (!controller) return false;
    controller.abort();
    return true;
  };

  // Turns the reviewed plan into work packages; a course confirms its path instead.
  const publish = async (id: string) => {
    const store = requireRequirements();
    const item = store.get(id);
    if (item.kind === 'course') return courseInterview.confirmPath(item.id);
    if (item.status !== 'reviewing' || !item.plan) return failWith('There is no plan to publish', 'invalid_state');
    const definitions = productLead.toTaskDefinitions(item, item.plan.packages, item.plan.course);
    const published = await store.publish(item.id, definitions);
    ctx.store.add(definitions);
    ctx.onPackagesPublished?.(definitions);
    record({ kind: 'requirement_published', requirementId: item.id, title: published.title || item.text.slice(0, 40), packageCount: definitions.length });
    return published;
  };

  const remove = async (id: string) => {
    const store = requireRequirements();
    const item = store.get(id);
    if (item.status === 'published') failWith('Published requirements cannot be deleted', 'invalid_state');
    await store.remove(item.id);
  };

  return { clarify, plan, create, cancel, publish, remove };
};

export type RequirementService = ReturnType<typeof createRequirementService>;
