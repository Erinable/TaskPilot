// Wording for the activity feed, the queue metrics and team presence.
import type * as ipc from '@shared/ipc_types.ts';
import { businessDay, previousDay } from './time_zone.ts';

export type FeedActor = { avatar: 'pm' | 'arch' | 'qa' | 'rel' | 'code' | 'you'; initials: string; name: string };

export type FeedItem = { key: string; actor: FeedActor; what: string; detail: string; at: string };

const AGENTS: Record<ipc.ActivityAgent, FeedActor> = {
  'product-lead': { avatar: 'pm', initials: 'PM', name: 'Product Lead' },
  architect: { avatar: 'arch', initials: 'AR', name: 'Architect' },
  qa: { avatar: 'qa', initials: 'QA', name: 'QA Partner' },
  'release-manager': { avatar: 'rel', initials: 'RM', name: 'Release Manager' },
  'coding-agent': { avatar: 'code', initials: 'CA', name: 'Coding Agent' },
};
const YOU: FeedActor = { avatar: 'you', initials: '你', name: '你' };

export const TEAM: { agent: ipc.ActivityAgent; actor: FeedActor }[] = (['product-lead', 'architect', 'qa', 'release-manager', 'coding-agent'] as const).map(
  (agent) => ({
    agent,
    actor: AGENTS[agent],
  }),
);

// What a transition reads as, and who did it.
const TRANSITION_TEXT: Record<ipc.HumanTransition | ipc.AgentTransition | ipc.CodingTransition, { by: FeedActor; what: string }> = {
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
  coding_submitted: { by: AGENTS['coding-agent'], what: '检查通过，提交了审查' },
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
    case 'coding_run':
      return {
        key,
        actor: AGENTS['coding-agent'],
        what: record.status === 'started' ? '开始编码' : record.status === 'finished' ? '完成编码' : record.status === 'cancelled' ? '取消编码' : '编码失败',
        detail: record.title,
        at: record.at,
      };
    case 'requirement_created':
      return { key, actor: YOU, what: '提交了需求', detail: record.title, at: record.at };
    case 'requirement_finished':
      return { key, actor: AGENTS['product-lead'], what: STEP_TEXT[record.step], detail: record.title, at: record.at };
    case 'requirement_failed':
      return { key, actor: AGENTS['product-lead'], what: record.step === 'clarifying' ? '澄清没有完成' : '拆解没有完成', detail: record.title, at: record.at };
    case 'requirement_published':
      return { key, actor: YOU, what: `发布了 ${record.packageCount} 个工作包`, detail: record.title, at: record.at };
    case 'release_finished':
      return {
        key,
        actor: AGENTS['release-manager'],
        what: `完成了版本 ${record.version} 的发布准备`,
        detail: `包含 ${record.packageCount} 个工作包`,
        at: record.at,
      };
  }
};

// "刚刚 / 8 分钟前 / 3 小时前 / 昨天 / 10-02" relative to `now`, with calendar
// days in the business time zone.
export const relativeTime = (at: string, now: Date, timeZone: string) => {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const today = businessDay(now, timeZone);
  const then = businessDay(new Date(at), timeZone);
  if (then === today) return `${Math.floor(minutes / 60)} 小时前`;
  if (then === previousDay(today)) return '昨天';
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
  if (!team || !team.available || !team.availableByAgent[agent]) return 'offline';
  return team.busy.includes(agent) ? 'busy' : 'online';
};

export const PRESENCE_LABELS: Record<Presence, string> = { online: '在线', busy: '工作中', offline: '暂时离线' };

export const presenceSummary = (team: ipc.TeamStatus | null) => {
  if (!team) return '';
  if (!team.available) return 'AI 团队离线';
  const availableCount = Object.values(team.availableByAgent).filter(Boolean).length;
  if (availableCount === 0) return 'AI 团队离线';
  return team.busy.length ? `${team.busy.length} 个 AI 成员正在工作` : `${availableCount} 个 AI 成员在线`;
};

// What each member does, in plain words for people new to the workflow.
export const ROLES: Record<ipc.ActivityAgent, string> = {
  'product-lead': '把你的需求问清楚，再拆成一个个能直接动手的工作包。',
  architect: '先读相关代码，告诉团队接口长什么样；你发现计划和代码对不上时，由它决定怎么改。',
  qa: '你提交工作包后检查代码和测试，确认验收条件都做到了。',
  'release-manager': '根据最近的提交和完成的工作包，起草版本号、更新说明和发布清单。',
  'coding-agent': '在隔离运行目录里执行编码工作，产出变更供你审查和应用。',
};
const WORK_TEXT: Record<ipc.AgentWork['kind'], string> = {
  requirement: '正在处理需求',
  review: '正在审查工作包',
  adjudication: '正在裁决偏差',
  release: '正在起草',
  coding: '正在编码工作包',
};

// "正在审查工作包「登录接口」"; null when the member is not running anything.
export const workText = (team: ipc.TeamStatus | null, agent: ipc.ActivityAgent) => {
  const work = team?.work.find((item) => item.agent === agent);
  return work ? `${WORK_TEXT[work.kind]}「${work.label}」` : null;
};

// "$0.123", or "$0.00" for nothing spent; tiny amounts keep three decimals.
export const formatCost = (costUsd: number) => (costUsd === 0 ? '$0.00' : `$${costUsd.toFixed(costUsd < 1 ? 3 : 2)}`);
