# TaskPilot

TaskPilot 是一个面向程序员的桌面工作台：AI 团队负责需求澄清、架构决策、任务拆解和质量检查，人类开发者负责执行清晰的编码工作包。

## 当前 MVP

- 工作队列：按优先级查看从需求发布的编码工作包，以及本周完成数、平均执行时长。
- AI 团队动态：Product Lead、Architect、QA 和你的操作记录，保留 30 天；成员在线状态随 Claude Code CLI 是否可用、是否在运行而变化。
- 工程地图：汇总 Architect 在各需求里读过的模块接口，文件改动后标为可能过时。
- 搜索（⌘K）与通知：搜索工作包、需求和设置页；通知列出等你处理的事项。
- 发布：Release Manager 根据上次发布以来的提交和完成的工作包，起草版本号、更新说明和检查清单；TaskPilot 不打 tag、不提交、不推送。
- 工作包详情：展示文件范围、逐步执行指令和验收条件。
- 人类反馈：开始执行或报告设计与代码之间的偏差。

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

## 技术栈

Electron + electron-vite 构建。主进程和 preload 用 TypeScript，渲染层用 Vue 3、Pinia、Element Plus 和 UnoCSS，测试用 Vitest。主进程、preload 和渲染层之间的 IPC 契约定义在 `src/shared/` 里，三端共用同一份类型。
