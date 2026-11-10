# 桌面启动时 CLI 自动发现验证

日期：2026-11-10。分支：`fix/desktop-cli-discovery`。

## 问题与修复

v0.1.0 从 Finder/Dock 启动时通常只有 `/usr/bin:/bin:/usr/sbin:/sbin`。原默认继承模式看不到用户工具；登录 shell 读 PATH 超时后也只退回这四个目录。错误显示为 `spawn claude ENOENT`，用户难以区分未安装、PATH 缺失或 CLI 所需 Node.js 缺失。

本次新增自动检测作为新安装默认值，在固定、本机常见位置查找工具，不运行 shell 启动脚本、不扫描仓库或全盘、不安装工具。保留显式补充目录和继承 PATH 的优先级，再补充已安装目录；NVM、fnm、Volta、asdf、mise 的版本查找有数量限制，真实 Node 版本目录优先于可能依赖原始 HOME 的 shim。登录 shell 失败仍补发现结果，成功和失败均缓存，刷新用代次隔离旧请求。

设置页显示各 CLI 和本机 Node.js 的入口及真实路径；缺 Node 与缺 CLI 分别说明。用户可选择标准名字的可执行文件，或每行添加绝对命令目录。选择后只更新草稿，保存后无需重启，分析、登录检查、普通检查命令和主账号沙箱编码均使用相同路径。旧用户已保存的继承/登录 shell 模式不会被静默改写；可以手动切换自动检测。

同时收窄编码沙箱原有的 home 首级目录推断：加入 `~/.local/bin` 不再开放整个 `~/.local`。只允许实际入口、具体安装目录、选中 Node 版本与需要的 npm 包目录，认证目录及其祖先不可被 PATH 间接放开。独立账号模式保持单独部署。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| 完整 `npm test -- --reporter=dot` | 212 文件通过，1893 项通过，4 项按条件跳过；编码 wrapper 检查通过 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过；仅 ESLint 调度性能提示，无代码告警 |
| `npm run check:complexity` | 通过，无新增或恶化超限函数 |
| `npm run analyze:cycles` | 通过 |
| `npm run analyze:duplicates` | 通过，重复行约 0.25%，低于 1% |
| 新环境页与智能体帮助的 Impeccable 源码扫描 | 无命中 |
| x64 `npm run dist` | 通过，ad-hoc 临时签名，无公证或上传 |

关键回归覆盖：最小 GUI PATH、NVM 默认 alias、失败 shell 缓存、刷新期间旧请求、目录查找上限、符号链接和真实路径去重、Volta/asdf/mise 的真实 Node 优先、`env node` 与绝对 Node shebang 区别、CLI 与 Node 分目录、补充目录预览不保存/保存立即生效、选择文件不执行、非法名称/无执行权限/不安全目录拒绝、草稿复制与陈旧 UI 回包保护。

真实 Seatbelt 回归覆盖：CLI 可从 `.local/bin` 运行并找到 Node，选中版本的运行库可读；OpenCode、Claude、Codex、GitHub 的认证数据和版本管理器其他状态不可读，包含从 bin 指向认证目录的符号链接。

## 打包 App 实际验证

使用独立系统临时目录 `taskpilot-cli-discovery-validation-hwyj83j7`，为子进程设置隔离 HOME 和 `TASKPILOT_DATA_DIR`，不访问真实用户 CLI 配置、仓库或笔记。

- App 从包内可执行文件启动，继承 PATH 仅四个系统目录。
- 测试 CLI 位于隔离用户的 `.local/bin/claude`，首行为 `#!/usr/bin/env node`；Node 位于另一个 `.nvm/versions/node/v24.12.0/bin`。
- 隔离 `.zshrc` 被设置为写标记后等待 30 秒。自动检测启动后未出现该标记，证明没有运行该 shell 文件。
- 实际 `environment:info` 找到 CLI 和 Node，CLI 的 `--version`、`--help` 探测通过，Product Lead 可用；测试 CLI 拒绝任何推理调用，所有记录仅为无模型探测。
- 实际环境设置页在 1100×720 深色 renderer 视口显示长路径、Node 状态和选择入口，没有横向溢出。视口/主题由 CDP 模拟。
- 证据：临时目录中的 `result.json`、`cli-calls.jsonl`、`process.log` 和 `packaged-discovery-dark-1100x720.png`。进程已退出，未启动替代服务器。

## 边界

这是固定位置的发现能力，不保证找到任意自定义安装。非标准目录的 CLI 和 Node 可分别添加。依赖真实 manager 状态的 CLI shim 可能仍需选择真实安装目录，不能为兼容而把整个主目录开放给编码沙箱。

本次处理命令定位与 Node 解释器，不从 shell 文件自动导入密钥或运行其他用户脚本。未调用真实付费模型、修改用户 shell 配置、安装 CLI、推送 PR 或发布新 Release；已发布 v0.1.0 不会自动获得此修复。
