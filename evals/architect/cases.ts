// Architect eval cases, in two kinds:
//   summary      read a fixture repository for a requirement and publish the
//                interface summary Product Lead plans from
//   adjudicate   rule on a developer's deviation report: dismiss or replan
// Summary cases reuse Product Lead's requirements and fixture repositories.
import { cases as productCases } from '../product-lead/fixtures.ts';
import { PY_SERVICE, REACT_APP, TS_API } from '../product-lead/sources.ts';
import type { AdjudicationTask, DeviationRecord } from '../../src/main/agents/architect.ts';

export interface SummaryCase {
  kind: 'summary';
  id: string;
  note: string;
  requirement: { title: string; text: string };
  files: string[];
  sources: Record<string, string>;
  expect: {
    // Files a useful selection includes.
    mustRead: string[];
    // Terms only visible inside the code, at least two thirds must appear.
    grounding: string[];
  };
}

export interface AdjudicationCase {
  kind: 'adjudicate';
  id: string;
  note: string;
  sources: Record<string, string>;
  task: AdjudicationTask;
  deviations: DeviationRecord[];
  mustReplan?: boolean;
  expect: {
    decision: 'dismiss' | 'replan';
    // For a replan, files the new scope must include.
    scopeIncludes?: string[];
  };
}

export type ArchitectCase = SummaryCase | AdjudicationCase;

const fromProduct = (id: string, mustRead: string[], grounding: string[], note: string): SummaryCase => {
  const source = productCases.find((testCase) => testCase.id === id);
  if (!source) throw new Error(`No Product Lead case ${id}`);
  return {
    kind: 'summary',
    id: `summary-${id}`,
    note,
    requirement: source.requirement,
    files: source.files,
    sources: source.sources ?? {},
    expect: { mustRead, grounding },
  };
};

const FIND_BY_EMAIL: AdjudicationTask = {
  title: '给 UserRepository 加 findByEmail',
  description: '按邮箱查找用户，比较忽略大小写，找不到返回 null。',
  steps: ['在 UserRepository 加 async findByEmail(email): Promise<User | null>。', '补单元测试。'],
  fileScope: ['src/auth/user-repository.ts', 'tests/auth/user-repository.test.ts'],
  acceptance: [{ text: '找不到时返回 null', test: 'returns null for an unknown email' }],
};

const LOGIN: AdjudicationTask = {
  title: '登录接口',
  description: 'POST /login：校验邮箱和密码，成功返回 token，失败统一返回 401。',
  steps: [
    '在 src/http/router.ts 注册 POST /login。',
    '用 UserRepository.findByEmail 查用户，bcrypt.compare 校验密码。',
    '成功时用 TokenService.issue 签发 token。',
  ],
  fileScope: ['src/http/router.ts', 'src/auth/login.ts', 'tests/auth/login.test.ts'],
  acceptance: [{ text: '密码错误和用户不存在都返回 401', test: 'login failures return 401' }],
};

export const cases: ArchitectCase[] = [
  fromProduct(
    'clear-small',
    ['src/auth/user-repository.ts'],
    ['NotFoundError', 'COLUMNS', 'fakeDb'],
    'Small change; the summary should carry the error convention and the test helper.',
  ),
  fromProduct(
    'login-typical',
    ['src/auth/user-repository.ts', 'src/auth/token-service.ts', 'src/http/router.ts'],
    ['issue(', 'NotFoundError', 'route('],
    'Login touches three modules; each signature should be in the summary.',
  ),
  fromProduct(
    'frontend-only',
    ['src/pages/SettingsPage.tsx', 'src/components/Modal.tsx'],
    ['Modal', 'request', 'danger'],
    'React page; the Modal props and the Button variant matter.',
  ),
  fromProduct(
    'large',
    ['app/billing/invoices.py', 'app/notifications/email.py'],
    ['issue_invoice', 'send_email'],
    'Python service; the billing and email entry points.',
  ),
  {
    kind: 'adjudicate',
    id: 'dismiss-method-exists',
    note: 'The developer thinks findByEmail is missing a dependency, but the repository already has what it needs. Dismiss.',
    sources: TS_API,
    task: FIND_BY_EMAIL,
    deviations: [{ note: '步骤里说要查询数据库，但我不知道 UserRepository 怎么拿到数据库连接，是不是要先加一个数据库模块？', stepIndex: 0 }],
    expect: { decision: 'dismiss' },
  },
  {
    kind: 'adjudicate',
    id: 'replan-missing-method',
    note: 'The login plan calls findByEmail, which does not exist. Replan to add it, in scope.',
    sources: TS_API,
    task: LOGIN,
    deviations: [
      {
        note: '第 2 步要用 UserRepository.findByEmail，但这个方法不存在，仓库里只有 getById 和 create。',
        stepIndex: 1,
        filePath: 'src/auth/user-repository.ts',
      },
    ],
    expect: { decision: 'replan', scopeIncludes: ['src/auth/user-repository.ts'] },
  },
  {
    kind: 'adjudicate',
    id: 'dismiss-scope-creep',
    note: 'The developer wants to add rate limiting the plan did not ask for. Dismiss and keep the plan.',
    sources: TS_API,
    task: FIND_BY_EMAIL,
    deviations: [{ note: '我觉得 findByEmail 应该顺便加上限流和缓存，不然被刷接口会有性能问题。', stepIndex: null }],
    expect: { decision: 'dismiss' },
  },
  {
    kind: 'adjudicate',
    id: 'replan-wrong-test-location',
    note: 'The plan puts the test under src/, but the React app keeps tests in __tests__. Replan the scope.',
    sources: REACT_APP,
    task: {
      title: '设置页加删除账号按钮',
      description: '设置页加「删除账号」按钮，确认后调用 DELETE /api/account。',
      steps: ['在 SettingsPage 加按钮和确认框。', '在 src/pages/SettingsPage.test.tsx 写测试。'],
      fileScope: ['src/pages/SettingsPage.tsx', 'src/pages/SettingsPage.test.tsx'],
      acceptance: [{ text: '确认后调用删除接口', test: 'deletes the account after confirming' }],
    },
    deviations: [{ note: '项目里的测试都放在 __tests__ 目录下，计划要求的 src/pages/SettingsPage.test.tsx 和现有约定不一致，要改吗？', stepIndex: 1 }],
    expect: { decision: 'replan', scopeIncludes: ['src/pages/__tests__/SettingsPage.test.tsx'] },
  },
  {
    kind: 'adjudicate',
    id: 'contested-must-replan',
    note: 'An earlier dismissal was contested by the developer, so the only valid outcome is a replan.',
    sources: PY_SERVICE,
    task: {
      title: '发票邮件开关',
      description: '客户可以关闭发票邮件。',
      steps: ['在 Customer 模型加 invoice_emails 布尔字段。', '发送前检查开关。'],
      fileScope: ['app/billing/models.py', 'app/billing/invoices.py'],
      acceptance: [{ text: '关闭后不发邮件', test: 'test_no_email_when_disabled' }],
    },
    deviations: [
      {
        note: '发送逻辑在 app/notifications/email.py，不在 invoices.py，计划的文件范围漏了它。',
        stepIndex: 1,
        filePath: 'app/notifications/email.py',
        resolution: { decision: 'dismiss', reason: '检查放在 invoices.py 调用处即可。', contested: true },
      },
    ],
    mustReplan: true,
    expect: { decision: 'replan' },
  },
];
