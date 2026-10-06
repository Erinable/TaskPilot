// Wording for the activity feed, the queue metrics and team presence.
import type * as ipc from '@shared/ipc_types.ts';

export type FeedActor = { avatar: 'pm' | 'arch' | 'qa' | 'you'; initials: string; name: string };

export type FeedItem = { key: string; actor: FeedActor; what: string; detail: string; at: string };

const AGENTS: Record<ipc.ActivityAgent, FeedActor> = {
  'product-lead': { avatar: 'pm', initials: 'PM', name: 'Product Lead' },
  architect: { avatar: 'arch', initials: 'AR', name: 'Architect' },
  qa: { avatar: 'qa', initials: 'QA', name: 'QA Partner' },
};
const YOU: FeedActor = { avatar: 'you', initials: '你', name: '你' };

export const TEAM: { agent: ipc.ActivityAgent; actor: FeedActor }[] = (['product-lead', 'architect', 'qa'] as const)
  .map((agent) => ({ agent, actor: AGENTS[agent] }));

// What a transition reads as, and who did it.
const TRANSITION_TEXT: Record<ipc.HumanTransition | ipc.AgentTransition, { by: FeedActor; what: string }> = {
  breakdown_done: { by: AGENTS['product-lead'], what: '拆解完成了工作包' },
  claim: { by: YOU, what: '开始执行' },
  release: { by: YOU, what: '把工作包放回了队列' },
  submit_for_review: { by: YOU, what: '提交了审查' },
  report_deviation: { by: YOU, what: '报告了偏差' },
  override_dismissal: { by: YOU, what: '不同意驳回，要求重新规划' },
  revert_replan: { by: YOU, what: '撤销了重新规划' },
  block: { by: YOU, what: '标记了阻塞' },
  unblock: { by: YOU, what: '解除了阻塞' },
  accepted: { by: YOU, what: '验收通过' },
  acceptance_rejected: { by: YOU, what: '打回修改' },
  review_accepted: { by: AGENTS.qa, what: '审查通过，工作包已完成' },
  review_passed: { by: AGENTS.qa, what: '审查通过，等你验收' },
  review_rejected: { by: AGENTS.qa, what: '审查未通过，退回修改' },
  replanned: { by: AGENTS.architect, what: '重新规划了工作包' },
  deviation_dismissed: { by: AGENTS.architect, what: '驳回了偏差，按原计划继续' },
};

const STEP_TEXT: Record<ipc.RequirementStep, string> = { clarifying: '提出了澄清问题', planning: '拆解出了工作包' };

export const toFeedItem = (record: ipc.ActivityRecord, index: number): FeedItem => {
  const key = `${record.at}-${index}`;
  switch (record.kind) {
    case 'package_transition': {
      const text = TRANSITION_TEXT[record.transition];
      return { key, actor: text.by, what: text.what, detail: record.title, at: record.at };
    }
    case 'requirement_created':
      return { key, actor: YOU, what: '提交了需求', detail: record.title, at: record.at };
    case 'requirement_finished':
      return { key, actor: AGENTS['product-lead'], what: STEP_TEXT[record.step], detail: record.title, at: record.at };
    case 'requirement_failed':
      return { key, actor: AGENTS['product-lead'], what: record.step === 'clarifying' ? '澄清没有完成' : '拆解没有完成', detail: record.title, at: record.at };
    case 'requirement_published':
      return { key, actor: YOU, what: `发布了 ${record.packageCount} 个工作包`, detail: record.title, at: record.at };
  }
};

// "刚刚 / 8 分钟前 / 3 小时前 / 昨天 / 10-02" relative to `now`, with calendar
// days in the business time zone.
export const relativeTime = (at: string, now: Date, timeZone: string) => {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const today = day(now);
  const then = day(new Date(at));
  if (then === today) return `${Math.floor(minutes / 60)} 小时前`;
  if (then === day(new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 60 * 60 * 1000))) return '昨天';
  return then.slice(5);
};

export type Trend = { text: string; tone: 'up' | 'down' | 'neutral' };

// Done count this week, against last week.
export const doneTrend = ({ doneThisWeek, donePreviousWeek }: ipc.QueueMetrics): Trend => {
  if (donePreviousWeek === 0) return doneThisWeek ? { text: '上周没有', tone: 'up' } : { text: '本周暂无', tone: 'neutral' };
  const change = Math.round(((doneThisWeek - donePreviousWeek) / donePreviousWeek) * 100);
  if (change === 0) return { text: '与上周持平', tone: 'neutral' };
  return { text: `${change > 0 ? '+' : ''}${change}%`, tone: change > 0 ? 'up' : 'down' };
};

// Hours with one decimal under 10h, whole hours above.
export const formatHours = (hours: number | null) => (hours === null ? '–' : hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`);

// Shorter is better here, so a drop of more than 10% reads as an improvement.
export const durationTrend = ({ averageHours, averageHoursPrevious }: ipc.QueueMetrics): Trend => {
  if (averageHours === null || averageHoursPrevious === null || averageHoursPrevious === 0) return { text: '数据不足', tone: 'neutral' };
  const change = (averageHours - averageHoursPrevious) / averageHoursPrevious;
  if (Math.abs(change) <= 0.1) return { text: '较上周稳定', tone: 'neutral' };
  return { text: `较上周${change < 0 ? '缩短' : '变长'} ${Math.round(Math.abs(change) * 100)}%`, tone: change < 0 ? 'up' : 'down' };
};

export type Presence = 'online' | 'busy' | 'offline';

export const presenceOf = (team: ipc.TeamStatus | null, agent: ipc.ActivityAgent): Presence => {
  if (!team?.available) return 'offline';
  return team.busy.includes(agent) ? 'busy' : 'online';
};

export const PRESENCE_LABELS: Record<Presence, string> = { online: '在线', busy: '工作中', offline: '离线：找不到 Claude Code CLI' };

export const presenceSummary = (team: ipc.TeamStatus | null) => {
  if (!team) return '';
  if (!team.available) return 'AI 团队离线';
  return team.busy.length ? `${team.busy.length} 个 AI 成员正在工作` : `${TEAM.length} 个 AI 成员在线`;
};
