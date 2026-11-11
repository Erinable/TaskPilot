# Codex 分析角色支持验证

日期：2026-11-10。分支：`feat/codex-analysis-roles`。

## 行为

所有七个角色均可选择 Codex：Product Lead、Architect、QA、Release Manager、Environment Steward、Tutor 和 Coding Agent。编码通道保留原行为；分析角色通过专用的 `codex exec` 通道调用。

受限分析需要 Codex 0.164.0 或更新的兼容 CLI，状态检测检查版本、严格配置、临时会话、JSON Schema 以及工具控制能力。实测版本为 `codex-cli 0.164.0`；这不是对更早版本的兼容承诺。缺少配置和缓存默认模型时要求填写模型 ID，不猜测模型名称。

分析调用使用临时 cwd、HOME、CODEX_HOME，仅投影推理模型/provider 字段和凭据。用户 MCP、hooks、skills、规则与外部指令不复制；通过固定配置关闭工具开关，并使用权威的单模型目录移除 `apply_patch` 等由模型元数据启用的工具。系统或 macOS 托管配置不能确认隔离时保守拒绝分析，不改变编码模式。没有新增 OS 级沙箱，也不把模型服务的网络请求描述为被禁止。

任务文本通过 stdin，角色系统说明和 JSON Schema 使用0600私有文件，运行采用 ephemeral/read-only/approval never。JSONL 完整终态和用量必须有效，工具、未知 item、截断或后到失败均不能当成成功。token 缓存从输入计数中扣除，未知费用保持未知；失败时已报告用量保留。

凭据刷新只在原始 auth 快照未被外部修改时写回，使用序列化和原子替换，防止覆盖用户刚完成的新登录。保留文件权限，格式错误不把凭据正文写入日志。临时目录在完成或失败后清理。

## 实际 CLI 验证

使用已安装的官方 Codex CLI 0.164.0，创建本机 loopback HTTP provider 和隔离的伪用户配置；凭据为固定测试文本，没有连接真实模型服务。

- 实际请求的模型 ID 为指定的 `gpt-5.4`，reasoning effort 为 `minimal`。
- 捕获到的请求 `tools` 精确为 `[]`；不仅检查启动参数或依赖模型遵守提示。
- 请求包含严格 JSON Schema，CLI 接收测试服务的 Responses SSE 后输出标准 Codex JSONL，TaskPilot 得到 `{ "summary": "Codex analysis works" }`。
- 测试服务报告 input10、cached2、output5；应用记录非缓存输入8、缓存2、输出5，费用保持未知。
- 实际版本探测会伴随临时 helper 目录警告，现通过匹配真实版本行忽略该警告，状态返回 available=true、codex-cli 0.164.0。

临时证据目录：`taskpilot-codex-analysis-validation-wwp56uzz`，包含本机请求、输出与结果。所有数据是测试内容，不含真实令牌或业务材料；本轮没有付费推理调用。

该验证也发现并关闭了单独默认启用的 `request_user_input` 工具，不能仅用 shell 开关推断工具已全部禁用。

## 界面验证

实际 Electron 加载构建产物，使用独立 TASKPILOT_DATA_DIR，通过真实 DOM 选择 Product Lead、QA、Tutor 的 Codex，保存并通过 IPC 回读确认。三角色均显示可用，分析模型目录正常读取；配置测试还覆盖七角色所有受支持思考强度的保存与磁盘重载。

1100×720 深色 renderer 视口没有横向溢出；视口/主题由 CDP 模拟。[代表截图](../assets/screenshots/codex_analysis_roles_dark.png)保存在仓库。操作证据位于系统临时目录 `taskpilot-codex-role-ui-p9dnnbdu` 的 result.json 和 process.log；临时 Electron 与 CDP 均已关闭。没有运行需求规划或模型推理。

## 自动化检查

运行完整套件前的定向验证：Codex 协议与用量96项通过；配置/界面61项通过。最后运行层定向复核7文件164项通过，包含版本警告、schema/stdin、模型与thinking、凭据投影及刷新、取消、超时、输出上限、工具事件即时拒绝、完整终态和错误用量。

最终完整 `npm test -- --reporter=dot`：217文件通过，2033项通过，4项按条件跳过；编码wrapper检查通过。类型、Lint、格式、复杂度、循环依赖和重复代码检查均通过，重复行约0.25%，低于1%门槛。x64 `npm run dist` 通过，包内App的 `codesign --verify --deep --strict` 通过；没有上传、创建Release或推送。

## 参考与边界

- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)：exec、JSONL、ephemeral、JSON Schema。
- [Codex 0.164.0 工具注册源码](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/spec_plan.rs)：shell 与模型声明的补丁工具分别注册。
- [模型目录管理源码](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/models-manager/src/manager.rs)：静态目录保持权威，不通过远端刷新重新添加工具元数据。

本轮验证协议/隔离/界面，没有对真实模型的规划质量、判卷质量或所有provider做收费评测；这些仍受账户、所选模型、CLI版本和模型服务能力影响。受管理的企业环境可能需要管理员确认兼容性，应用不会删除或绕过系统策略。本分支提交不会自动更新已发布的v0.1.1安装包。


## 2026-11-11 环境管家 Schema 兼容修复

新增基础设施提案后，环境管家在实际 Codex 调用中收到：

```text
Invalid schema for response_format 'codex_output_schema':
'schema.properties.configuration.oneOf' is not permitted when strict is true.
```

这是模型开始推理前的 Schema 拒绝。可空配置提案改用 `anyOf`，保留互斥的 null / object 两种分支及现有内容校验。使用当前 Codex 运行配置和实际 Expo + TypeScript 项目再次分析成功，返回「补齐 Expo 项目的提交检查与可复现依赖安装」方案，包含 test、lint、typecheck 和 format；未生成或执行工作包，未修改项目文件。

同时修正诊断链：Codex JSONL 的 error / turn.failed 保留脱敏后的服务端原因，环境管家的失败日志保留该原因和 CLI stderr，页面不再仅显示「智能体运行失败」。回归测试覆盖严格 Schema 的可空分支、原始错误保留、敏感值脱敏及长度限制、后台失败日志和页面提示。完整付费模型评测套件仍未运行。
