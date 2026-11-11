# Environment Steward 真实模型评测

验证环境管家能把缺失的基础设施规划为可执行工作包，同时保留已有脚本与运行安全边界。它评测环境管家本身，不经过 Product Lead。

```bash
npm run eval:env-steward -- --no-judge
npm run eval:env-steward -- --case expo-skeleton --no-judge
npm run eval:env-steward -- --label infrastructure-a
```

这些命令会调用真实模型并产生费用，不在 `npm run test:fast` 内。运行前需要获得费用授权。全部 3 个 case 使用 `--no-judge` 时共 3 次模型调用；默认还会为每个 case 调用一次评审模型，共 6 次。复用共享 eval harness 的 Claude CLI 路由，使用其当前默认模型。结果写入本目录下被 git 忽略的 `reports/`。

| Case | 输入 | 应有行为 |
|---|---|---|
| `expo-skeleton` | 只有 Jest 测试的 Expo + TypeScript 骨架 | 提出类型检查、lint 和只检查不改写的格式检查；工具适配 Expo，不生造 Web 构建 |
| `configured-node` | 已有检查、配置、版本约束、锁文件和 CI | 使用现有脚本，配置工作包为 null，不因偏好迁移工具 |
| `javascript-without-checks` | 只有启动脚本的 JavaScript 项目 | 规划适用的 lint / 格式检查，不要求 TypeScript 或任意覆盖率阈值 |

确定性检查验证：是否应提出配置包、需要的检查类别是否齐全、提议中的脚本是否被错误当成已有脚本执行。输出的路径、脚本名、类别和长度由生产代码的相同校验器检查。评审模型额外看框架适配、完整性与实施可行性。

本评测不安装第三方依赖，不执行生成的配置，也不调用 Coding Agent。发布、去重、仓库变化拦截、高风险确认后等待本机安装，以及继续检查和 QA 的行为由普通回归测试覆盖。类型和单元测试通过不能代替这项真实模型评测。
