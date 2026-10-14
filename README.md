# TaskPilot

TaskPilot 是一个面向程序员的桌面工作台：AI 团队负责需求澄清、架构决策、任务拆解和质量检查，人类开发者负责执行清晰的编码工作包。

## 当前 MVP

- 新手引导：首页列出开始使用要做的 4 步；执行页给出「下一步」建议，术语旁有白话解释，每个步骤都能问 AI 导师「这一步怎么做？」。
- 保存到 git：工作包完成后，确认文件列表和提交说明，一键提交文件范围内的改动。只在本机提交，从不推送。
- 多仓库：在顶栏切换仓库；需求、工作包、验证命令、活动记录和发布按仓库分开保存。切换时如有任务在运行，会先确认再取消。
- 工作队列：按优先级查看从需求发布的编码工作包，以及本周完成数、平均执行时长。
- AI 团队动态：Product Lead、Architect、QA 和你的操作记录，保留 30 天；成员在线状态按各自选择的 CLI 探测。
- 工程地图：汇总 Architect 在各需求里读过的模块接口，文件改动后标为可能过时。
- 搜索（⌘K）与通知：搜索工作包、需求和设置页；通知列出等你处理的事项。
- 发布：Release Manager 根据上次发布以来的提交和完成的工作包，起草版本号、更新说明和检查清单；TaskPilot 不打 tag、不提交、不推送。
- 工作包详情：展示文件范围、逐步执行指令和验收条件。
- 人类反馈：开始执行或报告设计与代码之间的偏差。
- 智能体配置：在「设置 → 模型与智能体」中分别为 Product Lead、Architect、QA、Release Manager、Environment Steward、Tutor、Coding Agent 选择 CLI、模型和思考强度。编码改动仍需人工审查和应用。

## 本地运行

```bash
npm install
npm run dev
```

开发模式带热更新。构建并运行打包后的应用：

```bash
npm run build
npm start
```

运行测试和类型检查：

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```

## 打包（macOS）

```bash
npm run dist
```

在 `dist/` 里生成 Apple Silicon（`-arm64`）和 Intel 两个架构的 dmg 和 zip。配置在 `electron-builder.yml`。安装包目前没有签名、没有公证，也没有自动更新：第一次打开时，在「访达」里右键应用选「打开」，或者到「系统设置 → 隐私与安全性」里点「仍要打开」。

打包后的应用和开发模式用同一个数据目录 `~/Library/Application Support/taskpilot`。Coding Agent 的初始化脚本在应用包里的 `Contents/Resources/scripts/`，执行页会显示它的完整路径。

应用图标的源文件是 `assets/icon/icon.svg`（128 px 及以上）和 `icon_small.svg`（64 px 及以下）。修改后运行 `scripts/build_icon.sh` 重新生成 `icon.icns`，需要先 `brew install librsvg`。

## 智能体 CLI、模型与思考强度

配置保存在本机 `userData/preferences.json` 的 `agents` 中，不写入仓库；各角色互不覆盖。保存后新任务使用新配置，在途任务保留启动时的 CLI、模型和思考强度。模型留空表示使用 CLI 的默认模型。

设置页按角色紧凑排列，可按角色、CLI 或模型筛选。模型字段从所选 CLI 本地配置生成可搜索下拉框，按 provider 分组并显示原生默认；没有配置目录时仍可输入自定义模型 ID。选择默认项或清空会跟随 CLI 原生配置。目录只投影模型元数据，不调用模型、不联网刷新，也不把认证信息传给渲染层。“刷新 CLI 与目录”重新读取本地配置，不影响未保存的角色设置。

| CLI | 分析 / QA | Coding Agent | 思考强度原生参数 |
| --- | --- | --- | --- |
| Claude Code | 支持，restricted + 无工具 | 支持 | `--effort` |
| Pi | 支持，禁用工具、扩展、MCP 和上下文发现 | 支持 | `--thinking` |
| Grok | 支持，禁用工具并拒绝 MCP | 支持 | `--reasoning-effort` |
| Codex | 不支持：没有已验证的全工具关闭模式 | 支持，`workspace-write` | `-c model_reasoning_effort=...` |
| OpenCode | 支持 1.x，隔离配置并拒绝工具权限 | 支持 | `--variant` |

思考强度菜单按 CLI 能力提供；具体模型或 provider 必须支持所选等级 / variant。切换 CLI 时如原等级不受支持，界面会提示并重置为默认。Pi / OpenCode 模型可填写 `provider/model`。

分析层使用空临时目录；Pi、Grok、OpenCode 将原生 provider、模型和默认推理配置按白名单投影到私有目录，并复制各自固定的认证 JSON（如有），不会加载 hooks、MCP、扩展或完整用户配置。Claude 在 restricted 模式下仅继承原生模型映射及白名单内的推理认证 / endpoint 环境变量。Grok 支持配置里的模型凭据、许可的 `env_key`、`XAI_API_KEY` 或 `~/.grok/auth.json`。需要执行 helper 命令或任意 provider SDK 的配置会明确失败，不自动切换 CLI、provider 或模型。状态刷新只检查能力、版本与配置，不调用模型。

Coding Agent 有两种隔离方式，在「设置 → 模型与智能体 → 编码隔离」里选：

- 沙箱（默认）：用你自己账号里装好、登录过的 CLI，运行在 TaskPilot 写的 macOS 沙箱（`sandbox-exec`）里，只能读写这一轮的项目副本，读不到主目录里的其他文件；可以联网。每次运行前会先自检沙箱确实生效，否则不运行。
- 独立账号（更严）：以独立的 `taskpilot-coder` 用户运行。CLI 必须安装在该用户 HOME 内，并通过固定的 `~/.local/bin/{claude,pi,grok,codex,opencode}` 入口启动；认证也必须在该账号内完成，不能借用主账号凭据。支持指向该 HOME 内、由该用户拥有的可执行文件的符号链接。安装 / 升级 root-owned wrapper 前请阅读 [安全边界与部署说明](docs/coding-agent-security.md)。TaskPilot 不自动创建系统账号、修改 sudoers、安装 CLI 或登录。

两种方式能挡住什么、不能挡住什么，见 [安全边界与部署说明](docs/coding-agent-security.md)。

## 技术栈

Electron + electron-vite 构建。主进程和 preload 用 TypeScript，渲染层用 Vue 3、Pinia、Element Plus 和 UnoCSS，测试用 Vitest。主进程、preload 和渲染层之间的 IPC 契约定义在 `src/shared/` 里，三端共用同一份类型。
