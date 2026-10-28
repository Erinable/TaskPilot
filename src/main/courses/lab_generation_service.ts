// Generating a course's first lab once its path is confirmed: the learner
// sees what the lab covers and roughly what it costs, confirms, and the lab
// generator (./agents/lab_generator.ts) writes it in the background. The
// result is a lab draft, kept with the private parts outside any repository
// (userData/lab_drafts/<requirementId>/lab.json); T5's self-check reads it
// and T3's ./lab_service.ts writes the lab repository from it.
//
// [人工决策-2026-10-27 00:36:21] lab 只做"仓库 + 测试"：生成器只出 JSON，TaskPilot 校验后转成 lab 产物。
//
// The reference patch is made by git from the starter code and the
// solution, so the model never writes a patch by hand. The draft only lives
// in the main process's private folder; the renderer sees a title and counts.
//
// SECURITY: the draft holds the solution, the hidden tests and the hints, so
// no channel returns it; the requirement carries only counts. Generation
// spends money, so it only starts from the learner's click after the
// estimate (requirements:lab-estimate, then requirements:lab-generate).
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { asAgentError, failWith } from '../infrastructure/coded_error.ts';
import * as courses from './courses.ts';
import * as git from '../repository/git.ts';
import * as labs from './labs.ts';
import * as generator from '../agents/lab_generator.ts';
import * as verifier from '../agents/lab_verifier.ts';
import * as labVerify from './lab_verify.ts';
import * as labHidden from './lab_hidden.ts';
import * as projectConfig from '../repository/project_config.ts';
import { PRESET_IDS } from '../checking/presets/index.ts';
import { toLabArtifact } from './lab_artifact.ts';
import type { LabDraft } from './lab_artifact.ts';
import { readDraft as loadDraft, readReport as loadReport, writeDraft, writeReport } from './lab_draft.ts';
import { estimateLab } from './lab_estimate.ts';
import { wireLab, verifyState } from './lab_wire.ts';
import { loadPrices, priceFor } from '../activity/model_prices.ts';
import { nextLab, stuckNotes as selectStuckNotes } from './lab_planning.ts';
import type { AppContext } from '../app/app_context.ts';
import type { LabService } from './lab_service.ts';
import type { Requirement } from '../requirements/requirement_store.ts';
import type { RunAgent } from '../runtimes/claude_cli.ts';
import type { CoursePack } from '../../shared/course_pack.ts';
import type * as requirementTypes from '../../shared/ipc/requirements.ts';

type LabGenerationServiceContext = Pick<
  AppContext,
  | 'backgroundRuns'
  | 'commandPath'
  | 'configDir'
  | 'coursePlaces'
  | 'getPreferences'
  | 'mastery'
  | 'modelCatalog'
  | 'notes'
  | 'repositories'
  | 'requireRoot'
  | 'requirements'
  | 'runnerFor'
  | 'store'
>;

// `grader` runs `make grade` for the self-check; tests replace it, the app
// uses the offline Seatbelt one.
export const createLabGenerationService = (
  ctx: LabGenerationServiceContext,
  { grader = labVerify.sandboxGrader(), labService }: { grader?: labVerify.Grader; labService: LabService },
) => {
  const { backgroundRuns } = ctx;
  const requireRequirements = () => ctx.requirements ?? failWith('Requirements are unavailable', 'unsupported');

  // The confirmed course requirement and the pack its path was planned
  // from; the pack must still be trusted at the planned content.
  const courseOf = async (id: string): Promise<{ item: Requirement; pack: CoursePack }> => {
    const item = requireRequirements().get(id);
    if (item.kind !== 'course' || item.status !== 'published' || !item.course?.plan) return failWith('Confirm the learning path first', 'invalid_state');
    const planned = item.course.plan.course;
    const places = ctx.coursePlaces();
    const entry = (await courses.availableCourses(places)).find((candidate) => candidate.id === planned.id);
    if (!entry) return failWith(`Course pack ${planned.id} is gone`, 'unknown_course', 'course');
    const { pack, ref } = await courses.loadCourse(places, entry);
    if (ref.contentHash !== planned.contentHash) return failWith(`Course pack ${planned.id} changed since the path was planned`, 'course_changed', 'course');
    if ((await courses.trustOf(places, ref)) === 'pending')
      return failWith(`Course pack ${planned.id} is not confirmed on this machine`, 'course_not_confirmed', 'course');
    return { item, pack };
  };

  // The open lab repository this path's labs go into, or null before it
  // exists (the next lab is stage 1). A path whose repository is elsewhere
  // is refused: its labs are generated with that repository open.
  const labRepository = async (item: Requirement) => {
    const repositoryId = item.course?.repositoryId ?? null;
    if (!repositoryId) return null;
    if (ctx.repositories.current?.id !== repositoryId) return failWith('Open the lab repository of this course first', 'not_lab_repository');
    const root = ctx.requireRoot();
    const text = await projectConfig.readProjectText(root);
    const project = text === null ? null : projectConfig.parseProject(text, PRESET_IDS);
    if (!project?.labs.length) return failWith('This repository is not a course lab repository', 'not_lab_repository');
    return { root, labs: project.labs };
  };

  // What the next stage is generated against: the stage number, the labs
  // and files so far, and the current build rules.
  const existingOf = async (repository: Awaited<ReturnType<typeof labRepository>>) => {
    if (!repository) return { stage: 1, existing: { labIds: [], files: [], build: null } };
    const files = await git.workingFiles(repository.root);
    const build = files.includes(labs.BUILD_RULES_PATH) ? await fs.readFile(path.join(repository.root, labs.BUILD_RULES_PATH), 'utf8') : null;
    return {
      stage: Math.max(...repository.labs.map((lab) => lab.stage)) + 1,
      existing: { labIds: repository.labs.map((lab) => lab.id), files: files.filter((file) => file.startsWith('src/')), build },
    };
  };

  const requestFor = async (id: string, conceptId: string | null) => {
    const { item, pack } = await courseOf(id);
    const next = nextLab(item, ctx.mastery?.ofCourse(pack.id) ?? new Map(), conceptId);
    logger.debug(`[lab-gen] next requirement=${id} concept=${next.conceptId} difficulty=${next.difficulty} change=${next.change} stuck=${next.stuck}`);
    const repository = await labRepository(item);
    const request: generator.LabRequest = {
      course: pack,
      goal: item.course!.plan!.goal,
      concepts: [next.concept],
      difficulty: next.difficulty,
      ...(await existingOf(repository)),
    };
    return { request, next, course: pack.id, root: repository?.root ?? null };
  };

  // ========== Estimate ==========
  // Prompts are measured; the code call's input adds the spec it is given.
  // Priced with the synced price table for the model Tutor's CLI would use.
  // The self-check's calls (mutants and the review each round, a repair
  // between rounds) are counted in, since the run makes them unasked.
  const estimate = async (id: string, conceptId: string | null = null): Promise<requirementTypes.LabEstimate> => {
    const { request, next, course } = await requestFor(id, conceptId);
    const config = ctx.getPreferences().agents.tutor;
    const model = config.model || (await ctx.modelCatalog(config.cli, 'analysis').catch(() => null))?.defaultModel || null;
    const price = priceFor(await loadPrices(ctx.configDir), config.cli === 'claude' ? 'anthropic' : null, model);
    logger.debug(`[lab-gen] estimate requirement=${id} concepts=${request.concepts.map((concept) => concept.id).join(',')} model=${model ?? 'unknown'}`);
    return estimateLab({ request, next, model, price, stuck: next.stuck ? selectStuckNotes(ctx.notes?.list().notes ?? [], course, next.conceptId) : [] });
  };

  // ========== Generation ==========
  const update = (id: string, lab: requirementTypes.LabGeneration, costUsd = 0) => requireRequirements().setCourseLab(id, lab, costUsd);

  const saveDraft = (draft: LabDraft) => writeDraft(ctx.configDir, draft);
  const saveReport = (requirementId: string, report: labVerify.LabVerifyReport) => writeReport(ctx.configDir, requirementId, report);

  // Checks the lab and repairs it between rounds; every call is billed to
  // the requirement through `runAgent`. Each repaired version is kept, so a
  // cancel or a failure leaves the latest draft.
  const verify = async (
    draft: LabDraft,
    {
      runAgent,
      envPath,
      signal,
      onProgress,
      base,
    }: {
      runAgent: RunAgent;
      envPath: string | null;
      signal: AbortSignal;
      base: Record<string, string>;
      onProgress: (state: Parameters<labVerify.VerifyProgress>[0], lab: generator.GeneratedLab) => Promise<void>;
    },
  ) => {
    const call = { runAgent, envPath, signal };
    let saved = draft;
    const result = await labVerify.verifyLab(
      draft.lab,
      { stage: draft.request.stage, base },
      {
        grade: grader,
        envPath,
        signal,
        onProgress: (state) => onProgress(state, saved.lab),
        writeMutants: (lab) => verifier.writeMutants(draft.request, lab, call),
        judge: (lab) => verifier.judgeConsistency(draft.request, lab, call),
        repair: async (lab, failure) => {
          const repaired = await generator.repair(draft.request, lab, failure, call);
          await toLabArtifact(repaired.lab, draft.request);
          saved = { ...saved, lab: repaired.lab, costUsd: saved.costUsd + repaired.costUsd };
          await saveDraft(saved);
          logger.debug(`[lab-gen] repaired requirement=${draft.requirementId} parts=${failure.parts.join(',')} costUsd=${repaired.costUsd.toFixed(3)}`);
          return repaired;
        },
      },
    );
    await saveReport(draft.requirementId, result.report);
    return { draft: saved, report: result.report };
  };

  // Generates the first lab and checks it in the background; the
  // requirement shows its progress and the run is cancelled with
  // requirements:cancel (or by a repository switch).
  const start = async (id: string, conceptId: string | null = null) => {
    const { request, root } = await requestFor(id, conceptId);
    const lab = requireRequirements().get(id).course?.lab;
    // Checked first: a run that just finished may still be leaving the registry.
    if (lab?.status === 'ready' && !lab.placed) return failWith('Write the lab that is ready into the lab repository first', 'lab_not_placed');
    if (lab?.status === 'running' || backgroundRuns.has('requirement', id)) return failWith('A lab is already being generated', 'invalid_state');
    // The next stage builds on the last one's code, so it waits until that
    // stage is done.
    const last = (await labRepository(requireRequirements().get(id)))?.labs.reduce((latest, entry) => (entry.stage > latest.stage ? entry : latest));
    if (last && ctx.store.get(labs.packageId(last.id)).status !== 'done') return failWith(`Finish lab ${last.id} first`, 'previous_lab_open');
    // A later stage is checked on top of the repository as it stands, so
    // the earlier stages' tests run as regression tests.
    const verifyBase = root ? { ...(await labHidden.workingTree(root, { publicTests: true })), ...labVerify.FIRST_STAGE_BASE } : labVerify.FIRST_STAGE_BASE;
    const startedAt = new Date().toISOString();
    const base: requirementTypes.LabGeneration = {
      status: 'running',
      phase: 'spec',
      concepts: request.concepts.map((concept) => concept.id),
      difficulty: request.difficulty,
      startedAt,
      finishedAt: null,
      costUsd: 0,
      lab: null,
      verify: null,
      error: null,
      stage: request.stage,
      placed: false,
    };
    const started = await update(id, base);
    const controller = backgroundRuns.start({ kind: 'requirement', key: id, busy: 'requirement', agent: () => 'tutor', label: () => started.title || id });
    logger.debug(`[lab-gen] start requirement=${id} concepts=${base.concepts.join(',')} difficulty=${base.difficulty}`);
    let spent = 0;
    let current = base;
    const progress = async (next: requirementTypes.LabGeneration) => {
      current = next;
      await update(id, { ...next, costUsd: spent });
    };
    // Each call's spend is added as it is reported, so a failure keeps it.
    const runner = ctx.runnerFor('tutor', { kind: 'requirement', id });
    const runAgent: RunAgent = async (options) => {
      const result = await runner(options);
      spent += result.costUsd ?? 0;
      return result;
    };
    const settled = (async () => {
      try {
        const { path: envPath } = await ctx.commandPath();
        const { lab, costUsd } = await generator.generate(request, {
          runAgent,
          envPath,
          signal: controller.signal,
          onPhase: (phase) => progress({ ...current, phase }),
        });
        // A lab that does not make an artifact is a bad output like any other.
        await toLabArtifact(lab, request).catch((error) => {
          throw Object.assign(new Error(`The generated lab does not check: ${(error as Error).message}`), { code: 'agent_bad_output' });
        });
        const draft = { requirementId: id, request, lab, costUsd };
        await saveDraft(draft);
        const generatedCost = spent;
        const checked = await verify(draft, {
          runAgent,
          envPath,
          signal: controller.signal,
          base: verifyBase,
          onProgress: ({ round, phase, rounds }, latest) =>
            progress({ ...current, phase, lab: wireLab(latest), verify: verifyState(round, rounds, spent - generatedCost) }),
        });
        const status = checked.report.status === 'passed' ? 'ready' : 'needs_review';
        const finished = { ...current, status, phase: null, finishedAt: new Date().toISOString(), lab: wireLab(checked.draft.lab) } as const;
        await update(
          id,
          { ...finished, costUsd: spent, verify: verifyState(checked.report.rounds.length, checked.report.rounds, checked.report.costUsd) },
          spent,
        );
        logger.debug(`[lab-gen] ${status} requirement=${id} lab=${lab.id} rounds=${checked.report.rounds.length} costUsd=${spent.toFixed(3)}`);
      } catch (error) {
        const agentError = asAgentError(error);
        if (agentError.code !== 'agent_cancelled') logger.error(error);
        logger.debug(`[lab-gen] failed requirement=${id} code=${agentError.code ?? 'unknown'}`);
        await update(
          id,
          {
            ...current,
            status: 'failed',
            phase: null,
            finishedAt: new Date().toISOString(),
            costUsd: spent,
            error: { code: agentError.code ?? 'agent_failed', message: agentError.message },
          },
          spent,
        ).catch((failure) => logger.error(failure));
      } finally {
        backgroundRuns.finish('requirement', id, controller);
      }
    })();
    backgroundRuns.track(settled);
    return started;
  };

  // ========== Main process only ==========

  // Rewrites the parts of the draft a failed self-check names, and keeps
  // the new version. Awaited by the caller, which owns the run.
  const repair = async (id: string, failure: { report: string; parts: generator.LabPart[] }, signal?: AbortSignal) => {
    const draft = await loadDraft(ctx.configDir, id);
    const { path: envPath } = await ctx.commandPath();
    const runAgent = ctx.runnerFor('tutor', { kind: 'requirement', id });
    const { lab, costUsd } = await generator.repair(draft.request, draft.lab, failure, { runAgent, envPath, signal });
    await toLabArtifact(lab, draft.request);
    const next = { ...draft, lab, costUsd: draft.costUsd + costUsd };
    await saveDraft(next);
    logger.debug(`[lab-gen] repaired requirement=${id} parts=${failure.parts.join(',')} costUsd=${costUsd.toFixed(3)}`);
    return { draft: next, costUsd };
  };

  // The draft as a lab artifact, for the repository, with its self-check
  // report as the private verify.json.
  const artifact = async (id: string) => {
    const draft = await loadDraft(ctx.configDir, id);
    return toLabArtifact(draft.lab, draft.request, await loadReport(ctx.configDir, id));
  };

  // ========== Placing ==========
  // Writes the lab whose self-check passed into the lab repository: the
  // first one creates the repository in `root` (an empty folder the learner
  // picked) and opens it, copying the course requirement there; a later one
  // is the open repository's next stage. Returns the requirement as the lab
  // repository now has it.
  const place = async (id: string, root: string | null) => {
    const { item } = await courseOf(id);
    const lab = item.course!.lab;
    if (lab?.status !== 'ready') return failWith('There is no lab whose self-check passed', 'invalid_state');
    if (lab.placed) return failWith('This lab is already in the lab repository', 'invalid_state');
    const built = await artifact(id);
    const placed = { ...lab, placed: true };
    if (!item.course!.repositoryId) {
      if (root === null) return failWith('Pick an empty folder for the lab repository', 'required', 'root');
      const plan = item.course!.plan!;
      const coursePlan = { course: plan.course.id, path: plan.path, goal: plan.goal, extraConcepts: plan.extraConcepts };
      let moved: Requirement | null = null;
      await labService.createRepository({
        root,
        course: plan.course.id,
        plan: coursePlan,
        labs: [built],
        // The repository the interview ran in keeps a pointer to the new one.
        beforeOpen: async (entry) => {
          moved = { ...item, course: { ...item.course!, lab: placed, repositoryId: entry.id } };
          await requireRequirements().putCourse(moved);
        },
      });
      logger.debug(`[lab-gen] placed requirement=${id} lab=${built.id} stage=1 repository=${ctx.repositories.current?.id}`);
      return requireRequirements().putCourse(moved!);
    }
    await labRepository(item);
    await labService.addLab(built);
    logger.debug(`[lab-gen] placed requirement=${id} lab=${built.id} stage=${lab.stage ?? 1}`);
    return update(id, placed);
  };

  return { estimate, start, repair, artifact, place, report: (id: string) => loadReport(ctx.configDir, id) };
};

export type LabGenerationService = ReturnType<typeof createLabGenerationService>;
