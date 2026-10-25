// What a Coding Agent package is doing, as the app-wide indicator shows it,
// and what to tell the developer once the automatic flow stops. Pure, so the
// wording is tested without timers.
import { MAX_AUTO_ATTEMPTS } from '@shared/coding_types.ts';
import { describeErrorInfo } from './errors.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

export type CodingPhase = { label: string; since: string | null };

// The phase of a package the loop is still moving, or null once it waits for
// the developer or is over.
export const codingPhase = (task: packageTypes.TaskView): CodingPhase | null => {
  const run = task.codingRun;
  if (!run || run.halt) return null;
  if (['preparing', 'running', 'checking'].includes(run.status)) return { label: `第 ${run.attempt} 轮编码中`, since: run.startedAt };
  if (run.status === 'ready' && run.trigger !== 'human') return { label: '正在应用改动', since: run.startedAt };
  if (['applying', 'verifying'].includes(run.status)) return { label: '提交前检查中', since: run.startedAt };
  if (run.status === 'submitted' && (task.status === 'in_review' || task.review?.status === 'running'))
    return { label: 'QA 审查中', since: task.review?.startedAt ?? null };
  return null;
};

export type CodingOutcome = { text: string; tone: 'success' | 'error' | 'info'; qa: boolean };

// The one sentence for a package whose automatic flow just stopped. `qa`
// marks QA results, which the open execution page already announces.
export const codingOutcome = (task: packageTypes.TaskView): CodingOutcome | null => {
  const run = task.codingRun;
  if (!run) return null;
  const title = `「${task.title}」`;
  if (run.status === 'ready') {
    if (run.halt === 'timed_out') return { text: `${title}这一轮超时了，写好的部分等你检查。`, tone: 'info', qa: false };
    if (run.halt === 'high_risk') return { text: `${title}改到了高风险文件，等你确认。`, tone: 'info', qa: false };
    return { text: `Coding Agent 写好了${title}，等你逐个文件确认。`, tone: 'success', qa: false };
  }
  if (run.halt === 'attempts_exhausted') return { text: `${title}自动重试 ${MAX_AUTO_ATTEMPTS} 轮仍未通过，交给你处理。`, tone: 'error', qa: false };
  if (run.halt === 'no_changes') return { text: `${title}这一轮没有产生改动，自动流程已停止。`, tone: 'info', qa: false };
  if (run.status === 'failed') return { text: `${title}编码失败：${describeErrorInfo(run.error)}`, tone: 'error', qa: false };
  if (run.status !== 'submitted') return null;
  if (task.status === 'done') return { text: `${title}QA 审查通过，工作包已完成。`, tone: 'success', qa: true };
  if (task.status === 'accepting') return { text: `${title}QA 审查通过，等你验收。`, tone: 'success', qa: true };
  if (task.review?.status === 'failed') return { text: `${title}QA 审查失败：${describeErrorInfo(task.review.error)}`, tone: 'error', qa: true };
  return null;
};
