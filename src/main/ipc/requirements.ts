// Requirement channels: Product Lead clarifies and plans, Architect summarizes code, and the human publishes the plan.
import { failWith, requireString } from '../infrastructure/coded_error.ts';
import { toWireRequirement } from '../app/app_context.ts';
import { registerContract } from './handler.ts';
import { requirementsContract } from '../../shared/ipc/requirements.ts';
import type * as requirementTypes from '../../shared/ipc/requirements.ts';
import type { AppContext } from '../app/app_context.ts';
import type { IpcMainLike } from './handler.ts';
import type { CourseInterviewService } from '../requirements/course_interview_service.ts';
import type { LabGenerationService } from '../courses/lab_generation_service.ts';
import type { RequirementService } from '../requirements/requirement_service.ts';
import { goalFormProblem } from '../../shared/course_plan.ts';
import type { GoalForm } from '../../shared/course_plan.ts';

const formOf = (form: GoalForm): GoalForm => ({ level: form.level, target: form.target, environment: form.environment.trim(), weeklyHours: form.weeklyHours });

export const register = (
  ipcMain: IpcMainLike,
  ctx: AppContext,
  {
    courseInterview,
    labGeneration,
    requirementService,
  }: { courseInterview: CourseInterviewService; labGeneration: LabGenerationService; requirementService: RequirementService },
) => {
  const requireRequirements = () => {
    if (!ctx.requirements) return failWith('Requirements are unavailable', 'unsupported');
    return ctx.requirements;
  };
  const conceptOf = (value: unknown) => (value === undefined || value === null ? null : requireString(value, 'conceptId'));

  registerContract(ipcMain, requirementsContract, {
    list: (): requirementTypes.Requirement[] => requireRequirements().list().map(toWireRequirement),

    get: (id): requirementTypes.Requirement => toWireRequirement(requireRequirements().get(requireString(id, 'id'))),

    create: async (rawInput): Promise<requirementTypes.Requirement> => {
      const input = rawInput as { title?: unknown; text?: unknown; course?: unknown } | null | undefined;
      const problem = input?.course === undefined ? null : goalFormProblem(input.course);
      if (problem) failWith(problem.message, 'invalid_argument', problem.field);
      const course = input?.course === undefined ? undefined : formOf(input.course as GoalForm);
      return toWireRequirement(await requirementService.create({ title: input?.title, text: input?.text, course }));
    },

    clarify: async (id): Promise<requirementTypes.Requirement> => toWireRequirement(await requirementService.clarify(requireString(id, 'id'))),

    answer: (id, answers): Promise<requirementTypes.Requirement> => requireRequirements().setAnswers(requireString(id, 'id'), answers).then(toWireRequirement),

    plan: async (id, answers, choice): Promise<requirementTypes.Requirement> =>
      toWireRequirement(await requirementService.plan(requireString(id, 'id'), answers, choice)),

    cancel: (id): boolean => requirementService.cancel(requireString(id, 'id')),

    publish: async (id): Promise<requirementTypes.Requirement> => toWireRequirement(await requirementService.publish(requireString(id, 'id'))),

    remove: async (id): Promise<true> => {
      await requirementService.remove(requireString(id, 'id'));
      return true;
    },

    coursePath: async (id, path): Promise<requirementTypes.Requirement> => toWireRequirement(await courseInterview.savePath(requireString(id, 'id'), path)),

    courseSaveDraft: async (id, pack): Promise<requirementTypes.CourseDraftSaved> => {
      const result = await courseInterview.saveDraft(requireString(id, 'id'), pack);
      return { requirement: toWireRequirement(result.requirement), ref: result.ref };
    },

    courseConfirmDraft: async (id, contentHash): Promise<requirementTypes.Requirement> =>
      toWireRequirement(await courseInterview.confirmDraft(requireString(id, 'id'), requireString(contentHash, 'contentHash'))),

    labEstimate: (id, conceptId): Promise<requirementTypes.LabEstimate> => labGeneration.estimate(requireString(id, 'id'), conceptOf(conceptId)),

    labGenerate: async (id, conceptId): Promise<requirementTypes.Requirement> =>
      toWireRequirement(await labGeneration.start(requireString(id, 'id'), conceptOf(conceptId))),

    labPlace: async (id, root): Promise<requirementTypes.Requirement> =>
      toWireRequirement(await labGeneration.place(requireString(id, 'id'), root === undefined || root === null ? null : requireString(root, 'root'))),

    courseSkip: async (id, conceptId): Promise<requirementTypes.Requirement> =>
      toWireRequirement(await requireRequirements().skipCourseConcept(requireString(id, 'id'), requireString(conceptId, 'conceptId'))),
  });
};
