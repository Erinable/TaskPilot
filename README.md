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
```

## 技术栈

Electron + electron-vite 构建。主进程和 preload 用 TypeScript，渲染层用 Vue 3、Pinia、Element Plus 和 UnoCSS，测试用 Vitest。主进程、preload 和渲染层之间的 IPC 契约定义在 `src/shared/` 里，三端共用同一份类型。
