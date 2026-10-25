// Version plans: which requirements a version is meant to ship. A
// requirement is in at most one open milestone. Progress counts the
// packages of its requirements, so it moves as work is accepted.
//
// [人工决策-2026-10-14] 里程碑以需求为单位，放在发布页顶部；全部完成后可直接起草发布说明。
import type { Milestone } from '../shared/ipc/release.ts';

export const MAX_MILESTONES = 20;
export const MAX_MILESTONE_REQUIREMENTS = 30;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class MilestoneError extends Error {
  code: 'invalid_argument' | 'invalid_state' | 'not_found';
  field?: string;
  constructor(message: string, code: MilestoneError['code'], field?: string) {
    super(message);
    this.name = 'MilestoneError';
    this.code = code;
    if (field) this.field = field;
  }
}

// A milestone's editable fields, checked. `known` are the existing
// requirement ids, so a plan never points at a deleted requirement.
export const parseMilestoneInput = (raw: unknown, known: ReadonlySet<string>): Pick<Milestone, 'version' | 'targetDate' | 'requirementIds'> => {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const version = typeof input.version === 'string' ? input.version.trim() : '';
  if (!VERSION.test(version)) throw new MilestoneError('Version must look like 1.2.0', 'invalid_argument', 'version');
  const targetDate = input.targetDate === null || input.targetDate === undefined || input.targetDate === '' ? null : input.targetDate;
  if (targetDate !== null && (typeof targetDate !== 'string' || !DAY.test(targetDate) || Number.isNaN(Date.parse(targetDate)))) {
    throw new MilestoneError('Target date must be YYYY-MM-DD', 'invalid_argument', 'targetDate');
  }
  const ids = Array.isArray(input.requirementIds) ? input.requirementIds : [];
  if (ids.length > MAX_MILESTONE_REQUIREMENTS)
    throw new MilestoneError(`At most ${MAX_MILESTONE_REQUIREMENTS} requirements`, 'invalid_argument', 'requirementIds');
  const requirementIds = [...new Set(ids)].filter((id): id is string => typeof id === 'string' && known.has(id));
  return { version, targetDate: targetDate as string | null, requirementIds };
};

// Puts `requirementId` into `target` (or no milestone, when null), taking it
// out of any other open milestone. Released milestones are history.
export const assignRequirement = (milestones: Milestone[], requirementId: string, target: string | null): Milestone[] => {
  if (target !== null) {
    const found = milestones.find((milestone) => milestone.id === target);
    if (!found) throw new MilestoneError('No such milestone', 'not_found', 'milestoneId');
    if (found.releasedAt) throw new MilestoneError('This version is already released', 'invalid_state', 'milestoneId');
    if (!found.requirementIds.includes(requirementId) && found.requirementIds.length >= MAX_MILESTONE_REQUIREMENTS) {
      throw new MilestoneError(`At most ${MAX_MILESTONE_REQUIREMENTS} requirements`, 'invalid_argument', 'milestoneId');
    }
  }
  return milestones.map((milestone) => {
    if (milestone.releasedAt) return milestone;
    const without = milestone.requirementIds.filter((id) => id !== requirementId);
    return { ...milestone, requirementIds: milestone.id === target ? [...without, requirementId] : without };
  });
};
