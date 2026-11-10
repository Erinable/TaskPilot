import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { CLI_OPTIONS } from '../../shared/agent_runtime.ts';
import { resolveExecutable } from '../repository/workspace.ts';
import { codedError } from '../infrastructure/coded_error.ts';
import type { CliId } from '../../shared/agent_runtime.ts';
import type { RuntimeTool, PickedExecutable } from '../../shared/ipc/settings.ts';

export const RUNTIME_TOOL_IDS = [...CLI_OPTIONS.map((entry) => entry.id), 'node'] as const;
const toolLabel = (id: CliId | 'node') => (id === 'node' ? 'Node.js（供本机 CLI 使用）' : CLI_OPTIONS.find((entry) => entry.id === id)!.label);

export const needsNode = async (file: string): Promise<boolean> => {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(256);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const line = header.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    // An absolute Node shebang names its own interpreter; only env-based
    // launchers depend on finding another node executable through PATH.
    return /^#!\s*\S*\/env\s+(?:-S\s+)?node(?:\s|$)/.test(line);
  } finally {
    await handle.close();
  }
};

// A filesystem inventory only: no login, model call or executable launch.
export const runtimeTools = async (envPath: string): Promise<RuntimeTool[]> => {
  const node = await resolveExecutable('node', { envPath });
  return Promise.all(
    RUNTIME_TOOL_IDS.map(async (id): Promise<RuntimeTool> => {
      const found = id === 'node' ? node : await resolveExecutable(id, { envPath });
      if (!found)
        return {
          id,
          label: toolLabel(id),
          path: null,
          realPath: null,
          requiresNode: false,
          problem: '未在当前命令目录中找到。已安装时可选择可执行文件，或添加工具所在目录。',
        };
      try {
        const requiresNode = id !== 'node' && (await needsNode(found));
        return {
          id,
          label: toolLabel(id),
          path: found,
          realPath: await fs.realpath(found),
          requiresNode,
          problem:
            requiresNode && !node ? '已找到 CLI，但它需要本机 Node.js。请选择 node 可执行文件或添加对应的 bin 目录；应用内置的 Node.js 不能代替它。' : null,
        };
      } catch {
        return {
          id,
          label: toolLabel(id),
          path: found,
          realPath: null,
          requiresNode: false,
          problem: '找到了入口，但无法读取。请检查文件权限或重新选择有效安装。',
        };
      }
    }),
  );
};

export const nodeRuntimeProblem = async (command: string, envPath?: string): Promise<string | null> => {
  const executable = await resolveExecutable(command, { envPath });
  if (!executable || !(await needsNode(executable)) || (await resolveExecutable('node', { envPath }))) return null;
  return `已找到 ${command}（${executable}），但缺少它依赖的 Node.js。请在「运行环境」添加 node 所在目录，保存后重新检测。`;
};

export const selectedExecutable = async (tool: CliId | 'node', file: string): Promise<PickedExecutable> => {
  const expected: string[] = process.platform === 'win32' ? [tool, `${tool}.exe`, `${tool}.cmd`, `${tool}.bat`] : [tool];
  if (!path.isAbsolute(file) || !expected.includes(path.basename(file)))
    throw codedError(`请选择名为 ${tool} 的可执行文件；若输入命令请先去掉参数。`, 'invalid_argument');
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) throw new Error('not a file');
    await fs.access(file, constants.X_OK);
    return { path: file, directory: path.dirname(file) };
  } catch {
    throw codedError('所选文件不存在或没有执行权限，请选择已经安装的 CLI 或 Node.js。', 'invalid_argument');
  }
};
