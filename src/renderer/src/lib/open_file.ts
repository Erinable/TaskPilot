// Opens a workspace file in the developer's editor through the main process,
// which confines the path to the workspace. Failures and the file-manager
// fallback are explained in a toast; nothing here throws.
import { call } from './ipc.ts';
import { describeError } from './errors.ts';
import { showToast } from './feedback.ts';

export const openWorkspaceFile = async (filePath: string, line: number | null = null) => {
  try {
    const openedWith = await call(window.taskpilot.workspace.openFile(filePath, line));
    if (openedWith === 'folder')
      showToast("没找到可用的编辑器，已在文件夹中显示。装好 VS Code 并在命令面板运行「Install 'code' command in PATH」后，可以直接打开到对应行。", 'info');
  } catch (error) {
    console.error('[open-file] failed', error);
    showToast(`打开失败：${describeError(error)}`, 'error');
  }
};
