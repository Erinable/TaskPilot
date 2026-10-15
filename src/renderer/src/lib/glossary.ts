// Plain-words explanations of the terms TaskPilot shows, for developers new
// to programming. One place, so every page explains a word the same way.
export const GLOSSARY = {
  baseline: { term: '基线', meaning: '你开始做这个工作包时项目的样子。TaskPilot 拿它对比，分清哪些改动和问题是这次带来的。' },
  deviation: { term: '偏差', meaning: '计划和真实代码对不上，比如步骤说的文件或函数不存在。报告后 Architect 会判断是改计划还是照原计划做。' },
  review: { term: '审查', meaning: 'QA Partner 检查你的改动：跑测试、看是否满足验收条件，再告诉你哪里要改。' },
  acceptance: { term: '验收条件', meaning: '做完的标准。每一条都满足，这个工作包才算完成。' },
  scope: { term: '文件范围', meaning: '这个工作包计划要改的文件。改了范围外的文件会被标出来提醒你。' },
  lint: { term: 'Lint', meaning: '自动检查代码写法和格式的工具，能发现拼写错误、没用到的变量之类的问题。' },
  smoke: { term: '冒烟测试', meaning: '构建后快速跑一下，确认程序能正常启动，最基本的功能没坏。' },
  build: { term: 'Build（构建）', meaning: '把源代码编译或打包成能运行的程序，能发现类型错误等问题。' },
  commit: { term: '提交（commit）', meaning: '把一组改动存进 git 历史，像给项目拍一张快照，以后可以回看或撤回。' },
  thinking: { term: '思考强度', meaning: '模型动手前想多久。越高越仔细，也越慢、越贵；「跟随模型」用 CLI 的默认值。' },
  patch: { term: '补丁', meaning: 'AI 写出的改动清单：哪个文件、哪几行、怎么改。你勾选并应用后，才会真正写进项目。' },
  adjudication: { term: '裁决', meaning: '你报告偏差后，Architect 判断该怎么办：驳回报告照原计划做，或者重新规划这个工作包。' },
  test: { term: '测试', meaning: '运行项目自带的自动化测试，确认功能按预期工作，没有把原来好的地方改坏。' },
  blocked: { term: '阻塞', meaning: '因为外部原因暂时做不下去，比如在等别人的接口。标记后它不会被当作进行中。' },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
