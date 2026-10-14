// Why the coding runtime is unavailable, in plain words, from the probe's raw
// reason (sudo, the wrapper, the CLI, or the sandbox self-check). The raw
// text stays available for anyone who needs it; this is what a beginner
// reads first.
export type CodingSetupIssue =
  | 'sandbox_cli_missing'
  | 'sandbox_unsupported'
  | 'sandbox_broken'
  | 'user_missing'
  | 'wrapper_missing'
  | 'sudo_denied'
  | 'cli_missing'
  | 'cli_broken'
  | 'unsupported_config'
  | 'timeout'
  | 'unknown';

// Sandbox reasons start with "sandbox:" (coding_sandbox.ts), so they are
// matched first.
const RULES: [RegExp, CodingSetupIssue][] = [
  [/^sandbox: \S+ CLI not found on PATH/, 'sandbox_cli_missing'],
  [/^sandbox: (macOS only|sandbox-exec not found)/, 'sandbox_unsupported'],
  [/^sandbox: /, 'sandbox_broken'],
  [/unknown user taskpilot-coder|no such user/i, 'user_missing'],
  [/taskpilot-coding-wrapper: command not found|wrapper.*(No such file|not found)/i, 'wrapper_missing'],
  [/a password is required|not allowed to execute|is not in the sudoers|may not run sudo/i, 'sudo_denied'],
  [/CLI unavailable; install it/i, 'cli_missing'],
  [/CLI version probe failed|returned no version/i, 'cli_broken'],
  [/Unsupported coding CLI configuration|unsupported CLI|unsupported thinking|invalid model/i, 'unsupported_config'],
  [/timed out/i, 'timeout'],
];

export const codingSetupIssue = (reason: string | null): CodingSetupIssue => RULES.find(([pattern]) => pattern.test(reason ?? ''))?.[1] ?? 'unknown';

// Title, explanation and whether running the setup script is the fix.
export const CODING_SETUP_TEXT: Record<CodingSetupIssue, { title: string; body: string; runSetup: boolean }> = {
  sandbox_cli_missing: {
    title: '找不到所选的 CLI',
    body: '沙箱模式用你自己账号里装好的 CLI，但在 PATH 里没找到它。先在终端里安装并登录一次；如果它装在 nvm 这类工具里，到「设置 → 环境」把命令路径改成「登录 shell」。',
    runSetup: false,
  },
  sandbox_unsupported: {
    title: '这台电脑用不了沙箱模式',
    body: '沙箱模式依赖 macOS 自带的 sandbox-exec。到「设置 → 模型与智能体 → 编码隔离」改用独立账号模式。',
    runSetup: false,
  },
  sandbox_broken: {
    title: '沙箱自检没有通过，已停止',
    body: '每次运行前，TaskPilot 会先在沙箱里试读一个它不该读到的文件，确认确实被挡住。这次自检没通过，可能是系统更新改变了沙箱的行为。为安全起见不会继续运行。可以重试；如果一直失败，改用独立账号模式。',
    runSetup: false,
  },
  user_missing: {
    title: '还没有设置编码专用账号',
    body: 'Coding Agent 会在你电脑上改代码、执行命令。为了不让它碰到你的密钥、云凭据和其他项目，它在一个单独的系统账号 taskpilot-coder 里运行。这个账号还没创建。',
    runSetup: true,
  },
  wrapper_missing: {
    title: '编码专用账号的启动程序还没装好',
    body: 'TaskPilot 通过一个只允许固定操作的小程序切换到 taskpilot-coder 账号。这个程序还没安装，重新运行一次初始化脚本即可。',
    runSetup: true,
  },
  sudo_denied: {
    title: '系统不允许切换到编码专用账号',
    body: '账号存在，但 sudo 授权没配好，或者需要输入密码。初始化脚本会写入一条只允许运行启动程序、无需密码的授权，重新运行一次即可。',
    runSetup: true,
  },
  cli_missing: {
    title: '编码专用账号里还没装所选的 CLI',
    body: '账号已经设置好，但它自己的目录里还没有安装你在「设置 → 模型与智能体」里为 Coding Agent 选的 CLI。需要切换到这个账号安装并登录一次，不能借用你自己账号的登录。',
    runSetup: false,
  },
  cli_broken: {
    title: '编码专用账号里的 CLI 运行不了',
    body: 'CLI 已经装了，但读不到版本号，可能是安装不完整。切换到 taskpilot-coder 账号重新安装一次。',
    runSetup: false,
  },
  unsupported_config: {
    title: '这个 CLI 组合不能用来写代码',
    body: '在「设置 → 模型与智能体」里，为 Coding Agent 换一个 CLI、模型或思考强度。',
    runSetup: false,
  },
  timeout: {
    title: '检查编码环境超时了',
    body: '可能是电脑正忙，稍后点刷新再试一次。',
    runSetup: false,
  },
  unknown: {
    title: '编码环境暂时不可用',
    body: '下面是系统给出的原始信息。如果是第一次使用，先运行初始化脚本。',
    runSetup: true,
  },
};
