// Main-process invalidations; payloads never carry model output or private lab data.
import { event } from './contract.ts';
import type { Contract } from './contract.ts';

export type StateDomain =
  'packages' | 'requirements' | 'release' | 'tutor' | 'notes' | 'activity' | 'coding' | 'environment' | 'workspace' | 'courses' | 'mastery' | 'preferences';
export type StateChange = { repositoryId: string | null; domains: StateDomain[] };

export const stateContract = { onChanged: event<StateChange>('state:changed') } satisfies Contract;
