// The Coding Agent's event stream as the transcript shows it: one block per
// step, so a command reported when it starts and again when it finishes is a
// single row, and the commands between two messages fold into one group.
import type * as codingTypes from '@shared/coding_types.ts';

export type CommandItem = Extract<codingTypes.CodingItem, { kind: 'command' }>;
export type FilesItem = Extract<codingTypes.CodingItem, { kind: 'files' }>;

export type TranscriptBlock =
  | { key: string; kind: 'message'; at: string; text: string }
  | { key: string; kind: 'thinking'; at: string; text: string }
  | { key: string; kind: 'error'; at: string; text: string }
  | { key: string; kind: 'notice'; at: string; text: string }
  | { key: string; kind: 'files'; at: string; item: FilesItem }
  | { key: string; kind: 'commands'; at: string; commands: CommandItem[] }
  // A tool step from a CLI without structured items: its name only.
  | { key: string; kind: 'tool'; at: string; text: string };

// `/bin/zsh -lc 'npm test'` reads as `npm test`.
export const commandLabel = (command: string) => {
  const wrapped = /^\/bin\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (wrapped ? wrapped[2] : command).trim();
};

// Codex reports absolute paths inside its run directory; the project-relative part reads better.
export const fileLabel = (filePath: string) => {
  const run = /\/coding-runs\/[^/]+\/(.+)$/.exec(filePath) ?? /\/TaskPilotRuns\/[^/]+\/(.+)$/.exec(filePath);
  return run ? run[1] : filePath;
};

export const transcriptBlocks = (events: codingTypes.CodingEvent[]): TranscriptBlock[] => {
  const blocks: TranscriptBlock[] = [];
  // Where each structured step is, so a later report replaces the earlier one.
  const placed = new Map<string, { block: TranscriptBlock; index: number }>();
  for (const event of events) {
    const item = event.item;
    const key = `e${event.sequence}`;
    if (item) {
      const seen = placed.get(item.id);
      if (seen && seen.block.kind === 'commands' && item.kind === 'command') {
        seen.block.commands[seen.index] = item;
        continue;
      }
      if (seen && seen.block.kind === 'files' && item.kind === 'files') {
        seen.block.item = item;
        continue;
      }
      if (seen) continue;
      if (item.kind === 'command') {
        const last = blocks.at(-1);
        const group: TranscriptBlock = last?.kind === 'commands' ? last : { key, kind: 'commands', at: event.at, commands: [] };
        if (group !== last) blocks.push(group);
        if (group.kind === 'commands') {
          group.commands.push(item);
          placed.set(item.id, { block: group, index: group.commands.length - 1 });
        }
        continue;
      }
      const block: TranscriptBlock =
        item.kind === 'files' ? { key, kind: 'files', at: event.at, item } : { key, kind: 'notice', at: event.at, text: item.message };
      blocks.push(block);
      placed.set(item.id, { block, index: 0 });
      continue;
    }
    if (event.type === 'text') blocks.push({ key, kind: 'message', at: event.at, text: event.text });
    else if (event.type === 'thinking') blocks.push({ key, kind: 'thinking', at: event.at, text: event.text });
    else if (event.type === 'error') blocks.push({ key, kind: 'error', at: event.at, text: event.text });
    else if (event.type === 'status') blocks.push({ key, kind: 'notice', at: event.at, text: event.text });
    else blocks.push({ key, kind: 'tool', at: event.at, text: event.text });
  }
  return blocks;
};

// "Ran 3 commands" style heading for a group, with how many failed or still run.
export const commandsSummary = (commands: CommandItem[]) => {
  const running = commands.filter((command) => command.status === 'running').length;
  const failed = commands.filter((command) => command.status === 'failed').length;
  const head = running ? `正在运行命令（已完成 ${commands.length - running} / ${commands.length}）` : `运行了 ${commands.length} 条命令`;
  return failed ? `${head}，${failed} 条失败` : head;
};
