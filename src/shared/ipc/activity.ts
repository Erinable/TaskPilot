// The activity feed and overview, model spend and the engineering map (activity:*,
// costs:*, engineering-map:get).

import type { AgentId, CliId, TEAM_AGENT_IDS } from '../agent_runtime.ts';
import type * as packageTypes from './packages.ts';
import type { InterfaceModule, RequirementStep } from './requirements.ts';

export type ActivityAgent = (typeof TEAM_AGENT_IDS)[number];

export type ActivityEvent =
  | {
      kind: 'package_transition';
      packageId: string;
      title: string;
      transition: packageTypes.HumanTransition | packageTypes.AgentTransition | packageTypes.CodingTransition;
      actor: 'human' | 'agent' | 'coding-agent';
      from: packageTypes.WorkPackageStatus;
      to: packageTypes.WorkPackageStatus;
    }
  | { kind: 'coding_run'; packageId: string; title: string; status: 'started' | 'finished' | 'failed' | 'cancelled'; costUsd: number | null }
  | { kind: 'requirement_created'; requirementId: string; title: string }
  | { kind: 'requirement_finished'; requirementId: string; title: string; step: RequirementStep; costUsd: number | null }
  | { kind: 'requirement_failed'; requirementId: string; title: string; step: RequirementStep; code: string }
  | { kind: 'requirement_published'; requirementId: string; title: string; packageCount: number }
  | { kind: 'release_finished'; version: string; packageCount: number };

export type ActivityRecord = ActivityEvent & { at: string };

export type QueueMetrics = { doneThisWeek: number; donePreviousWeek: number; averageHours: number | null; averageHoursPrevious: number | null };

// What an agent is running right now. `label` is the requirement or package
// title; null for a run with no subject of its own (a release draft), which
// the renderer names by kind.
export type AgentWork = { agent: ActivityAgent; kind: 'requirement' | 'review' | 'adjudication' | 'release' | 'coding'; label: string | null };

// Which agents are busy right now; availability is tracked per runtime.
export type TeamStatus = { available: boolean; availableByAgent: Record<ActivityAgent, boolean>; busy: ActivityAgent[]; work: AgentWork[] };

// Model spend per agent over the metrics week. Spend is recorded from
// 2026-10-07; `since` is the earliest recorded run in the retention window
// (null if none), so a week that starts before it is only partly counted.
export type AgentCosts = { byAgent: Record<ActivityAgent, number>; since: string | null; partial: boolean };
// ========== model usage ==========

// Token counts one model call reported, normalized across CLIs. `input`
// excludes cache reads and writes; reasoning is already inside `output`.
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
// What one call ran on, as far as the CLI said. Unknown parts are null.
export type ModelCall = { cli: CliId; provider: string | null; model: string | null; costUsd: number | null; tokens: TokenUsage | null };
// The work a call was for.
export type CostSubject = { kind: 'package' | 'requirement'; id: string } | null;

// Spend of a group of calls. `actualUsd` the CLIs reported; `estimatedUsd`
// is tokens × models.dev price; `unknownCalls` have neither. Of those,
// `unpricedCalls` have tokens, so a price sync may estimate them.
export type CostBucket = {
  calls: number;
  actualUsd: number;
  estimatedUsd: number;
  unknownCalls: number;
  unpricedCalls: number;
  tokens: TokenUsage;
};
export type CostRange = 7 | 30 | 90;
// Subjects exist only for days still within the 30-day raw window.
export type CostReport = {
  days: CostRange;
  timeZone: string;
  total: CostBucket;
  byAgent: (CostBucket & { agent: AgentId })[];
  byDay: (CostBucket & { day: string })[];
  byModel: (CostBucket & { cli: CliId | null; provider: string | null; model: string | null })[];
  bySubject: (CostBucket & { kind: 'package' | 'requirement'; id: string; title: string })[];
  // Days before this come from the yearly rollup (no subjects); null if none.
  rollupBefore: string | null;
  prices: { syncedAt: string } | null;
};

// `teamRecent`: each agent's newest few events over the retention window, newest first.
export type ActivityOverview = {
  recent: ActivityRecord[];
  metrics: QueueMetrics;
  team: TeamStatus;
  costs: AgentCosts;
  teamRecent: Record<ActivityAgent, ActivityRecord[]>;
  timeZone: string;
};

// Business days newest first; pass `nextBefore` back for the next page, null at the end.
export type ActivityPage = { days: { day: string; records: ActivityRecord[] }[]; nextBefore: string | null; timeZone: string; retentionDays: number };
// ========== engineering map ==========

export type MapSource = { requirementId: string; title: string; at: string };

// current: the file is unchanged since Architect read it; stale: it changed;
// removed: no longer tracked; unknown: no workspace or no recorded blob.
export type MapFreshness = 'current' | 'stale' | 'removed' | 'unknown';

export type MapModule = InterfaceModule & { source: MapSource; freshness: MapFreshness };

export type MapNote = { text: string; source: MapSource };

export type EngineeringMap = { modules: MapModule[]; conventions: MapNote[]; gaps: MapNote[]; files: string[]; truncated: boolean };
