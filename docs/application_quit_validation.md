# macOS 一次退出验证

日期：2026-11-10。分支：`fix/application-quit`，基于 v0.1.1 的 main，独立于 Codex 分析角色分支。

## 根因

原 `before-quit` 拦截第一次退出以完成后台取消和写入，然后在 Promise 的 `finally` 微任务内直接再次 `app.quit()`。Electron 在 macOS 的部分原生退出入口中，会在该微任务运行后才处理外层被取消的 native Quit 返回值。内外层退出状态互相覆盖，导致窗口已关闭但主进程还在，第二次操作才完全退出。

这与 [Electron #55208](https://github.com/electron/electron/issues/55208) 的症状和触发方式一致。当前 Electron 40.10.6 的 [Browser::Quit 源码](https://github.com/electron/electron/blob/v40.10.6/shell/browser/browser.cc)同样在返回 `HandleBeforeQuit()` 后更新退出标记。系统 Quit AppleEvent 不一定复现该时序，因此不能仅凭 AppleEvent 成功判断菜单/快捷键路径无问题。

## 修复

- 独立退出协调器明确区分运行、清理中、允许退出三阶段。
- 完成清理后通过下一次 timer task 恢复正常 `app.quit()`，让被取消的原生 Quit 先完整返回；不使用 `app.exit()` 或 `process.exit()`绕过正常生命周期。
- 清理中重复退出仍被拦截，共享一次取消/落盘，不允许第二次请求提前绕过写入。
- 原来的3秒退出上界覆盖整个后台取消和日志 flush，日志挂起也不会无限阻塞退出；成功后清除截止定时器。
- 启动页收到退出时等待已开始的初始化，再清理已创建的 stores；退出中不因 activate 重新创建窗口。
- macOS 的红色关窗按钮仍仅关闭窗口，保留原平台习惯。本修复针对真正的退出操作，不把关窗与退出混为一谈。

## 实际进程验证

使用已发布 v0.1.1 的包内二进制和本机 Electron 40.10.6 加载修复后的构建，均传入独立 `TASKPILOT_DATA_DIR`。测试仅发送给自己启动的确切 PID，不按应用名字批量结束用户进程。

- 旧包：一次 SIGTERM 触发原生退出后，6秒仍无父进程 exit；CDP page 数已为0。第二次 SIGTERM 才结束，成功复现“只关窗口、应用仍在”。
- 修复构建：相同原生退出入口第一次即退出，父进程收到正常结束，约268毫秒，不需第二次操作。
- 修复构建的 NSRunningApplication/AppleEvent 正常系统退出路径也一次结束，约792毫秒，未因修复改变为强制进程终止。
- 旧包通过 NSRunningApplication 的 AppleEvent 路径一次约668毫秒退出，与上游说明的入口差异一致；该结果不用于否定菜单/快捷键问题。

临时证据位于系统目录 `taskpilot-quit-validation-3f7c93ii`，保存每次启动的结果JSON、隔离profile与进程日志。所有临时应用进程均在验证结束后关闭，未访问真实业务数据或调用模型。

## 自动化回归

7项 focused 回归通过，覆盖清理/日志顺序、微任务中不重入Quit、下一timer恢复、重复请求、后台取消失败、日志失败、后台与日志各自挂起的总deadline，以及清理结束到恢复timer之间的再次退出。假时钟驱动期限，断言正常完成无遗留timer。

完整 `npm test -- --reporter=dot`：213个文件通过，1900项通过，4项按条件跳过；编码wrapper检查通过。类型、Lint、格式、构建和函数复杂度检查通过。本轮没有升级Electron、修改用户配置、发布安装包或合并其他分支。
