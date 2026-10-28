<p align="center">
  <img src="assets/icon/icon.svg" width="120" alt="TaskPilot 图标" />
</p>

<h1 align="center">TaskPilot</h1>

<p align="center">
  <strong>写下需求，AI 团队拆成工作包、盯住质量。<br />代码你来写，或交给 Coding Agent，最后由你点头提交。</strong>
</p>

<p align="center">
  <a href="https://github.com/Erinable/TaskPilot/actions/workflows/ci.yml"><img src="https://github.com/Erinable/TaskPilot/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="平台：macOS" />
</p>

<p align="center">
  <a href="#它怎么工作">它怎么工作</a> ·
  <a href="#功能">功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#参与开发">参与开发</a>
</p>

> [!NOTE]
> TaskPilot 还在早期阶段：目前只提供 macOS 版，安装包没有签名和公证，也还没有公开下载，需要自己打包（见[快速开始](#快速开始)）。Coding Agent 的隔离同样只支持 macOS。

## 它是什么

AI 写代码很快，难的是让它改对地方、做对事，出了问题还能说清楚错在哪。TaskPilot 把这件事做成一条看得见的流水线：

- 你用大白话写需求，AI 团队问清细节，拆成一个个小的工作包：改哪些文件、分几步、做到什么程度算完成。
- 你领取工作包，照着步骤自己写，或者交给 Coding Agent 在隔离环境里写出补丁，再由你逐个文件确认。
- 提交审查时，TaskPilot 先跑你配置的检查，QA 再对照验收条件审查改动。
- 通过后你确认结果，一键提交到本机仓库。TaskPilot 从不推送。

它写给有经验的开发者，也照顾刚入门的人：术语旁有白话解释，每一步都能问 AI 导师「这一步怎么做？」，失败时会用大白话说明原因和下一步。

Claude Code、Codex 这类工具擅长「你说一句，它去改」。TaskPilot 不替代它们，而是在外面加一层流程：谁来澄清、谁来拆、改哪些文件、怎么算做完、谁来检查。调用模型的仍然是你本机装好的 CLI。

## 它怎么工作

一个需求从一句话走到本机提交，经过这些环节：

| 环节 | 谁来做 | 发生什么 |
| --- | --- | --- |
| 写需求 | 你 | 在「需求中心」用大白话描述想做的功能 |
| 澄清 | Architect、Product Lead | Architect 读相关代码，写成模块接口摘要；Product Lead 据此提问，你来回答 |
| 拆分 | Product Lead | 拆成工作包：文件范围、逐步指令、验收条件、难度、预计工时、前置依赖。你审阅后发布 |
| 领取 | 你 | 记录基线（当前提交）；工作区干净时，后台先在基线上跑一遍检查。前置包没完成不能领取 |
| 执行 | 你，或 Coding Agent | 照着步骤写；或让 Coding Agent 在隔离副本里产出补丁，你逐个文件勾选后应用 |
| 验证 | TaskPilot | 运行你配置的检查，和基线对比，分清「本来就失败」和「这次新引入的失败」 |
| 审查 | QA | 对照步骤、文件范围和验收条件审查改动。阻塞检查失败、关联测试失败或缺失，直接驳回 |
| 验收 | 你 | QA 通过且没有需要人工确认的项时直接完成；否则停在「待验收」等你确认 |
| 提交 | 你点按钮 | 只提交该工作包文件范围内的改动，只在本机，不推送 |
| 发布 | Release Manager | 根据提交和已完成的工作包，起草版本号、更新说明和发布前检查清单 |

写的过程中发现计划和代码对不上，可以「报告偏差」：Architect 来裁决，是驳回你的报告、照原计划继续，还是重新规划。不同意驳回时，你可以要求重新规划；重新规划之后也能撤销。

工作包的状态是：待执行 → 执行中 → 待审查 → 已完成。有需要人工确认的项时，待审查和已完成之间多一站「待验收」；QA 驳回会回到执行中。「偏差待裁决」和「已阻塞」是两个旁支。

## 功能

### 从需求到工作包

- 大白话需求：在「需求中心」写下想做的功能，不用先想好怎么拆。
- 每个角色只看自己那一层：Architect 读代码，写成模块接口摘要；Product Lead 只看摘要和文件列表，从不看源码。
- 可审阅的计划：每个工作包带文件范围、逐步指令、验收条件（可以关联测试）、难度和预计工时，发布前由你审阅。
- 前置依赖：Product Lead 标出一个包要等哪些包，只能依赖同一需求里排在前面的包。

### 工作队列

- 看板和列表：待执行、执行中、待审查、待验收、已完成五列，随时切换，记住你的选择。不用拖动，每张卡片只放这一列最该做的那个按钮；偏差和阻塞显示成「执行中」卡片上的标签。
- 依赖硬拦截：前置包没完成就不能领取。确实不需要时，在工作包详情页点「不等了，解除依赖」。
- 一次做一件：已有工作包在执行中时再领取，会提示改动容易混在一起，确认后仍可继续。
- 估时对账：完成后记下实际用时（领取到完成的经过时间，休息也算）。超出预计一半以上会标出来；首页的「估时准确度」是实际落在预计 0.5 到 1.5 倍之间的比例。
- 首页概览：本周完成数、平均执行时长和团队在线情况都在这里。

### 执行与检查

- 步骤清单：文件范围和验收条件放在一页，文件旁有「在编辑器中打开」，装了 `code` 命令就用 VS Code 跳到行，否则用系统文本编辑器。
- 验证命令：`test`、`lint`、`build`、`smoke` 四类，各自设阶段（提交前自动运行，或仅手动运行）和是否阻塞。测试报告可以读 stdout，也可以读 JUnit 文件。命令直接运行，不经过 shell，写 `&&`、`|` 这类 shell 语法会被拒绝。
- 对比基线：领取时在干净工作区上先跑一遍，之后只有新引入的失败才会驳回。无法判断的证据不会驳回，会列在「需要人工确认」里留给你验收。
- 失败说人话：检查失败时按规则给出白话解释和下一步，不调用模型，原始输出仍可展开。
- QA 问题能点：审查指出的问题带文件和行号，点一下在编辑器里打开。
- 环境管家：读你的项目，推荐安装方式和已有的 `package.json` 脚本。它不写命令，建议的修复只显示不执行；每一步都等你点击，默认带 `--ignore-scripts`。像 Electron、esbuild 这类必须跑安装脚本才能用的依赖，会从 `package-lock.json` 里认出来，单独给一步「运行必需的安装脚本」，只为它们运行；`npm ci` 会先删掉现有的 `node_modules`，运行前会再问一次。

### Coding Agent

- 隔离副本：从领取时的基线导出一份副本，Coding Agent 只在副本里改，TaskPilot 读回补丁。
- 按文件确认：第一轮由你逐个文件勾选并应用，被拦截的文件不能勾选，改 `package.json`、构建配置、hooks 这类高风险路径要单独同意。
- 你在 AI 写代码时也改了文件：应用前会先在临时索引里预演三方合并，你的真实 git 索引和文件不动。改在不同位置的自动合并；改到同一处的文件会标出来，由你逐个选「写入冲突标记，我来改」「保留我的」或「用 AI 的版本覆盖」（覆盖要再确认一次）。写入冲突标记后，自动检查先暂停，改完点「冲突已解决，继续」。自动重试轮遇到冲突一律停下来等你。
- 自动重试：应用后自动跑提交前检查；检查失败或 QA 驳回，会把错误带上交回 Coding Agent 再试，两者共用 3 轮。重试轮的补丁没碰高风险路径就自动应用，碰了就停下等你。
- 时间上限：每轮最长 15、30、60 或 120 分钟，默认 30，在「设置 → 模型与智能体 → 编码隔离」里选。超时后停下 AI，已经写好的部分留给你逐个文件检查，自动重试轮也不会自动应用它。
- 五种 CLI：Claude Code、Pi、Grok、Codex、OpenCode，编码默认用 Codex。两种隔离方式，见[安全边界](#安全边界)。

### 保存到 git

- 一键本机提交：工作包完成后，确认文件列表和提交说明，只提交文件范围内的改动。范围外和疑似含密钥的文件会列出来，由你自己处理。
- 从不越界：不推送、不切分支、不 amend，也不跳过 pre-commit 钩子。

### AI 团队

| 成员 | 职责 | 能看到什么 |
| --- | --- | --- |
| Architect | 读代码，写模块接口摘要；裁决偏差 | 通过 `repo_reader` 读已提交的文件 |
| Product Lead | 澄清需求，拆工作包 | 接口摘要和文件列表，不看源码 |
| QA | 对照步骤、范围和验收条件审查改动 | 变更 diff 和检查证据 |
| Coding Agent | 在隔离副本里写补丁 | 副本里的代码，可读写、可执行命令 |
| Release Manager | 起草版本号、更新说明、发布前检查清单 | 提交标题、改动路径（不含内容）、已完成的工作包 |
| Environment Steward | 推荐安装方式和脚本 | 项目的清单、锁文件、版本约束和 CI 配置 |
| Tutor | 向初学者解释某一步 | 工作包文件范围内已提交的代码 |

每个成员可以单独选 CLI、模型和思考强度。团队页显示 Product Lead、Architect、QA、Release Manager 和 Coding Agent 的在线和忙碌状态。QA 的结论由 TaskPilot 复核：阻塞检查失败，或关联测试失败、缺失，无论模型怎么说都驳回，模型只能让审查更严格。

### 发布与里程碑

- 里程碑：在发布页顶部给下个版本定计划，以需求为单位；需求详情页可以选它放进哪个版本。全部完成后，直接「起草发布说明」。
- 发布草稿：Release Manager 根据上次发布以来的提交和完成的工作包，起草版本号、更新说明和发布前检查清单。
- 发布动作留给你：Release Manager 不打 tag、不提交、不推送、不跑发布命令。它对仓库唯一的写入，是你指定一个 `.md` 文件后，把更新说明插到文件开头（路径限定在工作区内，文件不存在会新建）。

### 看清团队在做什么

- 工程地图：汇总 Architect 在各需求里读过的模块接口，按文件合并（新的覆盖旧的），文件改动后标为「可能过时」，旁边是仓库已跟踪的文件树。这一页从不调用模型。
- 活动记录：AI 成员和你的操作按时间排列，包含每次工作包流转和需求结果，保留 30 天。
- 成本：按成员、天、模型、需求和工作包查看，可切换最近 7、30、90 天。CLI 报了金额就用报的；没报就按 token 数乘 models.dev 的价格估算，并标明含估算；两样都没有就记为未知。价格表在成本页点「同步价格」手动更新。成本只统计，不设任何限额。原始记录保留 30 天，按「天 × 成员 × 模型」汇总的数据保留 1 年。
- 搜索与通知：`⌘K`（或 `Ctrl+K`）搜工作包、需求和设置页；通知里列出等你处理的事项。

### 多个仓库

在顶栏切换仓库。需求、工作包、验证命令、活动记录和发布按仓库分开保存，个人偏好是全局的。仓库以 git 根目录路径识别。切换时如果有后台任务在跑，会先列出来，确认后取消再切。

### 照顾新手

- 开始使用：首页列出 4 步：安装 CLI、添加项目、设置自动检查、写第一个需求。
- 下一步建议：执行页根据当前状态给出该做什么，术语旁有白话解释。
- AI 导师：每个步骤下有「这一步怎么做？」，Tutor 读已提交的代码，讲清思路并给一小段参考代码，不改文件。答案按步骤缓存，重新规划后自动失效。

## 快速开始

### 前提

- macOS。Coding Agent 的隔离用到 macOS 的 `sandbox-exec`，其他系统暂不支持。
- git，以及 Node.js 22.18 或更高的长期支持版（CI 用 24），用来从源码运行、打包和跑评测脚本。
- Claude Code：Product Lead、Architect、QA 等分析类角色默认都用它。首页「开始使用」的第一步，检查的是 Product Lead 和 Architect 配置的 CLI，默认就是它。装法：

  ```bash
  npm install -g @anthropic-ai/claude-code
  claude
  ```

  第二行运行一次完成登录。TaskPilot 没有输入 API Key 的地方，认证由各 CLI 自己管理。
- 想用 Coding Agent，再准备一个编码用的 CLI。默认是 Codex，也可以在设置里换成 Claude Code、Pi、Grok 或 OpenCode。自己写代码就不需要。

### 从源码运行

```bash
git clone https://github.com/Erinable/TaskPilot.git
cd TaskPilot
npm install
npm run dev
```

`npm run dev` 带热更新。想看生产构建的效果，先构建再预览：

```bash
npm run build
npm start
```

### 打包成 App

```bash
npm run dist
```

在 `dist/` 里生成 Apple Silicon（`-arm64`）和 Intel 两个架构的 dmg 和 zip，配置在 `electron-builder.yml`。安装包没有签名、没有公证，也没有自动更新：第一次打开时，在「访达」里右键应用选「打开」，或者到「系统设置 → 隐私与安全性」里点「仍要打开」。

打包后的应用和开发模式共用同一个数据目录 `~/Library/Application Support/taskpilot`。Coding Agent 独立账号模式用到的初始化脚本在应用包的 `Contents/Resources/scripts/` 里，执行页会显示它的完整路径。

### 第一次使用

1. 打开 TaskPilot，首页的「开始使用」会带你走 4 步：确认 Claude Code 装好并已登录、选择项目文件夹（需要是 git 仓库）、让环境管家推荐测试命令、写下第一个需求。另有一步可选：装好并登录 Coding Agent 用的 CLI。登录检查不调用模型：看 CLI 自己的状态命令、环境变量和配置里的 key、凭据文件，任一处有就算已登录；查不清的（如 Grok）只提示，不拦着你。
2. 在「需求中心」描述你想做的功能，回答 Product Lead 的问题，审阅计划后发布。
3. 回到「工作队列」，点「开始执行」领取一个工作包，照着步骤写，或者点「明确开始编码」交给 Coding Agent。
4. 提交审查，通过后在「保存到 git」里确认文件和提交说明。

> [!TIP]
> 如果 CLI 装在 nvm 这类版本管理器里，应用找不到它，到「设置 → 运行环境」把 PATH 来源改成「从登录 shell 读取」。

## 选择 CLI、模型与思考强度

在「设置 → 模型与智能体」里，Product Lead、Architect、QA、Release Manager、Environment Steward、Tutor、Coding Agent 各自选 CLI、模型和思考强度，互不覆盖。

- 配置存在本机 `userData/preferences.json`，不写进仓库。保存后新任务用新配置，在途任务保留启动时的选择。
- 模型留空，就用 CLI 自己的默认模型。模型下拉框从所选 CLI 的本地配置读出，不联网、不调用模型，认证信息也不会传到界面；读不到配置时可以手填，Pi 和 OpenCode 可以写 `provider/model`。设置页可以按角色、CLI 或模型筛选；点「刷新 CLI 与目录」会重新读取本地配置，不影响还没保存的修改。
- 思考强度菜单按 CLI 的能力提供。切换 CLI 时原来的等级不受支持，界面会提示并重置为默认。

| CLI | 分析类角色（含 QA） | Coding Agent | 思考强度参数 |
| --- | --- | --- | --- |
| Claude Code | 支持，restricted 模式、无工具 | 支持 | `--effort` |
| Pi | 支持，禁用工具、扩展、MCP 和上下文发现 | 支持 | `--thinking` |
| Grok | 支持，禁用工具并拒绝 MCP | 支持 | `--reasoning-effort` |
| Codex | 不支持：没有已验证的全工具关闭模式 | 支持 | `-c model_reasoning_effort=...` |
| OpenCode | 支持 1.x，隔离配置并拒绝工具权限 | 支持 | `--variant` |

分析类角色运行在空的临时目录里。Pi、Grok、OpenCode 的 provider、模型和默认推理配置按白名单复制到私有目录，连同各自固定的认证 JSON（如有）；这些临时文件权限为 0600，运行结束后删除，不加载 hooks、MCP、扩展或完整的用户配置。需要执行 helper 命令或任意 provider SDK 的配置会明确报错，不会悄悄换 CLI、provider 或模型。刷新状态只检查能力、版本和配置，不调用模型。

Grok 的认证可以来自配置里的模型凭据、许可的 `env_key`、`XAI_API_KEY` 或 `~/.grok/auth.json`。Claude Code 在 restricted 模式下，只继承原生的模型映射，以及白名单内的推理认证和 endpoint 环境变量。

## 安全边界

原则是：能不让 AI 碰的就不让它碰，必须碰的放进隔离环境，最后一步由人点头。完整设计和已接受的风险见[安全边界与部署说明](docs/coding-agent-security.md)。

### 分析类角色没有工具

Product Lead、Architect、QA、Release Manager、Environment Steward、Tutor 始终运行在受限的无工具模式：不读工作区外的文件，不执行 shell，不用编辑和搜索工具，不连 MCP。它们看到的代码只来自两个入口：

- `repo_reader`：从 git 的 blob 读已跟踪的文件，拒绝 `.env`、私钥、凭据这类疑似机密的路径，跳过二进制和超大文件。跳过了什么，都会如实告诉你。
- `review_diff`：只读 git 报告有改动的路径，规则同上。

QA 把 diff 当作不可信的数据，diff 里的文字不能让它拿到工具。所有模型输出在使用前都要通过校验，界面里的模型文字一律按纯文本显示，不用 `v-html`，打包后的页面带严格的内容安全策略。

### Coding Agent 的两种隔离

在「设置 → 模型与智能体 → 编码隔离」里选，开始一轮时就固定下来。默认只给工作区的权限，例外由你自己在设置里添加，且只能选文件夹，选到密钥、凭据这类敏感目录会警告。

**沙箱（默认）**：用你自己账号里装好、登录过的 CLI，运行在 TaskPilot 写的 macOS `sandbox-exec`（Seatbelt）配置里，不需要建账号。

- 干活的地方是领取时基线的 `git archive` 副本，放在 `userData/coding-runs/<id>`，不是你的真实仓库。
- 能写：这份副本、这次运行专用的主目录、临时目录，以及你添加的可写文件夹。所选 CLI 真正的状态目录（如 `~/.claude`、`~/.codex`）和 `~/.npm` 既读不到也写不了：每次运行把登录凭据和必要配置复制进专用主目录，CLI 只在那里读写，运行结束后只把更新过的登录凭据写回。这样 AI 没法在你的 CLI 配置里埋下 hooks，等你下次在沙箱外运行时触发。
- 能读：主目录以外的文件；主目录里只有上面这些、PATH 上工具所在的顶层目录（如 `~/.nvm`）和你添加的可读文件夹。`~/.ssh`、`~/Library` 这类目录从不因此放开。
- 可以联网：CLI 要连模型服务，沙箱分不清哪些请求是它自己发的。
- 环境变量只传 `HOME`、`PATH`、语言设置和模型服务商的 key，不传 SSH agent、云服务或 GitHub 的 token，git 全局配置指向 `/dev/null`。
- 副本里的 `.git` 由 AI 控制，所以 TaskPilot 对它执行的每条 git 命令也在同一个沙箱里跑，并关掉 hooks、fsmonitor 和外部 diff。
- 每次运行前先自检：在主目录写一个探针文件，沙箱里必须读不到，副本里必须写得进，否则拒绝运行。Seatbelt 没有公开文档，系统更新可能改变它的行为，所以自检失败一律不运行。

**独立账号（更严）**：以单独的 `taskpilot-coder` 系统用户运行。初始化脚本 `scripts/setup-coding-agent-user.sh` 默认只做演练，你审阅后加 `--apply` 才会执行。CLI 要装在该用户自己的 HOME 里并在那里登录，不借用你的凭据。TaskPilot 不替你建账号、改 sudoers、装 CLI 或登录。

### 已接受的风险

这些是设计上的取舍，用之前请知道：

- 沙箱模式下，AI 能读到所选 CLI 的登录凭据（复制进这次运行的专用主目录），CLI 需要它们才能工作。会话记录和其他 CLI 状态不会带进来，也不会带回去。
- 沙箱模式下 AI 可以联网，所以它读得到的内容也发得出去。macOS 钥匙串走系统服务而不是文件，没能证实被挡住。
- 沙箱只管主目录。主目录以外、没有别的保护的文件仍然可读，比如放在 `/srv`、`/opt` 下的仓库。需要更严的隔离，用独立账号模式。
- Codex 自带的沙箱套不进 TaskPilot 的沙箱，所以沙箱模式下它以 `danger-full-access` 运行，由外层沙箱负责限制。
- 补丁应用后，你配置的验证命令以你当前账号的权限运行，测试也会执行被 import 的普通源码。高风险路径拦截挡得住改脚本、构建配置和 hooks，挡不住这一类。自动重试轮在没碰高风险路径时不经你查看就应用补丁，所以需要强隔离时，请把检查放进容器或虚拟机。

Coding Agent 自己跑出来的检查结果只作参考。QA 和验收看的，是 TaskPilot 用你配置的命令跑出来的证据。

## 数据与隐私

- 数据放在本机 `~/Library/Application Support/taskpilot`：偏好设置在 `preferences.json`，每个仓库的需求、工作包、验证命令、发布记录和活动记录在 `repos/<仓库 id>/` 下。
- TaskPilot 改动你仓库里的文件和提交历史，只有这几种方式，都从你的操作开始：应用 Coding Agent 的补丁（第一轮按文件确认，之后的自动重试轮在没碰高风险路径时自动应用）、本机提交、往你指定的 `.md` 文件里插入更新说明。另外，你点击的环境初始化步骤和你配置的验证命令会在仓库里运行，它们产生的文件（如 `node_modules`、测试报告）由这些命令决定。
- TaskPilot 自己的代码只有一处主动联网：成本页点「同步价格」时，下载 [models.dev](https://models.dev) 的价格表，有超时和大小上限。没有遥测，也没有自动更新。模型请求都由你装的 CLI 发出，发给你给它配置的服务商；环境初始化里的安装步骤由 npm 联网。
- 活动记录和统计按业务时区划分日界，默认 `Asia/Shanghai`。要改，就在终端里启动时设置环境变量 `TASKPILOT_TIME_ZONE`（值用 IANA 名称），例如 `TASKPILOT_TIME_ZONE=America/New_York npm run dev`。

## 参与开发

Electron + electron-vite 构建。主进程和 preload 用 TypeScript，界面用 Vue 3、Pinia、Element Plus 和 UnoCSS，测试用 Vitest。主进程、preload 和界面之间的 IPC 契约在 `src/shared/`，三端共用同一份类型。

```text
src/
  main/        主进程：窗口、IPC、存储、git、验证、Coding Agent 执行
    agents/    AI 团队：Architect、Product Lead、QA、Release Manager 等
  preload/     把带类型的 window.taskpilot 交给界面
  renderer/    Vue 应用：views、components、Pinia stores
  shared/      三端共用的 IPC 通道与类型
tests/         镜像 src/ 的 Vitest 测试
evals/         Product Lead、QA、Architect 的评测
docs/          安全边界与部署说明
scripts/       图标生成、Coding Agent 初始化脚本
```

常用命令：

```bash
npm run dev            # 开发模式，带热更新
npm test               # Vitest，会先跑 Coding Agent wrapper 的 shell 测试
npm run typecheck      # vue-tsc，覆盖主进程、preload、界面和测试
npm run lint           # ESLint
npm run format:check   # Prettier
npm run build          # 打包主进程、preload 和界面到 out/
```

CI（`.github/workflows/ci.yml`）在 Ubuntu 和 macOS 上依次跑 typecheck、lint、format:check、test、build；另有一个 Ubuntu 任务运行 jscpd 重复检测、函数复杂度增量门禁和 Knip 循环依赖检查。

打开 Actions 运行页面的 Summary，可直接查看 Code analysis 摘要：三项检查状态、重复率与代码位置、复杂度超限及新增问题、循环依赖诊断。表格最多显示 20 项，完整 JSON 报告和 Knip 日志位于该页面的 Artifacts，保留 14 天；失败或跳过的检查会单独标明。

主进程按 `app`、`infrastructure`、`repository`、`checking`、`runtimes` 及业务领域分目录；单元测试镜像对应目录，IPC 集成测试集中在 `tests/main/ipc/`。所有 IPC 调用都从 `src/shared/ipc/` 契约表派生，不再在 preload 和类型声明里重复维护。

后台进度和外部笔记修改通过 `state:changed` 推送失效通知，界面按领域重新读取，不再定时轮询；离开页面或切换仓库会解除订阅，迟到的响应不会覆盖新选择。主进程日志默认记录 info 及以上，保存在本机数据目录的 `logs/taskpilot.log`。

应用自有 JSON 数据带格式版本：无版本的旧文件按 v1 读取；遇到比当前应用更新的版本会拒绝读取、覆盖或清空。工作区仍是 v3，课程信任记录仍是 v2；并发写入统一串行提交。提示词整篇快照和只检查实现文本的测试已移除，保留行为、安全边界及状态转换测试。

负向测试通过 `tests/fixtures/expected_errors.ts` 在单个场景内捕获明确预期的主进程错误，不再 mock `console.error`；未匹配的错误仍输出并使该测试失败，测试结束时恢复 logger。课程相关 IPC 测试的默认评分 fixture 按请求 schema 生成 rubric 分类；提交审查的场景也要检查评分完成，避免审查通过却漏掉评分失败。

改应用图标：源文件是 `assets/icon/icon.svg`（128 px 及以上）和 `icon_small.svg`（64 px 及以下）。改完先 `brew install librsvg`，再运行 `scripts/build_icon.sh` 重新生成 `icon.icns`。

### 代码分析

下面的命令可以本地运行，也不会自动删除或改写代码。CI 自动运行重复检测、复杂度门禁和循环检查；未使用代码分析仍按需手动运行：

```bash
npm run analyze:cycles       # Knip：静态运行时循环依赖，以及无法解析的导入
npm run analyze:unused       # Knip：未使用文件、导出、类型、依赖，以及未声明的依赖
npm run analyze:duplicates   # jscpd：src/ 中至少 10 行、80 tokens 的重复代码块，重复率超过 1% 失败
npm run analyze:complexity   # ESLint：报告 src/ 中圈复杂度超过 20 的函数
npm run check:complexity     # 与 HEAD 比较，只阻断新增或加重的超限函数
```

Knip 通过 Electron Vite 和 Vitest 插件识别应用与测试入口；`knip.json` 补充独立评测入口和 `@`、`@shared` 别名，不会把全部源码都当作入口。检测到循环会返回非零退出码。循环检查默认不包含类型导入和动态导入，不代表模块分层规则已经通过检查。

重复检测跳过类型声明，不扫描测试和生成目录；控制台之外的 JSON 报告写入已被 git 忽略的 `.taskpilot/analysis/duplicates/`。CI 将报告上传为 `duplicate-code-report`，保留 14 天，再运行循环检查，因此循环检查失败也不会丢失已生成的报告。重复率超过 `.jscpd.json` 的 `threshold`（1%）时命令返回非零，CI 的 `analyze` 失败；报告仍会先写出并上传。阈值以内的重复块由人工判断是否值得抽取公共实现。

未使用代码报告需要结合 Vue 模板、动态引用和脚本入口人工判断，不应直接据此批量删除。本地只运行与当前问题最相关的一项，不默认串联全部分析。

复杂度使用 ESLint 的 classic 圈复杂度规则，包含 TypeScript 和 Vue 的 script 块，排除类型声明；普通 `npm run lint` 仅提示超过 20 的函数，不因历史复杂度警告失败。`analyze:complexity` 输出完整超限列表和 `.taskpilot/analysis/complexity/complexity-report.json`，不设置总代码行数限制。

`check:complexity` 默认以 HEAD 为基线，也可以运行 `npm run check:complexity -- --base main` 指定 Git 提交或分支。旧函数超限但复杂度没有增加时通过；新增函数超过 20、原有函数从 20 以下跨过限制，或超限函数继续加重时失败。比较逐个函数进行，不能用删除其他复杂函数来抵消新增问题。基线从 Git 读取，不写入源码快照或源码哈希；无法读取基线、解析失败或无法识别诊断时直接失败。

函数通过文件路径、命名作用域和调用位置识别，不依赖行号；Git 识别出的文件重命名沿用旧文件基线。函数改名、移动作用域或 Git 未识别出的文件重命名按新增处理；同一作用域的同类匿名回调通过出现顺序区分，调整其顺序可能需要人工判断。CI 对 PR 使用目标分支提交，对 main 的 push 使用 push 前的提交，报告上传为 `complexity-report` 并保留 14 天。该门禁控制新增复杂度，不证明代码不存在语义重复，也不自动认可某种重构方式。

### 评测

改了 Product Lead、QA 或 Architect 的提示词，用评测检查有没有变差。评测会调用真实模型，**会产生费用**，跑之前想清楚。

```bash
npm run eval:product-lead -- --architect
npm run eval:qa
npm run eval:architect
```

用例、评分方式和参数见各目录的 README：[`evals/product-lead`](evals/product-lead/README.md)、[`evals/qa`](evals/qa/README.md)、[`evals/architect`](evals/architect/README.md)。

### 提交代码前

目录约定、命名和代码风格见 [AGENTS.md](AGENTS.md)。提交信息用简短的祈使句，最好是 Conventional Commits 形式，例如 `feat: add task parser`。行为变化请附带针对性的回归测试，并在 PR 描述里写明验证命令和结果。
