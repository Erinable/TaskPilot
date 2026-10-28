// Isolated Coding Agent runs, patches and progress.
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';
import type * as codingTypes from '../coding_types.ts';
import type * as packageTypes from './packages.ts';

export const codingContract = {
  status: invoke<[], codingTypes.CodingRuntimeStatus>('coding:status'),
  start: invoke<[id: string, input: codingTypes.CodingStart], packageTypes.TaskView>('coding:start'),
  get: invoke<[id: string], packageTypes.TaskView>('coding:get'),
  events: invoke<[id: string, after: number], codingTypes.CodingEventPage>('coding:events'),
  cancel: invoke<[id: string], boolean>('coding:cancel'),
  patch: invoke<[id: string], codingTypes.CodingPatchPreview>('coding:patch'),
  apply: invoke<[id: string, input: codingTypes.CodingApply], codingTypes.CodingApplyResult>('coding:apply'),
  resume: invoke<[id: string], packageTypes.TaskView>('coding:resume'),
  active: invoke<[], codingTypes.CodingActiveRun[]>('coding:active'),
} satisfies Contract;
