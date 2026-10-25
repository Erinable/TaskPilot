// Coding Agent channels: rounds, their events and patch, apply and resume.
// The loop itself is ../coding_service.ts.
import { failWith, requireString } from '../coded_error.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as codingTypes from '../../shared/coding_types.ts';
import type * as packageTypes from '../../shared/ipc/packages.ts';
import type { AppContext } from '../app_context.ts';
import type { CodingRuntime } from '../coding_runtime.ts';
import type { CodingService } from '../coding_service.ts';
import type { IpcMainLike } from './handler.ts';

// The renderer's choices for conflicted files, checked at the boundary.
const RESOLUTIONS: codingTypes.CodingResolution[] = ['markers', 'mine', 'theirs'];
const codingResolutions = (raw: unknown): Partial<Record<string, codingTypes.CodingResolution>> => {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) failWith('resolutions must be an object', 'invalid_argument', 'resolutions');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.some(([, value]) => !RESOLUTIONS.includes(value as codingTypes.CodingResolution)))
    failWith('Unknown conflict resolution', 'invalid_argument', 'resolutions');
  return Object.fromEntries(entries) as Partial<Record<string, codingTypes.CodingResolution>>;
};

export const register = (ipcMain: IpcMainLike, ctx: AppContext, { coding, runtime }: { coding: CodingService; runtime: CodingRuntime }) => {
  ipcMain.handle(
    CHANNELS.codingStatus,
    wrap(() => runtime.codingStatus()),
  );
  ipcMain.handle(
    CHANNELS.codingStart,
    wrap((_event, rawId, rawInput): Promise<packageTypes.TaskView> => {
      const id = requireString(rawId, 'id');
      const input = rawInput as { instruction?: unknown } | null | undefined;
      const instruction = requireString(input?.instruction, 'instruction').trim();
      if (instruction.length > 20_000) failWith('Instruction is too long', 'invalid_argument', 'instruction');
      return coding.start(id, instruction);
    }),
  );
  ipcMain.handle(
    CHANNELS.codingGet,
    wrap((_event, rawId): packageTypes.TaskView => {
      const id = requireString(rawId, 'id');
      return ctx.viewOf(ctx.requireTask(id), ctx.store.get(id));
    }),
  );
  ipcMain.handle(
    CHANNELS.codingEvents,
    wrap((_event, rawId, rawAfter): codingTypes.CodingEventPage => {
      const id = requireString(rawId, 'id');
      coding.codingRunOf(id);
      if (!Number.isInteger(rawAfter) || (rawAfter as number) < -1) failWith('after must be a non-negative sequence or -1', 'invalid_argument', 'after');
      return coding.events(id, rawAfter as number);
    }),
  );
  ipcMain.handle(
    CHANNELS.codingCancel,
    wrap((_event, rawId): Promise<boolean> => coding.cancel(requireString(rawId, 'id'))),
  );
  // The packages with a round or its checks in flight, for the app-wide
  // indicator. Read from memory, so it is cheap to poll.
  ipcMain.handle(
    CHANNELS.codingActive,
    wrap((): codingTypes.CodingActiveRun[] => coding.activeRuns()),
  );
  ipcMain.handle(
    CHANNELS.codingPatch,
    wrap((_event, rawId): Promise<codingTypes.CodingPatchPreview> => coding.patch(requireString(rawId, 'id'))),
  );
  ipcMain.handle(
    CHANNELS.codingApply,
    wrap((_event, rawId, rawInput): Promise<codingTypes.CodingApplyResult> => {
      const id = requireString(rawId, 'id');
      const input = rawInput as { digest?: unknown; allowHighRisk?: unknown; files?: unknown; resolutions?: unknown } | null | undefined;
      const digest = requireString(input?.digest, 'digest');
      if (input?.allowHighRisk !== true && input?.allowHighRisk !== false) failWith('allowHighRisk must be boolean', 'invalid_argument', 'allowHighRisk');
      const files = input.files;
      if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string'))
        failWith('files must be a non-empty list of paths', 'invalid_argument', 'files');
      const resolutions = codingResolutions(input.resolutions);
      return coding.apply(id, { digest, allowHighRisk: input.allowHighRisk, files: files as string[], resolutions });
    }),
  );
  ipcMain.handle(
    CHANNELS.codingResume,
    wrap((_event, rawId): Promise<packageTypes.TaskView> => coding.resume(requireString(rawId, 'id'))),
  );
};
