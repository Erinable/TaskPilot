// Release Manager channels: milestones, a drafted version, notes and
// checklist, and writing the notes into the workspace. TaskPilot never tags,
// commits or pushes; release:write-notes is the only write.
import fs from 'node:fs/promises';
import path from 'node:path';

import { asAgentError, codedError, failWith, requireString } from '../coded_error.ts';
import * as git from '../git.ts';
import * as workspace from '../workspace.ts';
import { businessDay } from '../activity_log.ts';
import { looksSecret } from '../repo_reader.ts';
import { env as appEnv } from '../env.ts';
import * as presets from '../presets/index.ts';
import { planRelease, throwIfCancelled, RELEASE_MAX_COMMITS } from '../agents/pipeline.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as releaseTypes from '../../shared/ipc/release.ts';
import type { ReleasePackage } from '../agents/pipeline.ts';
import type { AppContext } from '../app_context.ts';
import type { ReleaseStore } from '../release_store.ts';
import type { IpcMainLike } from './handler.ts';

const RECENT_COMMITS = 30;
const MAX_RELEASE_PACKAGES = 50;
const MAX_PACKAGE_TEXT = 500;

const NO_START: releaseTypes.ReleaseStartPoint = { kind: 'none', commit: null, label: null, commitCount: 0, commitsTruncated: false, packageCount: 0 };

const releaseNotesPath = (root: string, requested: string) => {
  if (path.isAbsolute(requested) || path.win32.isAbsolute(requested)) throw codedError('Use a path relative to the workspace', 'path_not_relative', 'path');
  if (!workspace.isInside(root, requested)) throw codedError(`Path is outside the workspace: ${requested}`, 'path_outside_workspace', 'path');
  const relative = path.relative(root, path.resolve(root, requested)).split(path.sep).join('/');
  if (!relative.toLowerCase().endsWith('.md')) throw codedError('Release notes go in a .md file', 'path_not_markdown', 'path');
  if (relative.split('/').some((segment) => segment.toLowerCase() === '.git')) throw codedError('Paths inside .git are refused', 'path_in_git', 'path');
  if (looksSecret(relative)) throw codedError('That path looks like it holds secrets', 'path_secret', 'path');
  return relative;
};

// The last finished release's end commit while it is still in HEAD's
// history, else the newest tag reachable from HEAD, else none.
const findStart = async (root: string, store: ReleaseStore) => {
  const head = await git.resolveCommit(root, 'HEAD');
  if (!head) return null;
  const latest = store.latest();
  if (latest && (await git.isAncestor(root, latest.endCommit, head)))
    return { head, kind: 'release' as const, commit: latest.endCommit, label: latest.version };
  const tag = await git.latestTag(root);
  return tag ? { head, kind: 'tag' as const, commit: tag.commit, label: tag.name } : null;
};

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { backgroundRuns, catalog } = ctx;
  const workPackages = ctx.store;

  const requireReleases = () => {
    if (!ctx.releases) return failWith('Releases are unavailable', 'unsupported');
    return ctx.releases;
  };

  // Done packages no earlier release included, with the text the notes are
  // written from. Recorded per release, so this does not depend on the
  // activity log's retention window.
  const unreleasedPackages = (store: ReleaseStore): ReleasePackage[] => {
    const state = workPackages.all();
    return catalog
      .listTasks()
      .filter((task) => state[task.id]?.status === 'done' && !store.isReleased(task.id))
      .slice(0, MAX_RELEASE_PACKAGES)
      .map((task) => {
        const effective = workPackages.effective(task);
        return {
          id: task.id,
          title: effective.title,
          description: effective.description.slice(0, MAX_PACKAGE_TEXT),
          acceptance: effective.acceptance.map((criterion) => criterion.text.slice(0, MAX_PACKAGE_TEXT)),
        };
      });
  };

  // The start point plus a cheap preview: a capped rev-list count and the
  // package filter a run would use.
  const releaseStartPoint = async (root: string, store: ReleaseStore): Promise<releaseTypes.ReleaseStartPoint> => {
    const found = await findStart(root, store);
    if (!found) return NO_START;
    const counted = await git.countRange(root, found.commit, found.head, { limit: RELEASE_MAX_COMMITS + 1 });
    return {
      kind: found.kind,
      commit: found.commit,
      label: found.label,
      commitCount: Math.min(counted, RELEASE_MAX_COMMITS),
      commitsTruncated: counted > RELEASE_MAX_COMMITS,
      packageCount: unreleasedPackages(store).length,
    };
  };

  // Each milestone with how far its requirements' packages are. Open plans
  // first, nearest target date first; released ones after, newest first.
  const milestoneViews = (store: ReleaseStore): releaseTypes.MilestoneView[] => {
    const state = workPackages.all();
    const packagesOf = (requirementId: string) => catalog.listTasks().filter((task) => task.requirementId === requirementId);
    const views = store.milestones().map((milestone): releaseTypes.MilestoneView => {
      const items = milestone.requirementIds.map((id) => {
        const packages = packagesOf(id);
        return { id, title: ctx.requirementTitle(id), done: packages.filter((task) => state[task.id]?.status === 'done').length, total: packages.length };
      });
      const done = items.reduce((sum, item) => sum + item.done, 0);
      const total = items.reduce((sum, item) => sum + item.total, 0);
      return { ...milestone, requirements: items, done, total, complete: items.length > 0 && total > 0 && done === total };
    });
    const open = views
      .filter((view) => !view.releasedAt)
      .sort((a, b) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999') || a.createdAt.localeCompare(b.createdAt));
    const released = views.filter((view) => view.releasedAt).sort((a, b) => (b.releasedAt as string).localeCompare(a.releasedAt as string));
    return [...open, ...released];
  };
  const knownRequirements = () => new Set((ctx.requirements?.list() ?? []).map((item) => item.id));

  const releaseState = async (): Promise<releaseTypes.ReleaseState> => {
    const store = requireReleases();
    const root = ctx.getConfig().root;
    return {
      configured: Boolean(root),
      draft: store.draft(),
      milestones: milestoneViews(store),
      history: store.history(),
      startPoint: root ? await releaseStartPoint(root, store) : null,
      running: backgroundRuns.has('release', ''),
    };
  };

  ipcMain.handle(
    CHANNELS.milestoneCreate,
    wrap(async (_event, raw): Promise<releaseTypes.ReleaseState> => {
      await requireReleases().createMilestone(raw, knownRequirements());
      return releaseState();
    }),
  );
  ipcMain.handle(
    CHANNELS.milestoneUpdate,
    wrap(async (_event, rawId, raw): Promise<releaseTypes.ReleaseState> => {
      await requireReleases().updateMilestone(requireString(rawId, 'id'), raw, knownRequirements());
      return releaseState();
    }),
  );
  ipcMain.handle(
    CHANNELS.milestoneDelete,
    wrap(async (_event, rawId): Promise<releaseTypes.ReleaseState> => {
      await requireReleases().deleteMilestone(requireString(rawId, 'id'));
      return releaseState();
    }),
  );
  // From a requirement's detail page: plan it into a version, or out of all.
  ipcMain.handle(
    CHANNELS.milestoneAssign,
    wrap(async (_event, rawRequirementId, rawMilestoneId): Promise<releaseTypes.ReleaseState> => {
      const requirementId = requireString(rawRequirementId, 'requirementId');
      if (!knownRequirements().has(requirementId)) failWith('Unknown requirement', 'invalid_argument', 'requirementId');
      const milestoneId = rawMilestoneId === null ? null : requireString(rawMilestoneId, 'milestoneId');
      await requireReleases().assignRequirement(requirementId, milestoneId);
      return releaseState();
    }),
  );

  ipcMain.handle(
    CHANNELS.releaseGet,
    wrap((): Promise<releaseTypes.ReleaseState> => releaseState()),
  );

  ipcMain.handle(
    CHANNELS.releaseRecentCommits,
    wrap(async (): Promise<releaseTypes.ReleaseCommit[]> => {
      requireReleases();
      return git.recentCommits(ctx.requireRoot(), { limit: RECENT_COMMITS });
    }),
  );

  // Where a run starts: the computed start point, or a start commit from the
  // renderer, taken only when it is one of the recent commits, so it cannot
  // name arbitrary refs.
  const chooseStart = async (root: string, store: ReleaseStore, rawStart: unknown) => {
    const point = await findStart(root, store);
    let startCommit = point?.commit ?? null;
    let startLabel = point?.label ?? null;
    if (rawStart !== undefined && rawStart !== null) {
      const requested = requireString(rawStart, 'startCommit');
      if (requested !== startCommit) {
        const recent = (await git.recentCommits(root, { limit: RECENT_COMMITS })).find((commit) => commit.sha === requested);
        if (!recent) return failWith('Pick the start point or one of the recent commits', 'release_bad_start', 'startCommit');
        startCommit = recent.sha;
        startLabel = `${recent.sha.slice(0, 7)} ${recent.subject}`;
      }
    }
    if (!startCommit || !startLabel) return failWith('There is no previous release or tag; pick a start commit', 'release_no_start', 'startCommit');
    return { startCommit, startLabel };
  };

  // Starts Release Manager in the background; the renderer polls release:get.
  ipcMain.handle(
    CHANNELS.releaseGenerate,
    wrap(async (_event, rawStart): Promise<releaseTypes.ReleaseState> => {
      const store = requireReleases();
      const root = ctx.requireRoot();
      const releaseRunner = ctx.runnerFor('release-manager');
      if (backgroundRuns.has('release', '')) failWith('Release Manager is already running', 'release_busy');
      const endCommit = await git.resolveCommit(root, 'HEAD');
      if (!endCommit) return failWith('The repository has no commits', 'release_no_changes');
      const { startCommit, startLabel } = await chooseStart(root, store, rawStart);
      if (startCommit === endCommit) failWith('There are no commits since the start point', 'release_no_changes');

      const packages = unreleasedPackages(store);
      await store.begin({ startCommit, endCommit });
      // A draft has no title of its own; the renderer names it by kind.
      const controller = backgroundRuns.start({ kind: 'release', key: '', busy: 'release', agent: () => 'release-manager', label: () => null });
      const { path: envPath } = await ctx.commandPath();
      // [人工决策-2026-10-25 23:51:35] 版本号按仓库语言的 preset 读取；没有 preset 时退回 package.json，保持原行为（CARM-16 #7、#8）。
      const readVersion = presets.versionReaderOf((await ctx.profile())?.languages.map((language) => language.id) ?? []);
      backgroundRuns.track(
        (async () => {
          let outcome: { result: Awaited<ReturnType<typeof planRelease>> } | { error: unknown };
          try {
            const result = await planRelease({
              root,
              startCommit,
              startLabel,
              endCommit,
              packages,
              readVersion,
              runAgent: releaseRunner,
              envPath,
              signal: controller.signal,
            });
            throwIfCancelled(controller.signal);
            outcome = { result };
          } catch (error) {
            outcome = { error: controller.signal.aborted ? Object.assign(new Error('Release Manager was cancelled'), { code: 'agent_cancelled' }) : error };
          }
          // Drop the run first, so nobody sees a settled draft that still looks cancellable.
          backgroundRuns.finish('release', '', controller);
          if ('error' in outcome) {
            await store.failRun(asAgentError(outcome.error)).catch((error) => console.error('[release] failRun failed', error));
            return;
          }
          const { input, plan, costUsd } = outcome.result;
          const summary: releaseTypes.ReleaseInputSummary = {
            commitCount: input.commits.length,
            commitsTruncated: input.commitsTruncated,
            fileCount: input.files.length,
            filesTruncated: input.filesTruncated,
            packageIds: input.packages.map((item) => item.id),
          };
          await store
            .complete(plan, summary, costUsd)
            .catch((error) => store.failRun(asAgentError(error)).catch((failure) => console.error('[release] failRun failed', failure)));
        })(),
      );
      return releaseState();
    }),
  );

  // The store validates the notes length and the checklist indices.
  ipcMain.handle(
    CHANNELS.releaseUpdateDraft,
    wrap(async (_event, raw): Promise<releaseTypes.ReleaseState> => {
      await requireReleases().update(raw);
      return releaseState();
    }),
  );

  // The store refuses while any checklist item is unticked.
  ipcMain.handle(
    CHANNELS.releaseFinish,
    wrap(async (): Promise<releaseTypes.Release> => {
      const store = requireReleases();
      const draft = store.draft();
      const release = await store.finish({ packageIds: draft?.input?.packageIds ?? [] });
      ctx.record({ kind: 'release_finished', version: release.version, packageCount: release.packageIds.length });
      return release;
    }),
  );

  // Writes the notes into a Markdown file in the workspace: the ready draft's,
  // or else the latest finished release's. The path must be a relative .md
  // path inside the root, outside .git, not secret-looking, in an existing
  // directory that does not resolve outside the root through a symlink.
  // Nothing is staged or committed.
  ipcMain.handle(
    CHANNELS.releaseWriteNotes,
    wrap(async (_event, raw): Promise<releaseTypes.ReleaseWriteResult> => {
      const store = requireReleases();
      const root = ctx.requireRoot();
      const requested = requireString((raw as { path?: unknown } | null | undefined)?.path, 'path').trim();
      const relative = releaseNotesPath(root, requested);

      const draft = store.draft();
      const latest = store.latest();
      const source =
        draft?.status === 'ready' && draft.plan
          ? { version: draft.plan.nextVersion, notes: draft.notesText }
          : latest
            ? { version: latest.version, notes: latest.notesText }
            : null;
      if (!source || !source.notes.trim()) return failWith('There are no release notes to write', 'invalid_state');

      const target = path.join(root, relative);
      let realParent: string;
      try {
        realParent = await fs.realpath(path.dirname(target));
      } catch {
        return failWith(`Directory not found: ${path.posix.dirname(relative)}`, 'invalid_argument', 'path');
      }
      const realRoot = await fs.realpath(root);
      if (realParent !== realRoot && !workspace.isInside(realRoot, realParent))
        failWith('The path leaves the workspace through a link', 'path_outside_workspace', 'path');
      const existing = await fs.lstat(target).catch(() => null);
      if (existing && !existing.isFile()) failWith('The path is not a regular file', 'invalid_argument', 'path');

      const previous = existing ? await fs.readFile(target, 'utf8') : '';
      const day = businessDay(new Date(), appEnv.businessTimeZone);
      const entry = `## ${source.version} — ${day}\n\n${source.notes.trim()}\n`;
      await fs.writeFile(target, previous ? `${entry}\n${previous}` : entry);
      return { path: relative };
    }),
  );

  ipcMain.handle(
    CHANNELS.releaseCancel,
    wrap((): boolean => {
      const controller = backgroundRuns.get('release', '');
      if (!controller) return false;
      controller.abort();
      return true;
    }),
  );
};
