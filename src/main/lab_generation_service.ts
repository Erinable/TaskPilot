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
import os from 'node:os';
import path from 'node:path';

import { asAgentError, failWith } from './coded_error.ts';
import * as courses from './courses.ts';
import * as git from './git.ts';
import * as labs from './labs.ts';
import * as generator from './agents/lab_generator.ts';
import * as verifier from './agents/lab_verifier.ts';
import * as labVerify from './lab_verify.ts';
import * as progress from './lab_progress.ts';
import { writeFileAtomic } from './atomic_json_file.ts';
import { estimateMicros, loadPrices, priceFor } from './model_prices.ts';
import type { AppContext } from './app_context.ts';
import type { Requirement } from './requirement_store.ts';
import type { RunAgent } from './agents/claude_cli.ts';
import { DEFAULT_COURSE_ID } from '../shared/course_pack.ts';
import type { CoursePack } from '../shared/course_pack.ts';
import type { Difficulty } from '../shared/ipc/packages.ts';
import type { MasteryRecord } from './mastery_store.ts';
import type * as requirementTypes from '../shared/ipc/requirements.ts';

const DRAFTS_DIRNAME = 'lab_drafts';
// Notes offered for review when the learner is stuck on a concept.
const MAX_STUCK_NOTES = 10;
const DRAFT_FILENAME = 'lab.json';
const VERIFY_FILENAME = 'verify.json';

// Rough token counts for the estimate: prompts are measured, output is the
// range the lab-gen eval saw per call (evals/lab-gen/README.md), thinking
// included; the code call also reads the spec back. Input is priced as
// uncached, which can only overstate.
const CHARS_PER_TOKEN = 3;
const CLI_OVERHEAD_TOKENS = 3000;
const SPEC_JSON_TOKENS = 8000;
const SPEC_OUTPUT_TOKENS = { low: 50_000, high: 120_000 };
const CODE_OUTPUT_TOKENS = { low: 45_000, high: 100_000 };
// The self-check's two calls read the whole lab back. Not yet measured by an
// eval: a guess from the generator's calls, to be calibrated with T12.
const LAB_JSON_TOKENS = 16_000;
const VERIFY_OUTPUT_TOKENS = { low: 15_000, high: 40_000 };
// low: one round that passes; high: a failed round, one repair (priced as a
// code call) and a second round, the path the CARM-33 example takes.
const VERIFY_ROUNDS = { low: 1, high: 2 };
const REPAIRS = { low: 0, high: 1 };

// The first lab's difficulty from the form's level; later labs adjust it
// from mastery (./lab_progress.ts). Not yet confirmed by the user (see the
// CARM-40 hand-off).
const FIRST_DIFFICULTY: Record<requirementTypes.CourseInterview['form']['level'], Difficulty> = { new: 'easy', basic: 'easy', solid: 'medium' };

// What the generator writes, private: the request it was written for and the
// lab; `costUsd` is the generation's, the self-check's is on its report.
export type LabDraft = { requirementId: string; request: generator.LabRequest; lab: generator.GeneratedLab; costUsd: number };

const draftDir = (configDir: string, requirementId: string) => path.join(configDir, DRAFTS_DIRNAME, encodeURIComponent(requirementId));
export const draftPath = (configDir: string, requirementId: string) => path.join(draftDir(configDir, requirementId), DRAFT_FILENAME);
export const verifyPath = (configDir: string, requirementId: string) => path.join(draftDir(configDir, requirementId), VERIFY_FILENAME);

// The generated lab as a lab artifact (./labs.ts), checked for its stage.
// The reference is the patch from the starter code to the solution, made by
// git in a scratch folder, so the model never writes a patch by hand.
export const toLabArtifact = async (
  lab: generator.GeneratedLab,
  request: generator.LabRequest,
  verify: labVerify.LabVerifyReport | null = null,
): Promise<labs.LabArtifact> => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-diff-'));
  try {
    const write = async (side: string, files: generator.SourceFile[]) => {
      for (const file of files) {
        await fs.mkdir(path.dirname(path.join(scratch, side, file.path)), { recursive: true });
        await fs.writeFile(path.join(scratch, side, file.path), file.content);
      }
    };
    const solved = lab.starter.map((file) => lab.solution.find((entry) => entry.path === file.path) ?? file);
    await write('a', lab.starter);
    await write('b', solved);
    const reference = await git.diffFolders(scratch, 'a', 'b');
    const artifact: labs.LabArtifact = {
      id: lab.id,
      title: lab.title,
      summary: lab.summary,
      difficulty: { level: request.difficulty, reason: lab.difficultyReason },
      estimateHours: lab.estimateHours,
      concepts: request.concepts.map((concept) => concept.id),
      readme: lab.readme,
      steps: lab.steps,
      acceptance: lab.acceptance,
      files: Object.fromEntries(lab.starter.map((file) => [file.path, file.content])),
      fileScope: lab.fileScope,
      publicTests: Object.fromEntries(lab.publicTests.map((file) => [file.file, file.script])),
      build: lab.build,
      private: {
        reference,
        hidden: Object.fromEntries(lab.hiddenTests.map((file) => [file.file, file.script])),
        hints: lab.hints,
        verify,
        rubric: lab.rubricNotes,
      },
    };
    return labs.checkLab(artifact, request.stage);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
};

// The concept and difficulty of the next lab: the one ./lab_progress.ts
// picks from the path and the course's mastery, or the one the learner
// picked instead (a self-check that ended in needs_review offers another),
// which must be on the path and still to learn.
export const nextLab = (item: Requirement, records: Map<string, MasteryRecord>, conceptId: string | null = null) => {
  const plan = item.course?.plan ?? failWith('There is no confirmed path', 'invalid_state');
  const concepts = [...item.course!.pathConcepts, ...plan.extraConcepts];
  const start = FIRST_DIFFICULTY[item.course!.form.level];
  const next = progress.nextConcept({ path: plan.path, concepts, records, start, only: conceptId });
  if (!next && conceptId) return failWith(`${conceptId} is not a concept still to learn on the path`, 'invalid_argument', 'conceptId');
  if (!next) {
    if (plan.path.some((candidate) => candidate.status === 'planned' && !progress.isMastered(records.get(candidate.conceptId) ?? null)))
      return failWith('Every concept left waits on a prerequisite that has not passed', 'nothing_to_learn');
    return failWith('Every concept on the path is known, skipped or mastered', 'nothing_to_learn');
  }
  const concept = concepts.find((candidate) => candidate.id === next.conceptId);
  return { ...next, concept: concept ?? failWith(`The path names an unknown concept ${next.conceptId}`, 'invalid_state') };
};

const wireLab = (lab: generator.GeneratedLab): NonNullable<requirementTypes.LabGeneration['lab']> => ({
  id: lab.id,
  title: lab.title,
  summary: lab.summary,
  estimateHours: lab.estimateHours,
  starterFiles: lab.starter.length,
  publicTests: lab.publicTests.reduce((sum, file) => sum + file.names.length, 0),
  hiddenTests: lab.hiddenTests.reduce((sum, file) => sum + file.names.length, 0),
});

// `grader` runs `make grade` for the self-check; tests replace it, the app
// uses the offline Seatbelt one.
export const createLabGenerationService = (ctx: AppContext, { grader = labVerify.sandboxGrader() }: { grader?: labVerify.Grader } = {}) => {
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

  const requestFor = async (id: string, conceptId: string | null) => {
    const { item, pack } = await courseOf(id);
    const next = nextLab(item, ctx.mastery?.ofCourse(pack.id) ?? new Map(), conceptId);
    console.debug(`[lab-gen] next requirement=${id} concept=${next.conceptId} difficulty=${next.difficulty} change=${next.change} stuck=${next.stuck}`);
    const request: generator.LabRequest = {
      course: pack,
      goal: item.course!.plan!.goal,
      concepts: [next.concept],
      difficulty: next.difficulty,
      stage: 1,
      existing: { labIds: [], files: [], build: null },
    };
    return { request, next, course: pack.id };
  };

  // [人工决策-2026-10-27 00:36:21] 不能卡住：同一知识点连续 2 次 fail 自动降一级；降到 easy 还 fail，
  // 提示学生先复习这个知识点的笔记，或把它标成跳过（requirements:course-skip）。
  const stuckNotes = (course: string, conceptId: string) =>
    (ctx.notes?.list().notes ?? [])
      .filter((note) => note.concepts.includes(conceptId) && (note.course ?? DEFAULT_COURSE_ID) === course)
      .slice(0, MAX_STUCK_NOTES)
      .map((note) => ({ id: note.id, title: note.title }));

  // ========== Estimate ==========
  // Prompts are measured; the code call's input adds the spec it is given.
  // Priced with the synced price table for the model Tutor's CLI would use.
  // The self-check's calls (mutants and the review each round, a repair
  // between rounds) are counted in, since the run makes them unasked.
  const estimate = async (id: string, conceptId: string | null = null): Promise<requirementTypes.LabEstimate> => {
    const { request, next, course } = await requestFor(id, conceptId);
    const promptTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN) + CLI_OVERHEAD_TOKENS;
    const specInput = promptTokens(generator.systemPrompt() + generator.specPrompt(request));
    const verifyInput = promptTokens(verifier.mutantSystemPrompt() + verifier.consistencySystemPrompt()) + 2 * LAB_JSON_TOKENS;
    const usage = (bound: 'low' | 'high') => ({
      input: 2 * specInput + SPEC_JSON_TOKENS + VERIFY_ROUNDS[bound] * verifyInput + REPAIRS[bound] * (specInput + LAB_JSON_TOKENS),
      output:
        SPEC_OUTPUT_TOKENS[bound] + CODE_OUTPUT_TOKENS[bound] + VERIFY_ROUNDS[bound] * VERIFY_OUTPUT_TOKENS[bound] + REPAIRS[bound] * CODE_OUTPUT_TOKENS[bound],
    });
    const config = ctx.getPreferences().agents.tutor;
    const model = config.model || (await ctx.modelCatalog(config.cli, 'analysis').catch(() => null))?.defaultModel || null;
    const price = priceFor(await loadPrices(ctx.configDir), config.cli === 'claude' ? 'anthropic' : null, model);
    const usd = (bound: 'low' | 'high') => (price ? estimateMicros(price, { ...usage(bound), cacheRead: 0, cacheWrite: 0 }) / 1_000_000 : 0);
    console.debug(`[lab-gen] estimate requirement=${id} concepts=${request.concepts.map((concept) => concept.id).join(',')} model=${model ?? 'unknown'}`);
    return {
      concepts: request.concepts.map((concept) => ({ id: concept.id, label: concept.label })),
      difficulty: request.difficulty,
      change: next.change,
      stuck: next.stuck ? { notes: stuckNotes(course, next.conceptId) } : null,
      calls: 2 + 2 * VERIFY_ROUNDS.low,
      maxCalls: 2 + 2 * labVerify.MAX_ROUNDS + (labVerify.MAX_ROUNDS - 1),
      tokens: usage('high'),
      model,
      usd: price ? { low: usd('low'), high: usd('high') } : null,
    };
  };

  // ========== Generation ==========
  const update = (id: string, lab: requirementTypes.LabGeneration, costUsd = 0) => requireRequirements().setCourseLab(id, lab, costUsd);

  const saveDraft = async (draft: LabDraft) => {
    const file = draftPath(ctx.configDir, draft.requirementId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(file, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  };

  const saveReport = async (requirementId: string, report: labVerify.LabVerifyReport) =>
    writeFileAtomic(verifyPath(ctx.configDir, requirementId), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  // The self-check's progress as the learner sees it: verdicts and counts.
  const verifyState = (round: number, rounds: labVerify.RoundReport[], costUsd: number): requirementTypes.LabVerify => ({
    round,
    maxRounds: labVerify.MAX_ROUNDS,
    rounds: rounds.map(labVerify.wireRound),
    costUsd,
  });

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
    }: {
      runAgent: RunAgent;
      envPath: string | null;
      signal: AbortSignal;
      onProgress: (state: Parameters<labVerify.VerifyProgress>[0], lab: generator.GeneratedLab) => Promise<void>;
    },
  ) => {
    const call = { runAgent, envPath, signal };
    let saved = draft;
    const result = await labVerify.verifyLab(
      draft.lab,
      { stage: draft.request.stage, base: labVerify.FIRST_STAGE_BASE },
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
          console.debug(`[lab-gen] repaired requirement=${draft.requirementId} parts=${failure.parts.join(',')} costUsd=${repaired.costUsd.toFixed(3)}`);
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
    const { request } = await requestFor(id, conceptId);
    if (requireRequirements().get(id).course?.lab?.status === 'running' || backgroundRuns.has('requirement', id))
      return failWith('A lab is already being generated', 'invalid_state');
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
    };
    const started = await update(id, base);
    const controller = backgroundRuns.start({ kind: 'requirement', key: id, busy: 'requirement', agent: () => 'tutor', label: () => started.title || id });
    console.debug(`[lab-gen] start requirement=${id} concepts=${base.concepts.join(',')} difficulty=${base.difficulty}`);
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
        console.debug(`[lab-gen] ${status} requirement=${id} lab=${lab.id} rounds=${checked.report.rounds.length} costUsd=${spent.toFixed(3)}`);
      } catch (error) {
        const agentError = asAgentError(error);
        if (agentError.code !== 'agent_cancelled') console.error(error);
        console.debug(`[lab-gen] failed requirement=${id} code=${agentError.code ?? 'unknown'}`);
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
        ).catch((failure) => console.error(failure));
      } finally {
        backgroundRuns.finish('requirement', id, controller);
      }
    })();
    backgroundRuns.track(settled);
    return started;
  };

  // ========== Main process only ==========
  const readJson = async <T>(file: string, missing: () => T): Promise<T> => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing();
      throw error;
    }
  };
  const readDraft = (id: string) =>
    readJson<LabDraft>(draftPath(ctx.configDir, id), () => failWith('No lab has been generated for this requirement', 'no_lab_draft'));
  const readReport = (id: string) => readJson<labVerify.LabVerifyReport | null>(verifyPath(ctx.configDir, id), () => null);

  // Rewrites the parts of the draft a failed self-check names, and keeps
  // the new version. Awaited by the caller, which owns the run.
  const repair = async (id: string, failure: { report: string; parts: generator.LabPart[] }, signal?: AbortSignal) => {
    const draft = await readDraft(id);
    const { path: envPath } = await ctx.commandPath();
    const runAgent = ctx.runnerFor('tutor', { kind: 'requirement', id });
    const { lab, costUsd } = await generator.repair(draft.request, draft.lab, failure, { runAgent, envPath, signal });
    await toLabArtifact(lab, draft.request);
    const next = { ...draft, lab, costUsd: draft.costUsd + costUsd };
    await saveDraft(next);
    console.debug(`[lab-gen] repaired requirement=${id} parts=${failure.parts.join(',')} costUsd=${costUsd.toFixed(3)}`);
    return { draft: next, costUsd };
  };

  // The draft as a lab artifact, for the repository, with its self-check
  // report as the private verify.json.
  const artifact = async (id: string) => {
    const draft = await readDraft(id);
    return toLabArtifact(draft.lab, draft.request, await readReport(id));
  };

  return { estimate, start, repair, artifact, report: readReport };
};

export type LabGenerationService = ReturnType<typeof createLabGenerationService>;
