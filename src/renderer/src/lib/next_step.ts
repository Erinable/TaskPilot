// "What should I do now?" for a work package: one sentence of advice and the
// action that matches it. The execution page shows that action as the main
// button and folds the rest under "more", so a beginner is never left to
// choose among ten buttons.
import type * as packageTypes from '@shared/ipc/packages.ts';

export type NextStep = {
  // Plain words, addressed to the developer.
  text: string;
  // The transition the advice points at, when it is a button.
  action: packageTypes.HumanTransition | null;
  // The advice is to hand the package to the Coding Agent.
  coding?: boolean;
  // The advice is to install the project's dependencies (环境初始化).
  setup?: boolean;
  // When the AI work the advice waits on started, for an elapsed-time clock.
  since?: string | null;
};

// While a Coding Agent run exists, its state decides the advice.
const codingAdvice = (task: packageTypes.TaskView): NextStep | null => {
  const run = task.codingRun;
  if (!run) return null;
  if (['preparing', 'running', 'checking'].includes(run.status))
    return { text: `Coding Agent 正在写第 ${run.attempt} 轮代码。可以先去做别的事，完成后会通知你。`, action: null, since: run.startedAt };
  if (['applying', 'verifying'].includes(run.status))
    return { text: '改动已写入项目，正在自动跑提交前检查。通过后会直接交给 QA 审查。', action: null, since: run.startedAt };
  if (run.status === 'ready' && run.halt === 'timed_out')
    return { text: '这一轮超时停下了，下面是它写好的部分，可能没写完。逐个文件看过再决定是否应用。', action: null };
  if (run.status === 'ready' && (run.trigger === 'human' || run.halt))
    return { text: 'Coding Agent 写好了。在下面逐个文件看一遍改动，勾选要保留的，再点「应用」。', action: null };
  if (run.status === 'ready') return { text: '正在自动应用这一轮的改动。', action: null, since: run.startedAt };
  if (run.status === 'applied' && run.halt === 'setup_required')
    return { text: '基础设施配置已应用。先到「环境初始化」安装本机依赖，再回到这里点「依赖已安装，继续检查」；通过后会交给 QA。', action: null, setup: true };
  if (run.status === 'applied' && run.halt)
    return { text: '自动流程停下了，改动已在项目里。可以自己改完后提交审查，或在下面补充说明让 Coding Agent 再试。', action: 'submit_for_review' };
  return null;
};

const pendingAdvice = (task: packageTypes.TaskView): NextStep => {
  const blocking = (task.dependencies ?? []).filter((dependency) => dependency.blocking);
  if (blocking.length)
    return {
      text: `要先等「${blocking.map((dependency) => dependency.title ?? dependency.id).join('」「')}」完成，这个包会用到它写的代码。确实想先做，可以在下面解除依赖。`,
      action: null,
    };
  return { text: '读一遍下面的步骤和验收条件，准备好了就开始。开始后 TaskPilot 会记下项目当前的样子，用来对比你的改动。', action: 'claim' };
};

// Coding Agent installs dependencies in its own copy of the project, never
// here, so after a skeleton the developer still installs them once.
const installAdvice = (missing: string[]) =>
  missing.length ? `这台电脑上的项目还没装依赖（没有 ${missing.join('、')}），先到「环境初始化」安装，之后的检查和审查才能跑测试。` : null;

const doneAdvice = (unsavedFiles: number | null, missingDependencies: string[]): NextStep => {
  const install = installAdvice(missingDependencies);
  if (unsavedFiles)
    return {
      text: `验收通过了，还差一步：在「保存到 git」里提交这 ${unsavedFiles} 个文件，下一个工作包才能从干净的状态开始。${install ? `然后${install}` : ''}`,
      action: null,
    };
  if (install) return { text: install, action: null, setup: true };
  return { text: '这个工作包已交付，可以去领下一个了。', action: null };
};

const inProgressAdvice = (task: packageTypes.TaskView): NextStep => {
  const total = task.steps.length;
  const done = task.completedSteps.length;
  const coding = codingAdvice(task);
  if (coding) return coding;
  if (done < total && task.mode === 'practice')
    return { text: `照着「执行指令」自己写，做完一步勾一步（${done} / ${total}）。卡住了点步骤下的「这一步怎么做？」问 Tutor。`, action: null };
  if (done < total && task.mode === 'ai') return { text: '把下面的说明交给 Coding Agent，它写完后你逐个文件看改动。', action: null, coding: true };
  if (done < total && task.mode === 'self')
    return { text: `照着「执行指令」一步步改，做完一步勾一步（${done} / ${total}）。卡住了可以问 Tutor，或者改为交给 Coding Agent。`, action: null };
  if (done < total)
    return {
      text: `交给 Coding Agent 照着步骤写，或者自己照着「执行指令」一步步改，做完一步勾一步（${done} / ${total}）。`,
      action: null,
      coding: true,
    };
  return { text: '步骤都勾完了。可以先在「验证」里跑一下测试，再提交给 QA 审查。', action: 'submit_for_review' };
};

// unsavedFiles: scope files still uncommitted once the package is done, from
// the commit preview; null until it has loaded.
// missingDependencies: the project's dependency folders this checkout lacks.
export const nextStep = (task: packageTypes.TaskView, unsavedFiles: number | null = null, missingDependencies: string[] = []): NextStep => {
  switch (task.status) {
    case 'pending':
      return pendingAdvice(task);
    case 'in_progress':
      return inProgressAdvice(task);
    case 'in_review':
      return {
        text: task.mode === 'practice' ? 'QA Partner 正在检查改动。检查完导师会判卷，参考答案也会解锁。' : 'QA Partner 正在检查改动，完成后这里会显示结果。',
        action: null,
        since: task.review?.startedAt ?? null,
      };
    case 'deviation':
      return { text: 'Architect 正在判断是改计划还是按原计划做，完成后会自动更新。', action: null, since: task.adjudication?.startedAt ?? null };
    case 'accepting':
      return { text: 'QA 审查已通过。请在下方实际检查并勾选需要你确认的事项，再点「确认并验收」；发现问题可打回修改。', action: 'accepted' };
    case 'done':
      return doneAdvice(unsavedFiles, missingDependencies);
    case 'blocked':
      return { text: '这个工作包被标记为阻塞。阻塞的原因解决后，点「解除阻塞」继续。', action: 'unblock' };
    default:
      return { text: '', action: null };
  }
};
