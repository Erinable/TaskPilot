# TaskPilot

TaskPilot 是一个面向程序员的桌面工作台：AI 团队负责需求澄清、架构决策、任务拆解和质量检查，人类开发者负责执行清晰的编码工作包。

## 当前 MVP

- 工作队列：按优先级查看待执行的编码工作包。
- AI 团队动态：查看 Product、Architect、QA 和 Release Agent 的最新活动。
- 工作包详情：展示文件范围、逐步执行指令和验收条件。
- 人类反馈：开始执行或报告设计与代码之间的偏差。

## 本地运行

```bash
npm install
npm start
```

开发模式目前与启动命令相同：

```bash
npm run dev
```

运行基础检查：

```bash
npm test
```

## 技术栈

当前版本使用 Electron、原生 HTML、CSS 和 JavaScript，保持依赖轻量，方便先验证“AI 出工作包、人类执行代码”的核心流程。后续可接入 GitHub、项目文件系统和模型服务，将静态示例替换成真实任务状态。
