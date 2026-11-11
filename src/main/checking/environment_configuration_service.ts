// Environment Steward proposals enter the normal work queue. This service
// publishes definitions only: Coding Agent, QA and the developer still own
// execution, high-risk confirmation, acceptance and the git commit.
import { createHash } from 'node:crypto';

import { failWith } from '../infrastructure/coded_error.ts';
import { indexEntries } from '../repository/repo_reader.ts';
import * as git from '../repository/git.ts';
import * as presets from './presets/index.ts';
import { buildProfile } from '../repository/project_profile.ts';
import type { AppContext } from '../app/app_context.ts';
import type { TaskDefinition } from '../work_packages/tasks.ts';
import type { EnvConfiguration, EnvConfigurationPackage, EnvPlan } from '../../shared/ipc/environment.ts';

// [人工决策-2026-11-11 11:54:19] 环境管家负责规划配置，由普通工作包交给 Coding Agent 实施，复用确认、QA 和提交流程（方案 A）。
const REQUIREMENT_ID = 'environment-setup';
type ServiceContext = Pick<
  AppContext,
  'catalog' | 'store' | 'requirements' | 'requireRoot' | 'record' | 'changed' | 'backgroundRuns' | 'getConfig' | 'resolveSteps' | 'commandPath'
>;

// The model reads index blobs, so an index edit invalidates its plan just as a
// new commit does, even when HEAD has not changed.
export const environmentRevision = async (root: string): Promise<string> => {
  const [commit, entries] = await Promise.all([git.head(root), indexEntries(root)]);
  const blobs = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([file, entry]) => [file, entry.sha, entry.mode]);
  return createHash('sha256')
    .update(JSON.stringify([commit, blobs]))
    .digest('hex');
};

const definition = (proposal: EnvConfiguration, revision: string): TaskDefinition => {
  const digest = createHash('sha256')
    .update(JSON.stringify([revision, proposal]))
    .digest('hex')
    .slice(0, 20);
  return {
    id: `env-setup-${digest}`,
    status: 'pending',
    requirementId: REQUIREMENT_ID,
    title: proposal.title,
    description: proposal.reason,
    intro: '环境管家规划的基础设施配置。按下面的步骤完成，改到项目配置时先确认，再提交 QA 审查。',
    module: 'infrastructure',
    tags: ['环境配置'],
    priority: 'high',
    estimate: '约 1 小时',
    estimateHours: 1,
    icon: 'wand',
    difficulty: { level: 'easy', reason: '在现有项目里补齐基础设施配置。' },
    recommendedMode: { mode: 'ai', reason: '按环境管家的方案补齐工具和检查配置。' },
    steps: [...proposal.steps],
    fileScope: [...proposal.fileScope],
    acceptance: proposal.acceptance.map((text) => ({ text })),
    environment: { revision },
  };
};

export const createEnvironmentConfigurationService = (ctx: ServiceContext) => {
  let creating: Promise<EnvConfigurationPackage> | null = null;

  const packages = () => ctx.catalog.listTasks().filter((task) => task.requirementId === REQUIREMENT_ID && task.environment);
  const active = () => [...packages()].reverse().find((task) => ctx.store.get(task.id).status !== 'done');

  const describe = async (task: TaskDefinition, root: string): Promise<EnvConfigurationPackage> => {
    const state = ctx.store.get(task.id);
    const status = state.status;
    const changes = status === 'done' ? await git.status(root) : [];
    return {
      id: task.id,
      title: task.title,
      status,
      installPending: state.codingRun?.halt === 'setup_required',
      needsCommit: changes.some((change) => task.fileScope.includes(change.path)),
    };
  };

  const current = async (): Promise<EnvConfigurationPackage | null> => {
    const task = active() ?? packages().at(-1);
    return task ? describe(task, ctx.requireRoot()) : null;
  };

  const create = (proposal: EnvConfiguration, revision: string): Promise<EnvConfigurationPackage> => {
    if (creating) return creating;
    const root = ctx.requireRoot();
    const requirements = ctx.requirements ?? failWith('Requirements are unavailable', 'unsupported');
    const work = ctx.backgroundRuns.run(
      { kind: 'environment', key: 'configuration', busy: 'environment', label: () => '生成环境配置工作包' },
      async (controller) => {
        if ((await environmentRevision(root)) !== revision || ctx.requireRoot() !== root || controller.signal.aborted)
          failWith('The repository changed since this environment plan was made', 'env_stale');
        // Reuse an unfinished package even after a re-analysis. The user opens
        // that package to finish or adjust it rather than accumulating duplicates.
        const previous = active();
        if (previous) return describe(previous, root);
        const task = definition(proposal, revision);
        const known = ctx.catalog.getTask(task.id);
        if (known) return describe(known, root);
        const item = await requirements.publishPackages(
          REQUIREMENT_ID,
          { title: '项目基础设施配置', text: '由环境管家分析仓库后提出，交给 Coding Agent 实施的基础设施配置。' },
          [task],
        );
        ctx.store.add([task]);
        ctx.record({ kind: 'requirement_published', requirementId: item.id, title: item.title, packageCount: 1 });
        ctx.changed('requirements', 'packages', 'environment');
        return describe(task, root);
      },
    );
    creating = work;
    void work
      .finally(() => {
        if (creating === work) creating = null;
      })
      .catch(() => {});
    return work;
  };

  const waitingForInstall = () => {
    const task = active();
    return task && ctx.store.get(task.id).codingRun?.halt === 'setup_required' ? task.id : null;
  };

  // Recovery never reuses model choices. Only the adapter's fixed install is
  // offered; scripts and lifecycle permission require a fresh explicit analysis.
  const restoreInstall = async (packageId: string) => {
    const root = ctx.requireRoot();
    const config = ctx.getConfig();
    const revision = await environmentRevision(root);
    const resolution = await ctx.resolveSteps(config);
    const setup = presets.setupOf(buildProfile(resolution).languages.map((language) => language.id));
    if (!setup) failWith('This repository has no setup adapter', 'env_blocked');
    const facts = await setup.probe(root, { envPath: (await ctx.commandPath()).path });
    if (ctx.requireRoot() !== root || waitingForInstall() !== packageId || (await environmentRevision(root)) !== revision)
      failWith('The repository changed while restoring local installation', 'env_stale');
    const plan: EnvPlan = {
      summary: '配置工作包已更新依赖，请先在本机安装，再回到工作包继续检查。',
      install: setup.configurationInstallMode,
      installReason: '从待安装的配置工作包恢复固定安装步骤，不运行依赖安装脚本。',
      scripts: {},
      issues: [],
      adjustments: [],
      configuration: null,
    };
    return { root, revision, setup, facts, blockers: setup.blockers(facts), plan };
  };
  return { current, create, waitingForInstall, restoreInstall };
};
