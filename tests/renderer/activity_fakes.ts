// activity:overview for a quiet repository: nothing recent, every agent idle
// and available, no spend. Tests override the parts they look at.
import { AGENT_IDS } from '@shared/agent_runtime.ts';
import type { AgentId } from '@shared/agent_runtime.ts';
import type * as activityTypes from '@shared/ipc/activity.ts';

const perAgent = <T>(value: () => T) => Object.fromEntries(AGENT_IDS.map((agent) => [agent, value()])) as Record<AgentId, T>;

export const activityOverview = (overrides: Partial<activityTypes.ActivityOverview> = {}): activityTypes.ActivityOverview => ({
  recent: [],
  metrics: { doneThisWeek: 0, donePreviousWeek: 0, averageHours: null, averageHoursPrevious: null },
  team: { available: true, availableByAgent: perAgent(() => true), busy: [], work: [] },
  costs: { byAgent: perAgent(() => 0), since: null, partial: false },
  teamRecent: perAgent(() => []),
  timeZone: 'Asia/Shanghai',
  ...overrides,
});
