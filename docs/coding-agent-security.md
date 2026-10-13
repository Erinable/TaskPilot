# Coding Agent 安全边界与执行设计

## 当前选择

编码后端支持 Claude Code、Pi、Grok、Codex、OpenCode；默认仍为 Codex。每个角色的 CLI、模型和思考强度从「设置 → 模型与智能体」配置，运行开始后固定快照。

执行边界：单独 OS 用户。当前 macOS bootstrap 是
`scripts/setup-coding-agent-user.sh`，默认只做 dry run；创建用户和 sudoers
前必须人工审阅并用 `--apply` 明确执行。

TaskPilot 不替用户执行 `sysadminctl`、`dscl`、sudoers 修改、CLI 安装或登录。
编码用户固定为 `taskpilot-coder`，在该账号自己的 HOME 中安装和认证所选 CLI。

## 两个信任层

### 受限分析层

Product Lead、Architect、QA、Release Manager、Environment Steward、Tutor 始终通过
对应 CLI 的受限、无工具 profile 运行：

- 不读取工作区外文件；
- 不执行 shell、MCP、编辑、搜索工具；
- 代码内容只来自 `repo_reader` 或 `review_diff`；
- QA 把 diff 当不可信数据，不能因为 diff 中的文本而获得工具；
- 现有结构化输出 validator 继续生效。

Grok 分析 profile 必须使用 `--deny MCPTool`，并检查初始化事件的 `tools`
列表为空；Coding Agent profile 不得使用这两条规则，因为它需要 edit 和
shell 工具。

### 编码执行层

Coding Agent 可以读写和执行命令，但只能运行在由 baseline 导出的、独立
OS 用户拥有的目录中。CLI sandbox 只是防御纵深，不是安全边界。个人账号
运行时，编码 Agent 可能读取该账号的 `~/.ssh`、云 CLI 配置和其他凭据；
推荐单独 OS 用户，强隔离场景使用容器或 VM。

## 为什么不用 git worktree

单独 OS 用户不能安全地使用主用户 checkout 的 linked worktree：Git 的
metadata 会写入主用户 `.git/worktrees/`，造成 owner/`safe.directory` 问题，
也可能让编码用户写入主用户未来会执行的 hooks。

MVP 使用 archive/import/export：

1. 主用户校验 package `baseline`。
2. 主用户执行 `git archive <baseline>`。
3. archive 通过 stdin 流给 agent 用户执行的 `tar -x -C <agent-run-dir>`。
4. agent 用户在自己的目录 `git init`，把解压内容做成唯一 baseline commit。
5. 所选编码 CLI 以固定 profile 在该目录工作，并接收该次运行的模型和思考强度。
6. 模型自行执行的编码检查也只能使用该用户的权限，其输出不是主账号 QA 的可信证据。
7. 主用户只通过 agent 用户执行的 `git diff --binary` 读取 patch。
8. TaskPilot 对 patch 做路径、symlink、secret、`.git`、out-of-scope 检查。
9. 人类确认后，主用户把 patch 应用到自己的 checkout；不允许自动 commit 或 push。

不存在 agent 用户可写的共享交换目录。主用户只把 baseline 从 stdout 流进去，
再把 patch 从 stdout 读出来。

## 预审检查与 Apply 风险

编码 CLI 内执行的 test/lint/build/smoke 使用独立编码账号的权限，日志只作为参考。
人类审查并 Apply 后，执行页验证和提交 QA 的配置命令使用当前主账号权限；
以下改动可能影响这些命令执行的代码，不能由编码账号或 CLI sandbox 保护：

- `package.json` scripts；
- lockfile 触发的安装/构建行为；
- `.npmrc`；
- test/build 配置；
- Makefile、CI 配置；
- `.git*`、hooks；
- shell script 和构建脚本。

Apply 前应特别审查这些高风险路径。界面要求人工确认高风险补丁，并在已应用编码结果时
提示主机权限验证风险；不要把「模型说测试通过」当作最终验收证据。

## Push 防护

TaskPilot 不自动创建 commit 或执行 push。编码 prompt 要求模型不 commit / push；
运行环境不注入 `GH_TOKEN`、`GITHUB_TOKEN`、`SSH_AUTH_SOCK` 等主账号的 push 凭据。
Codex 使用 `workspace-write` 和非交互的 `--ask-for-approval never`，不使用
`--dangerously-bypass-approvals-and-sandbox`。其他 CLI 的编码工具运行在独立用户边界内，
不是主账号权限下的通用 shell。wrapper 限制的是启动的 CLI / 参数，不是任意模型 shell 命令的内容；
不要给编码账号配置不必要的 Git / 云访问权限。

`sudo` 使用默认 `env_reset`，不使用 `sudo -E`；wrapper 再通过 `env -i` 设置专用 HOME 和固定 PATH。

## Codex profile

### Coding profile

```text
codex exec --json --sandbox workspace-write --ask-for-approval never -
```

prompt 走 stdin。Codex 在独立 OS 用户自己的 HOME 中登录，不复用主用户
`~/.codex/auth.json`。Codex 的 usage 只有 token 级数据；TaskPilot 显示 token
或“费用未知”，不伪造美元金额。

### Analysis profile

Codex 不进入受限分析层：没有已验证的全工具关闭能力。QA、Architect、Product Lead、
Release Manager、Environment Steward、Tutor 可分别选择 Claude Code、Pi、Grok、OpenCode 1.x；
分析层关闭工具并隔离 hooks、MCP、扩展。Pi / Grok / OpenCode 从主账号原生配置中
仅投影 provider、模型、默认推理设置与所需连接凭据，并复制固定认证 JSON（如有）。
文件保存在 0700 临时目录内且权限为 0600，结束后删除；不加载完整用户配置或
凭据 helper 命令，OpenCode 只允许已审查的 SDK。Claude 保留 restricted 与无工具模式，
仅从原生配置提取白名单中的推理环境变量。模型目录 IPC 只返回名称、ID、provider、
variant 和默认值，不返回认证、endpoint、headers 或配置原文。

## 生命周期

编码 workspace 为独立用户拥有的 baseline archive 导出目录。运行失败、取消或超时后清理；
`ready` 的 workspace 保留到人类 Apply 或丢弃结果，便于再次核对 patch digest。
重启时仍处于执行阶段的状态标为 `coding_interrupted`，不会当成已完成结果。

当前 coding bootstrap 仅支持 macOS。CLI 进程使用独立 POSIX process group，取消 / 超时先发
SIGTERM，再升级 SIGKILL；不要把 CLI sandbox 当作跨平台 OS 隔离替代。

stdout/stderr 规则：

- 关闭 stdin，确保 CLI 读到 EOF；
- JSONL 增量解析，按 `\n` 分帧；
- per-line cap 和 final-result cap，不使用现有 4 MB total stdout cap；
- stderr 只保留有界尾部，并在错误进入日志/UI 前脱敏；
- 不能把 provider auth、token、cookie、key 放入错误 detail。

## 状态和 Actor

现有 `WorkPackageStatus` 继续表达业务流程；Coding run 使用独立状态：

```text
preparing → running → checking → ready → applying → verifying → submitted
                         ├→ failed                       └→ applied（自动流程停止）
                         └→ cancelled
```

Coding Agent 只能触发一个业务流转：`coding_submitted`（`in_progress → in_review`），
条件是补丁已应用、提交前检查没有新的阻塞失败。它仍不得触发 `claim`、
`submit_for_review`、`accepted` 或 QA 的 `review_accepted`。活动记录使用独立的
`coding-agent` 成员标识。

## 审查闭环

1. Coding Agent 产出 patch（第 1 轮由人发起）。
2. 第 1 轮由人按文件勾选并 Apply；被拦截的文件不能勾选，高风险文件需要单独同意。
3. Apply 后以主账号权限运行提交前检查，按 baseline 判定新失败。
4. 检查通过：Coding Agent 提交审查，QA 继续 tool-less 审查 diff 和检查证据。
5. 检查失败或 QA 驳回：把失败输出 / QA 问题交回 Coding Agent 开下一轮，
   起点是领取时的 commit 加上工作区里文件范围内的当前内容（私有 index +
   `commit-tree`，不动 refs、stash 和工作区）。检查失败和 QA 驳回共用 3 轮。
6. 自动轮的补丁不含高风险路径时直接应用；含高风险路径则停下等人。
7. 3 轮用完、人停止或补丁为空时，停在执行页交给人。
8. 人类验收；现有 `git_commit.ts` 负责最终本地 commit，从不 push。

### 已接受的风险

[人工决策-2026-10-12 15:08:39] 自动轮不经人工查看就应用并以主账号权限运行检查。
高风险路径拦截挡住改 scripts、构建配置和 hooks 这类手段，但测试会执行被 import
的普通源码，其中的逻辑会以主账号权限运行。需要强隔离时，应把检查放进容器或 VM。

未来可记录人类和 Coding Agent 的操作序列、tool calls、diff、检查结果、QA
意见和人类修改，供离线评估和路由学习使用；本阶段不做在线自修改。

## 用户需完成的前置步骤

1. 审阅并执行：

   ```bash
   scripts/setup-coding-agent-user.sh
   scripts/setup-coding-agent-user.sh --apply
   ```

2. 在 `taskpilot-coder` 的正常登录会话（或管理员批准的会话）内安装所选 CLI。
   入口固定为 `/Users/taskpilot-coder/.local/bin/claude`、`pi`、`grok`、`codex`、`opencode`。
   允许符号链接，但其最终目标必须是该用户拥有的 HOME 内可执行文件；不允许指向主账号安装路径。
3. 在该账号内使用各 CLI 的正常登录方式或该账号自己的 provider 凭据。不要复制或链接主账号的认证文件。
4. 在 TaskPilot 的「设置 → 模型与智能体」中选择 Coding Agent 的 CLI、模型和思考强度，刷新状态。
   启动仍需要用户在已领取的工作包上明确点击；刷新状态和修改配置不会调用模型。

设置页可以通过 root-owned wrapper 的固定 `model-config <cli> <kind>` 操作读取该账号限定清单中的 CLI 配置文件，解析器只在主进程中读取凭据并生成不含密钥的模型目录元数据。此读取不运行所选 CLI、认证命令、插件或模型；不暴露文件原文；不可用时仍可手动输入模型 ID。wrapper 只允许 HOME 内普通文件、禁止符号链接并限制 4 MiB。

TaskPilot 主账号的 sudoers 仅允许 exact-path root-owned wrapper，不提供通用 shell 或 CLI login 权限。
不要使用 `sudo -u taskpilot-coder codex login` 作为 TaskPilot 授权规则的一部分。

旧的单 Codex wrapper / config 不兼容新的固定 `run <directory> <cli> <model> <thinking>` 协议。
root-owned 配置需要 `RUNTIME_POLICY=taskpilot-coding-cli-v1`。旧策略会报不可用，不退回主账号执行。
管理员应审阅当前 wrapper / bootstrap 后再重新部署；bootstrap 拒绝覆盖现有特权文件，
升级需由管理员在备份并审查后处理旧安装。TaskPilot 不会自行删除或替换这些文件。
