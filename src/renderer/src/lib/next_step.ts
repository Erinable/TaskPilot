// "What should I do now?" for a work package: one sentence of advice and the
// action that matches it. The execution page shows that action as the main
// button and folds the rest under "more", so a beginner is never left to
// choose among ten buttons.
import type * as ipc from '@shared/ipc_types.ts';

export type NextStep = {
  // Plain words, addressed to the developer.
  text: string;
  // The transition the advice points at, when it is a button.
  action: ipc.HumanTransition | null;
};

export const nextStep = (task: ipc.TaskView): NextStep => {
  const total = task.steps.length;
  const done = task.completedSteps.length;
  switch (task.status) {
    case 'pending': {
      const blocking = (task.dependencies ?? []).filter((dependency) => dependency.blocking);
      if (blocking.length)
        return {
          text: `要先等「${blocking.map((dependency) => dependency.title ?? dependency.id).join('」「')}」完成，这个包会用到它写的代码。确实想先做，可以在下面解除依赖。`,
          action: null,
        };
      return { text: '读一遍下面的步骤和验收条件，准备好了就开始。开始后 TaskPilot 会记下项目当前的样子，用来对比你的改动。', action: 'claim' };
    }
    case 'in_progress':
      if (done < total)
        return {
          text: `照着「执行指令」一步步改代码，做完一步勾一步（${done} / ${total}）。不会做时点步骤下面的「这一步怎么做？」。`,
          action: null,
        };
      return { text: '步骤都勾完了。可以先在「验证」里跑一下测试，再提交给 QA 审查。', action: 'submit_for_review' };
    case 'in_review':
      return { text: 'QA Partner 正在检查你的改动，通常一两分钟。完成后这里会显示结果。', action: null };
    case 'deviation':
      return { text: 'Architect 正在判断是改计划还是按原计划做，完成后会自动更新。', action: null };
    case 'accepting':
      return { text: 'QA 检查通过了，还有几项需要你亲自确认。看完「QA 审查」里的确认项，没问题就验收。', action: 'accepted' };
    case 'done':
      return { text: '这个工作包完成了。在下面的「保存到 git」里提交改动，再去领下一个。', action: null };
    case 'blocked':
      return { text: '这个工作包被标记为阻塞。阻塞的原因解决后，点「解除阻塞」继续。', action: 'unblock' };
    default:
      return { text: '', action: null };
  }
};
