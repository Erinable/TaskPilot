// Who writes a package's code, as the claim dialog and the execution page
// show it. Product Lead recommends practice or ai; self is the developer's
// own choice and the reading for packages claimed before modes existed.
import type * as packageTypes from '@shared/ipc/packages.ts';

export type ModeOption = { mode: packageTypes.ExecutionMode; label: string; detail: string };

export const MODE_OPTIONS: ModeOption[] = [
  { mode: 'practice', label: '自己练习', detail: '你来写这部分代码练手，Coding Agent 不参与。写不出来时可以问 Tutor。' },
  { mode: 'ai', label: '交给 AI', detail: 'Coding Agent 照着步骤写，你逐个文件看改动，再交给 QA 审查。' },
  { mode: 'self', label: '自己写，需要时找 AI', detail: '你来写，卡住时也可以把剩下的交给 Coding Agent。' },
];

export const modeLabel = (mode: packageTypes.ExecutionMode | null): string => MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? '自己写';

// What the claim dialog preselects: the plan's recommendation, else self.
export const defaultMode = (task: Pick<packageTypes.TaskView, 'recommendedMode'>): packageTypes.ExecutionMode => task.recommendedMode?.mode ?? 'self';
