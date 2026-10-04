// Static sample work packages. This module is the single source of truth for
// task data until real integrations (GitHub, model services) replace it.
// Inline code in `steps` is marked with backticks and rendered as <code>.
const { isStatus } = require('./work-package-status');
const { isInside } = require('./workspace');

const PRIORITIES = ['high', 'medium', 'low'];

const tasks = [
  {
    id: 'auth-email-login',
    // Definitions can only carry pre-claim statuses: `in_progress` and later
    // require a baseline commit, which is per-machine and recorded by the
    // store when the human claims the package.
    status: 'pending',
    title: '实现邮箱登录接口',
    description: '将需求转化为可执行的 LoginUserUseCase',
    intro: 'Product Lead 和 Architect 已完成设计。请按工作包执行代码，遇到偏差时暂停并反馈。',
    module: 'auth',
    tags: ['auth', 'backend'],
    priority: 'high',
    estimate: '预计 2 小时',
    icon: 'key',
    steps: [
      '在 `src/auth/application/login-user.ts` 创建 `LoginUserUseCase`。',
      '调用 `UserRepository.findByEmail()` 并校验密码。',
      '成功后使用 `TokenService.issue()` 生成 token。',
      '为成功、用户不存在和密码错误分别添加测试。',
    ],
    fileScope: ['src/auth/application/login-user.ts', 'tests/auth/login-user.test.ts'],
    acceptance: [
      { text: '成功返回 token，不暴露用户是否存在', test: 'login succeeds with valid credentials' },
      { text: '用户不存在和密码错误返回相同的错误', test: 'login failures are indistinguishable' },
      { text: '所有 auth 测试通过，lint 无错误' },
    ],
  },
  {
    id: 'auth-edge-tests',
    status: 'pending',
    title: '补充登录模块边界测试',
    description: 'QA Partner 标记了 2 个未覆盖的边界条件',
    intro: 'QA Partner 完成了测试分析，以下边界条件尚未被覆盖。',
    module: 'auth',
    tags: ['testing', 'auth'],
    priority: 'medium',
    estimate: '预计 1 小时',
    icon: 'flask',
    steps: [
      '在 `tests/auth/login-user.test.ts` 添加邮箱大小写不敏感的用例。',
      '添加连续失败 5 次后账号被临时锁定的用例。',
      '确认两个用例在修复前失败、修复后通过。',
    ],
    fileScope: ['tests/auth/login-user.test.ts'],
    acceptance: [
      { text: '邮箱大小写不敏感', test: 'login is case-insensitive for the email' },
      { text: '连续失败 5 次后账号被临时锁定', test: 'account locks after five failed attempts' },
    ],
  },
  {
    id: 'token-service-deps',
    status: 'pending',
    title: '重构 TokenService 依赖',
    description: '按照 ADR-014 调整 infrastructure 层依赖方向',
    intro: 'Architect 在 ADR-014 中决定将 TokenService 移入 auth/infrastructure。',
    module: 'auth',
    tags: ['architecture'],
    priority: 'medium',
    estimate: '预计 3 小时',
    icon: 'blocks',
    steps: [
      '将 `TokenService` 实现移动到 `src/auth/infrastructure/token-service.ts`。',
      '在 `src/auth/application` 中只保留 `TokenIssuer` 接口。',
      '更新依赖注入配置，确保 application 层不再引用 infrastructure。',
    ],
    fileScope: [
      'src/auth/application/token-issuer.ts',
      'src/auth/infrastructure/token-service.ts',
      'src/container.ts',
    ],
    acceptance: [
      { text: 'application 层没有指向 infrastructure 的 import' },
      { text: '现有 auth 测试全部通过', test: 'auth module test suite' },
    ],
  },
  {
    id: 'release-v0-9-0',
    status: 'clarifying',
    title: '准备 v0.9.0 发布清单',
    description: '检查迁移、监控和回滚步骤是否完整',
    intro: 'Release Manager 需要你确认发布清单中的工程步骤。',
    module: 'release',
    tags: ['release'],
    priority: 'low',
    estimate: '预计 30 分钟',
    icon: 'rocket',
    steps: [
      '核对 `migrations/` 中的新迁移都有对应的回滚脚本。',
      '确认登录接口的监控告警已配置。',
      '在发布清单中补充回滚步骤。',
    ],
    fileScope: ['docs/release/v0.9.0.md'],
    acceptance: [
      { text: '迁移、监控、回滚三项均已勾选' },
      { text: 'Release Manager 确认清单完整' },
    ],
  },
];

function listTasks() {
  // Return a copy so callers can't mutate the shared sample data.
  return structuredClone(tasks);
}

function getTask(id) {
  const task = tasks.find((candidate) => candidate.id === id);
  return task ? structuredClone(task) : null;
}

/**
 * Compares changed paths against a work package's file scope.
 * Paths outside the scope are not an error — they are a signal that the
 * breakdown was wrong, so the UI surfaces them for the human to judge.
 */
function checkFileScope(task, changedPaths) {
  const scope = task.fileScope ?? [];
  const inScope = [];
  const outOfScope = [];
  for (const changed of changedPaths) {
    (scope.includes(changed) ? inScope : outOfScope).push(changed);
  }
  return {
    inScope,
    outOfScope,
    untouched: scope.filter((p) => !changedPaths.includes(p)),
  };
}

/** Rejects a scope entry that would reach outside the workspace root. */
function scopeEscapesRoot(root, task) {
  return (task.fileScope ?? []).filter((candidate) => !isInside(root, candidate));
}

module.exports = { PRIORITIES, isStatus, listTasks, getTask, checkFileScope, scopeEscapesRoot };
