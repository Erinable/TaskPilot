// Eval cases for Product Lead. Each case is a requirement, the repository
// file list Product Lead would see, scripted answers to whatever it asks,
// and expectations the checks score against.
//
// File lists are fixed so runs are comparable; they mimic real layouts
// rather than this repository.

const TS_API = [
  'package.json', 'tsconfig.json', 'README.md',
  'src/index.ts', 'src/app.ts',
  'src/auth/user-repository.ts', 'src/auth/user.ts', 'src/auth/token-service.ts',
  'src/http/router.ts', 'src/http/middleware/error-handler.ts',
  'src/db/client.ts', 'src/db/migrations/001_users.sql',
  'tests/auth/user-repository.test.ts', 'tests/http/router.test.ts', 'tests/helpers/fake-db.ts',
];

const REACT_APP = [
  'package.json', 'vite.config.ts', 'index.html',
  'src/main.tsx', 'src/App.tsx',
  'src/components/Button.tsx', 'src/components/Modal.tsx', 'src/components/Table.tsx',
  'src/pages/SettingsPage.tsx', 'src/pages/OrdersPage.tsx',
  'src/api/client.ts', 'src/api/orders.ts',
  'src/hooks/useOrders.ts',
  'src/components/__tests__/Button.test.tsx', 'src/pages/__tests__/OrdersPage.test.tsx',
];

const PY_SERVICE = [
  'pyproject.toml', 'README.md',
  'app/__init__.py', 'app/main.py', 'app/config.py',
  'app/billing/__init__.py', 'app/billing/invoices.py', 'app/billing/models.py',
  'app/notifications/__init__.py', 'app/notifications/email.py',
  'tests/test_invoices.py', 'tests/conftest.py',
];

const sources = require('./sources');

const SOURCES_BY_FILES = new Map([[TS_API, sources.TS_API], [REACT_APP, sources.REACT_APP], [PY_SERVICE, sources.PY_SERVICE]]);

const cases = [
  {
    id: 'clear-small',
    note: 'Clear, small, fits the repo. Should ask little and plan 1–2 packages.',
    requirement: {
      title: '',
      text: '给 UserRepository 加一个 findByEmail(email) 方法，邮箱比较忽略大小写，找不到返回 null。补上单元测试。',
    },
    files: TS_API,
    answers: {},
    expect: {
      questions: [0, 1], packages: [1, 1], hours: [0.5, 2],
      mustTouch: ['src/auth/user-repository.ts', 'tests/auth/user-repository.test.ts'],
      // Facts only visible in the code: the existing fake-db test helper, and
      // that the sibling getById throws NotFoundError (the requirement asks
      // findByEmail to return null instead, so a good plan notes the contrast).
      grounding: ['fakeDb', 'NotFoundError'],
    },
  },
  {
    id: 'login-typical',
    note: 'The motivating case: medium feature, real ambiguity worth one or two questions.',
    requirement: {
      title: '',
      text: '用户可以用邮箱和密码登录。登录失败时不能暴露邮箱是否已注册。',
    },
    files: TS_API,
    answers: {
      default: '按现有代码的做法来就行。',
      token: '用现有的 TokenService 签发 JWT，不需要刷新令牌。',
      lock: '这期不做锁定和限流。',
      frontend: '只做后端接口。',
      hash: '密码已经用 bcrypt 存储。',
    },
    expect: {
      questions: [1, 3], packages: [1, 3], hours: [2, 6], mustTouch: ['src/auth/user-repository.ts'], mustNotInvent: ['session'],
      grounding: ['issue(', 'NotFoundError', 'route('],
    },
  },
  {
    id: 'vague',
    note: 'Too vague to plan well. Should ask focused questions, not guess a big design.',
    requirement: { title: '', text: '订单页面太慢了，优化一下。' },
    files: REACT_APP,
    answers: {
      default: '主要是订单多的时候（几千条）滚动卡顿，首屏也要等 3 秒。',
    },
    expect: { questions: [1, 4], packages: [1, 3], hours: [1, 8], mustTouch: ['src/pages/OrdersPage.tsx'], grounding: ['listOrders', 'useOrders'] },
  },
  {
    id: 'large',
    note: 'Big feature. Should split cleanly, in dependency order, each package small.',
    requirement: {
      title: '发票邮件',
      text: '开票后自动给客户发邮件，附 PDF 发票。发送失败要重试 3 次，最终失败要在后台能看到。客户可以在设置里关闭发票邮件。',
    },
    files: PY_SERVICE,
    answers: {
      default: '用现有的 email 模块发送。重试用简单的后台任务即可，不引入新的队列。后台查看先做成一个列出失败记录的接口。',
      pdf: '用 weasyprint 生成 PDF。',
      setting: '设置存在客户表上，加一个布尔字段。',
    },
    expect: {
      questions: [1, 4], packages: [3, 5], hours: [5, 14], mustTouch: ['app/billing/invoices.py', 'app/notifications/email.py'],
      grounding: ['issue_invoice', 'send_email', 'session'],
    },
  },
  {
    id: 'frontend-only',
    note: 'UI-only change in a React app. Tests should follow the __tests__ convention.',
    requirement: {
      title: '',
      text: '设置页加一个「删除账号」按钮，点击后弹确认框，确认后调用 DELETE /api/account，成功后跳到首页。',
    },
    files: REACT_APP,
    answers: { default: '接口已经有了。确认框用现有的 Modal 组件。' },
    expect: {
      questions: [0, 2], packages: [1, 2], hours: [1, 4], mustTouch: ['src/pages/SettingsPage.tsx'], testPattern: /__tests__\//,
      grounding: ['request', 'Modal', 'variant="danger"'],
    },
  },
  {
    id: 'no-repo',
    note: 'No repository configured. Should still plan, and say paths are assumed.',
    requirement: { title: '', text: '写一个命令行工具，读取 CSV 文件，按指定列去重后输出到新文件。用 Node.js。' },
    files: [],
    answers: { default: '保留第一次出现的行。列名通过参数传入。' },
    expect: { questions: [0, 3], packages: [1, 2], hours: [1, 4] },
  },
];

/**
 * Picks a scripted answer for a question by keyword, falling back to the
 * case's default. Keeps runs reproducible whatever the agent asks.
 */
const ANSWER_KEYWORDS = {
  token: ['token', 'jwt', 'session', 'cookie', '会话', '令牌', '登录状态'],
  lock: ['锁定', '限流', '暴力', 'rate', 'lock', '失败次数', '几次'],
  frontend: ['前端', '页面', 'ui', '界面'],
  hash: ['哈希', 'hash', 'bcrypt', 'argon', '加密', '存储'],
  pdf: ['pdf', '生成'],
  setting: ['设置', '关闭', '开关', '偏好'],
};

function answerFor(testCase, question) {
  const lower = question.toLowerCase();
  for (const [key, words] of Object.entries(ANSWER_KEYWORDS)) {
    if (testCase.answers[key] && words.some((word) => lower.includes(word))) return testCase.answers[key];
  }
  return testCase.answers.default ?? '';
}

// Each case carries its repository's file contents for Architect to read.
for (const testCase of cases) testCase.sources = SOURCES_BY_FILES.get(testCase.files) ?? {};

module.exports = { cases, answerFor };
