// Release Manager flows: state previews, background drafting and writing notes.
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { asAgentError, codedError, failWith } from '../infrastructure/coded_error.ts';
import * as git from '../repository/git.ts';
import * as workspace from '../repository/workspace.ts';
import { businessDay } from '../activity/activity_log.ts';
import { looksSecret } from '../repository/repo_reader.ts';
import { env as appEnv } from '../infrastructure/env.ts';
import * as presets from '../checking/presets/index.ts';
import { planRelease, throwIfCancelled, RELEASE_MAX_COMMITS } from '../agents/pipeline.ts';
import type * as releaseTypes from '../../shared/ipc/release.ts';
import type { ReleasePackage } from '../agents/pipeline.ts';
import type { AppContext } from '../app/app_context.ts';
import type { ReleaseStore } from './release_store.ts';

type ReleaseServiceContext = Pick<
  AppContext,
  | 'backgroundRuns'
  | 'catalog'
  | 'commandPath'
  | 'getConfig'
  | 'profile'
  | 'record'
  | 'releases'
  | 'requireRoot'
  | 'requirementTitle'
  | 'requirements'
  | 'runnerFor'
  | 'store'
>;

const RECENT_COMMITS = 30;
const MAX_RELEASE_PACKAGES = 50;
const MAX_PACKAGE_TEXT = 500;
const NO_START: releaseTypes.ReleaseStartPoint = { kind: 'none', commit: null, label: null, commitCount: 0, commitsTruncated: false, packageCount: 0 };
export interface ReleaseService {
  createMilestone(raw: unknown): Promise<releaseTypes.ReleaseState>;
  updateMilestone(id: string, raw: unknown): Promise<releaseTypes.ReleaseState>;
  deleteMilestone(id: string): Promise<releaseTypes.ReleaseState>;
  assignMilestone(requirementId: string, milestoneId: string | null): Promise<releaseTypes.ReleaseState>;
  getState(): Promise<releaseTypes.ReleaseState>;
  recentCommits(): Promise<releaseTypes.ReleaseCommit[]>;
  generate(startCommit?: string | null): Promise<releaseTypes.ReleaseState>;
  updateDraft(raw: unknown): Promise<releaseTypes.ReleaseState>;
  finish(): Promise<releaseTypes.Release>;
  writeNotes(requested: string): Promise<releaseTypes.ReleaseWriteResult>;
  cancel(): boolean;
}

export const createReleaseService = (ctx: ReleaseServiceContext): ReleaseService => {
  const { backgroundRuns, catalog, store: workPackages } = ctx;
  const requireReleases = () => {
    if (!ctx.releases) return failWith('Releases are unavailable', 'unsupported');
    return ctx.releases;
  };
  const knownRequirements = () => new Set((ctx.requirements?.list() ?? []).map((item) => item.id));
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
  const findStart = async (root: string, store: ReleaseStore) => {
    const head = await git.resolveCommit(root, 'HEAD');
    if (!head) return null;
    const latest = store.latest();
    if (latest && (await git.isAncestor(root, latest.endCommit, head)))
      return { head, kind: 'release' as const, commit: latest.endCommit, label: latest.version };
    const tag = await git.latestTag(root);
    return tag ? { head, kind: 'tag' as const, commit: tag.commit, label: tag.name } : null;
  };
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
  const milestoneViews = (store: ReleaseStore): releaseTypes.MilestoneView[] => {
    const state = workPackages.all();
    const views = store.milestones().map((milestone): releaseTypes.MilestoneView => {
      const items = milestone.requirementIds.map((id) => {
        const packages = catalog.listTasks().filter((task) => task.requirementId === id);
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
  const getState = async (): Promise<releaseTypes.ReleaseState> => {
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
  const recentCommits = async () => {
    requireReleases();
    return git.recentCommits(ctx.requireRoot(), { limit: RECENT_COMMITS });
  };
  const generate = async (rawStart?: string | null): Promise<releaseTypes.ReleaseState> => {
    const store = requireReleases();
    const root = ctx.requireRoot();
    const releaseRunner = ctx.runnerFor('release-manager');
    if (backgroundRuns.has('release', '')) failWith('Release Manager is already running', 'release_busy');
    const endCommit = await git.resolveCommit(root, 'HEAD');
    if (!endCommit) return failWith('The repository has no commits', 'release_no_changes');
    const point = await findStart(root, store);
    let startCommit = point?.commit ?? null;
    let startLabel = point?.label ?? null;
    if (rawStart !== undefined && rawStart !== null && rawStart !== startCommit) {
      const recent = (await git.recentCommits(root, { limit: RECENT_COMMITS })).find((commit) => commit.sha === rawStart);
      if (!recent) return failWith('Pick the start point or one of the recent commits', 'release_bad_start', 'startCommit');
      startCommit = recent.sha;
      startLabel = `${recent.sha.slice(0, 7)} ${recent.subject}`;
    }
    if (!startCommit || !startLabel) return failWith('There is no previous release or tag; pick a start commit', 'release_no_start', 'startCommit');
    if (startCommit === endCommit) failWith('There are no commits since the start point', 'release_no_changes');
    const packages = unreleasedPackages(store);
    await store.begin({ startCommit, endCommit });
    const controller = backgroundRuns.start({ kind: 'release', key: '', busy: 'release', agent: () => 'release-manager', label: () => null });
    const { path: envPath } = await ctx.commandPath();
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
        backgroundRuns.finish('release', '', controller);
        if ('error' in outcome) {
          await store.failRun(asAgentError(outcome.error)).catch((error) => logger.error('[release] failRun failed', error));
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
          .catch((error) => store.failRun(asAgentError(error)).catch((failure) => logger.error('[release] failRun failed', failure)));
      })(),
    );
    return getState();
  };
  const writeNotes = async (requested: string): Promise<releaseTypes.ReleaseWriteResult> => {
    const store = requireReleases();
    const root = ctx.requireRoot();
    if (path.isAbsolute(requested) || path.win32.isAbsolute(requested)) throw codedError('Use a path relative to the workspace', 'path_not_relative', 'path');
    if (!workspace.isInside(root, requested)) throw codedError(`Path is outside the workspace: ${requested}`, 'path_outside_workspace', 'path');
    const relative = path.relative(root, path.resolve(root, requested)).split(path.sep).join('/');
    if (!relative.toLowerCase().endsWith('.md')) throw codedError('Release notes go in a .md file', 'path_not_markdown', 'path');
    if (relative.split('/').some((segment) => segment.toLowerCase() === '.git')) throw codedError('Paths inside .git are refused', 'path_in_git', 'path');
    if (looksSecret(relative)) throw codedError('That path looks like it holds secrets', 'path_secret', 'path');
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
  };
  const finish = async () => {
    const store = requireReleases();
    const draft = store.draft();
    const release = await store.finish({ packageIds: draft?.input?.packageIds ?? [] });
    ctx.record({ kind: 'release_finished', version: release.version, packageCount: release.packageIds.length });
    return release;
  };
  const cancel = () => {
    const controller = backgroundRuns.get('release', '');
    if (!controller) return false;
    controller.abort();
    return true;
  };
  return {
    createMilestone: (raw: unknown) => requireReleases().createMilestone(raw, knownRequirements()).then(getState),
    updateMilestone: (id: string, raw: unknown) => requireReleases().updateMilestone(id, raw, knownRequirements()).then(getState),
    deleteMilestone: (id: string) => requireReleases().deleteMilestone(id).then(getState),
    assignMilestone: (requirementId: string, milestoneId: string | null) => requireReleases().assignRequirement(requirementId, milestoneId).then(getState),
    getState,
    recentCommits,
    generate,
    updateDraft: (raw: unknown) => requireReleases().update(raw).then(getState),
    finish,
    writeNotes,
    cancel,
  };
};
