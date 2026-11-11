import type { EnvConfiguration } from '../../../src/shared/ipc/environment.ts';

export const ENV_CONFIGURATION: EnvConfiguration = {
  title: '补齐 TypeScript 检查配置',
  reason: '仓库已有测试，但缺少类型检查和格式检查。',
  checks: [
    { kind: 'typecheck', script: 'typecheck', reason: '编译前发现类型错误' },
    { kind: 'format', script: 'format:check', reason: '检查配置和源码格式，不修改文件' },
  ],
  fileScope: ['package.json', 'package-lock.json', 'taskpilot.toml', '.prettierrc.json', '.prettierignore'],
  steps: [
    '保留现有脚本，补齐 TypeScript 的 `typecheck` 和 Prettier 的 `format:check` 脚本及开发依赖，更新 npm 锁文件。',
    '添加适合项目的 Prettier 配置和忽略规则。',
    '在 `taskpilot.toml` 中把新增脚本接为提交前检查，保留已有检查，并运行验证。',
  ],
  acceptance: ['新增脚本可以运行且不改写源码。', 'TaskPilot 能识别类型检查和格式检查，原来的测试仍能运行。'],
};
