// What the activity overview shows, kept in memory: the feed's newest events,
// the queue's metrics, each team member's newest events and the week's spend.
// ActivityLog builds one from the retention window and adds every append to
// it, so the overview's poll never reads the day files.
//
// Entries keep their business day and are judged against the window when
// read, so a summary built yesterday answers like one built today. Entries
// whose day has left the window are dropped then, which keeps memory bounded
// by the window however long the app runs.
import type * as activityTypes from '../shared/ipc/activity.ts';
import type { AgentTransition, CodingTransition } from '../shared/ipc/packages.ts';
import { addCall, emptyTokens, keyOf } from './cost_rollup.ts';
import type { CostRow } from './cost_rollup.ts';
import type { AgentCostEvent, LoggedRecord } from './activity_log.ts';

const METRIC_DAYS = 7;
const FEED_COUNT = 20;
const TEAM_RECENT_COUNT = 3;

// A day's spend for one agent and model, with the earliest priced and the
// earliest token-only call, for the week's `since`.
type SpendRow = CostRow & { firstActualAt: string | null; firstTokensAt: string | null };
// A package that reached done, with the claim it was measured from, if any.
type Done = { day: string; at: number; claim: { at: number; day: string } | null };

export type OverviewSummary = {
  recent: activityTypes.ActivityRecord[];
  metrics: activityTypes.QueueMetrics;
  costs: activityTypes.AgentCosts;
  teamRecent: Record<activityTypes.ActivityAgent, activityTypes.ActivityRecord[]>;
};
// Prices the token-only calls of one spend row, in micro-dollars, or null.
export type EstimateRow = (row: CostRow) => number | null;

const emptyByAgent = <Value>(make: () => Value): Record<activityTypes.ActivityAgent, Value> => ({
  'product-lead': make(),
  architect: make(),
  qa: make(),
  'release-manager': make(),
  'coding-agent': make(),
});

// Which agent makes each agent transition; human transitions have none.
const TRANSITION_AGENTS: Record<AgentTransition | CodingTransition, activityTypes.ActivityAgent> = {
  breakdown_done: 'product-lead',
  review_accepted: 'qa',
  review_passed: 'qa',
  review_rejected: 'qa',
  replanned: 'architect',
  deviation_dismissed: 'architect',
  coding_submitted: 'coding-agent',
};

// The team member a feed event belongs to, or null for the human's own.
// Matches the actor the renderer's feed shows for the same event.
export const agentOf = (record: activityTypes.ActivityRecord): activityTypes.ActivityAgent | null => {
  switch (record.kind) {
    case 'package_transition':
      // A hand-edited line could name "toString"; only own keys count.
      return Object.hasOwn(TRANSITION_AGENTS, record.transition) ? TRANSITION_AGENTS[record.transition as AgentTransition | CodingTransition] : null;
    case 'coding_run':
      return 'coding-agent';
    case 'requirement_finished':
    case 'requirement_failed':
      return 'product-lead';
    case 'release_finished':
      return 'release-manager';
    case 'requirement_created':
    case 'requirement_published':
      return null;
  }
};

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

export class ActivitySummary {
  #dayOf: (at: string) => string;
  // Each package's latest claim not yet released.
  #claims = new Map<string, { at: number; day: string }>();
  #done: Done[] = [];
  #spend = new Map<string, SpendRow>();
  // Newest first.
  #feed: activityTypes.ActivityRecord[] = [];
  #teamRecent = emptyByAgent<activityTypes.ActivityRecord[]>(() => []);

  // `dayOf` gives an event time's business day.
  constructor(dayOf: (at: string) => string) {
    this.#dayOf = dayOf;
  }

  // Records must arrive oldest first, as they were appended.
  add(record: LoggedRecord): void {
    if (record.kind === 'agent_cost') return this.#addCost(record);
    this.#feed.unshift(record);
    if (this.#feed.length > FEED_COUNT) this.#feed.pop();
    const agent = agentOf(record);
    if (agent) {
      const recent = this.#teamRecent[agent];
      recent.unshift(record);
      if (recent.length > TEAM_RECENT_COUNT) recent.pop();
    }
    if (record.kind !== 'package_transition') return;
    if (record.transition === 'claim') this.#claims.set(record.packageId, { at: Date.parse(record.at), day: this.#dayOf(record.at) });
    if (record.transition === 'release') this.#claims.delete(record.packageId);
    if (record.to === 'done') this.#done.push({ day: this.#dayOf(record.at), at: Date.parse(record.at), claim: this.#claims.get(record.packageId) ?? null });
  }

  // `window` is the retention window's business days, newest first.
  read(window: string[], estimate: EstimateRow = () => null): OverviewSummary {
    const oldest = window.at(-1) as string;
    this.#evict(oldest, window[METRIC_DAYS * 2 - 1]);
    const inWindow = (record: activityTypes.ActivityRecord) => this.#dayOf(record.at) >= oldest;
    return {
      recent: this.#feed.filter(inWindow),
      metrics: this.#metrics(window, oldest),
      costs: this.#costs(window, estimate),
      teamRecent: Object.fromEntries(Object.entries(this.#teamRecent).map(([agent, records]) => [agent, records.filter(inWindow)])) as Record<
        activityTypes.ActivityAgent,
        activityTypes.ActivityRecord[]
      >,
    };
  }

  #addCost(record: AgentCostEvent & { at: string }): void {
    const call = record.call;
    const identity = { day: this.#dayOf(record.at), agent: record.agent, cli: call?.cli ?? null, provider: call?.provider ?? null, model: call?.model ?? null };
    const key = keyOf(identity);
    let row = this.#spend.get(key);
    if (!row) {
      row = { ...identity, actualCalls: 0, actualMicros: 0, tokenCalls: 0, tokens: emptyTokens(), unknownCalls: 0, firstActualAt: null, firstTokensAt: null };
      this.#spend.set(key, row);
    }
    const group = addCall(row, record);
    if (group === 'actual' && (row.firstActualAt === null || record.at < row.firstActualAt)) row.firstActualAt = record.at;
    if (group === 'tokens' && (row.firstTokensAt === null || record.at < row.firstTokensAt)) row.firstTokensAt = record.at;
  }

  // Claims and spend are kept for the whole window, finished packages only
  // for the two metric weeks.
  #evict(oldest: string, metricsOldest: string): void {
    for (const [packageId, claim] of this.#claims) if (claim.day < oldest) this.#claims.delete(packageId);
    for (const [key, row] of this.#spend) if (row.day < oldest) this.#spend.delete(key);
    this.#done = this.#done.filter((done) => done.day >= metricsOldest);
  }

  // A claim older than the window would not have been read from the files,
  // so it does not count towards an average.
  #metrics(window: string[], oldest: string): activityTypes.QueueMetrics {
    const thisWeek = new Set(window.slice(0, METRIC_DAYS));
    const previousWeek = new Set(window.slice(METRIC_DAYS, METRIC_DAYS * 2));
    const durations = { current: [] as number[], previous: [] as number[] };
    let doneThisWeek = 0;
    let donePreviousWeek = 0;
    for (const done of this.#done) {
      const bucket = thisWeek.has(done.day) ? 'current' : previousWeek.has(done.day) ? 'previous' : null;
      if (!bucket) continue;
      if (bucket === 'current') doneThisWeek += 1;
      else donePreviousWeek += 1;
      if (done.claim && done.claim.day >= oldest) durations[bucket].push((done.at - done.claim.at) / 3_600_000);
    }
    return { doneThisWeek, donePreviousWeek, averageHours: mean(durations.current), averageHoursPrevious: mean(durations.previous) };
  }

  // Each team member's spend over the metrics week, reported or estimated
  // (the same numbers as the cost page). Spend was not recorded before
  // 2026-10-07, so a week starting before the earliest recorded run is partial.
  #costs(window: string[], estimate: EstimateRow): activityTypes.AgentCosts {
    const thisWeek = new Set(window.slice(0, METRIC_DAYS));
    const micros = emptyByAgent(() => 0);
    // The earliest call with an amount, reported or estimated.
    const starts: string[] = [];
    for (const row of this.#spend.values()) {
      // A hand-edited or future line with an unknown agent is skipped, as are
      // agents outside the team page (Tutor, Environment Steward).
      if (!Object.hasOwn(micros, row.agent)) continue;
      const estimated = row.tokenCalls ? estimate(row) : null;
      if (row.actualCalls && row.firstActualAt !== null) starts.push(row.firstActualAt);
      if (estimated !== null && row.firstTokensAt !== null) starts.push(row.firstTokensAt);
      if (thisWeek.has(row.day)) micros[row.agent as activityTypes.ActivityAgent] += row.actualMicros + (estimated ?? 0);
    }
    const byAgent = Object.fromEntries(Object.entries(micros).map(([agent, value]) => [agent, value / 1_000_000])) as Record<
      activityTypes.ActivityAgent,
      number
    >;
    const since = starts.length ? starts.reduce((earliest, at) => (at < earliest ? at : earliest)) : null;
    return { byAgent, since, partial: since === null || this.#dayOf(since) > window[METRIC_DAYS - 1] };
  }
}
