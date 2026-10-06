// The engineering map: Architect's module summaries from every requirement,
// merged by file path, beside the repository's tracked file tree.
//
// Nothing here calls a model. A module is only as current as the requirement
// that last summarized it, so each one carries the blob it was read at and is
// marked stale once the file has changed in the index since.
//
// [人工决策-2026-10-06 15:10:42] 工程地图只汇总已有需求里 Architect 的摘要 + 已跟踪文件树，不额外调用模型生成全仓地图。
import type * as ipc from '../shared/ipc_types.ts';
import type { Requirement } from './requirement_store.ts';
import type { IndexEntry } from './repo_reader.ts';

// Tracked paths sent to the renderer; deeper repositories are cut off and say so.
export const MAX_TREE_FILES = 5000;

export const buildEngineeringMap = (requirements: Requirement[], index: Map<string, IndexEntry> | null, paths: string[]): ipc.EngineeringMap => {
  // Oldest first, so a later summary of the same file replaces an earlier one.
  const ordered = [...requirements].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const modules = new Map<string, ipc.MapModule>();
  const conventions = new Map<string, ipc.MapNote>();
  const gaps = new Map<string, ipc.MapNote>();
  for (const requirement of ordered) {
    const interfaces = requirement.interfaces;
    if (!interfaces?.summary) continue;
    const source = { requirementId: requirement.id, title: requirement.title || requirement.text.slice(0, 40), at: requirement.updatedAt };
    const readShas = new Map(interfaces.read.map((file) => [file.path, file.sha]));
    for (const module of interfaces.summary.modules) {
      const readSha = readShas.get(module.path) ?? null;
      const currentSha = index?.get(module.path)?.sha ?? null;
      modules.set(module.path, {
        ...module,
        source,
        // Unknown without a workspace or a recorded blob; never claimed stale then.
        freshness: !index || !readSha ? 'unknown' : !currentSha ? 'removed' : currentSha === readSha ? 'current' : 'stale',
      });
    }
    for (const text of interfaces.summary.conventions) conventions.set(text, { text, source });
    for (const text of interfaces.summary.gaps) gaps.set(text, { text, source });
  }
  return {
    modules: [...modules.values()].sort((a, b) => a.path.localeCompare(b.path)),
    conventions: [...conventions.values()],
    gaps: [...gaps.values()],
    files: paths.slice(0, MAX_TREE_FILES),
    truncated: paths.length > MAX_TREE_FILES,
  };
};
