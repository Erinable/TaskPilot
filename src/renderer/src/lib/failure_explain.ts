// Plain-language reading of a failed check, for people new to test runners
// and compilers: what most likely went wrong and what to try next. Pattern
// rules over the output, no model call; the raw output stays available below.
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

export type FailureInput = {
  kind: workspaceTypes.CheckKind;
  exitCode: number;
  timedOut: boolean;
  // Full output, or its tail when that is all a stored review kept.
  output: string;
  // Parsed failing tests.
  failed: number;
};

export type FailureExplanation = { title: string; detail: string };

// First match wins; the order puts the most specific causes first.
const RULES: { test: (input: FailureInput) => boolean; explain: (input: FailureInput) => FailureExplanation }[] = [
  {
    test: ({ timedOut }) => timedOut,
    explain: () => ({
      title: '命令运行太久，被停掉了',
      detail: '常见原因是代码里有死循环、在等一个没有返回的网络请求，或者测试在等你在终端输入。先看最近改的地方有没有循环或等待。',
    }),
  },
  {
    test: ({ exitCode, output }) => exitCode === 127 || /command not found|is not recognized as an internal or external command/i.test(output),
    explain: () => ({
      title: '找不到要运行的命令',
      detail: '命令本身没装好，或者不在 PATH 里。可以在「设置 → 运行环境」里改为从登录 shell 读取 PATH，或先在终端里运行一次同样的命令确认它存在。',
    }),
  },
  {
    test: ({ output }) => /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named/i.test(output),
    explain: ({ output }) => ({
      title: '有一个模块找不到',
      detail: `${moduleName(output)}通常是 import 的路径写错了（大小写、相对路径、少了文件扩展名），或者依赖还没装。检查 import 语句；如果是第三方包，先在设置里运行环境初始化安装依赖。`,
    }),
  },
  {
    test: ({ output }) => /error TS\d+/.test(output),
    explain: ({ output }) => ({
      title: `类型检查没通过（${count(output, /error TS\d+/g)} 处）`,
      detail:
        '下面输出里每条 error 前面是「文件(行,列)」。常见原因是传的参数类型不对、少传了参数，或者用了不存在的属性名。从第一条开始改，后面的往往会一起消失。',
    }),
  },
  {
    test: ({ output }) => /SyntaxError|Unexpected token|Unterminated string|Expected .+ but found/i.test(output),
    explain: () => ({
      title: '代码有语法错误',
      detail: '通常是括号、引号或逗号没配对，或者代码粘贴不完整。输出里会写出文件和行号，在编辑器里打开那一行，看看前后几行是否配对。',
    }),
  },
  {
    test: ({ kind, failed }) => kind === 'test' && failed > 0,
    explain: ({ failed }) => ({
      title: `${failed} 个测试没通过`,
      detail:
        '下面列出了失败的测试名。每个测试的输出里一般有「expected（期望）」和「received / actual（实际）」两个值，对比它们就知道代码哪里和预期不一样。先修一个，再重新运行。',
    }),
  },
  {
    test: ({ kind }) => kind === 'test',
    explain: () => ({
      title: '测试命令失败了，但没有测试报告失败',
      detail: '多半是测试还没开始就出错了，比如测试文件本身导入失败或配置有误。看下面输出里第一条报错。',
    }),
  },
  {
    test: ({ kind }) => kind === 'lint',
    explain: () => ({
      title: '代码风格检查发现了问题',
      detail: 'Lint 检查的是写法，不是功能，比如没用到的变量、缺少的分号。输出里每条都有文件、行号和规则名；很多问题可以用编辑器的「自动修复」一键改好。',
    }),
  },
  {
    test: ({ kind }) => kind === 'build',
    explain: () => ({
      title: '项目没能构建成功',
      detail: '构建会把所有代码一起编译打包，只要有一个文件出错就会失败。在下面输出里找第一条 error，它会写出是哪个文件。',
    }),
  },
  {
    test: ({ kind }) => kind === 'smoke',
    explain: () => ({
      title: '冒烟测试失败：程序没能正常启动或响应',
      detail: '冒烟测试只检查程序能不能跑起来。看输出里的第一条报错，常见是启动时就抛了异常，或者端口被占用。',
    }),
  },
];

const count = (output: string, pattern: RegExp) => output.match(pattern)?.length ?? 0;

// "缺的是 `./auth`。" when the output names it; text only, never markup.
const moduleName = (output: string) => {
  const name = /Cannot find module ['"]([^'"\n]{1,120})['"]|No module named ['"]?([\w.]{1,120})/.exec(output);
  const found = name?.[1] ?? name?.[2];
  return found ? `缺的是 \`${found}\`。` : '';
};

export const explainFailure = (input: FailureInput): FailureExplanation | null => {
  if (input.exitCode === 0 && !input.timedOut && input.failed === 0) return null;
  const rule = RULES.find((candidate) => candidate.test(input));
  return rule ? rule.explain(input) : { title: `命令以退出码 ${input.exitCode} 结束`, detail: '看下面输出里的第一条报错。' };
};
