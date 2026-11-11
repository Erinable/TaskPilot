// Course lab repositories: TaskPilot creates one from a set of labs, and adds
// the next stage's lab to the open one. ./labs.ts says what a lab is.
//
// TaskPilot writes and commits every file itself instead of handing a patch
// to Coding Agent: tests/, Makefile and taskpilot.toml are paths a Coding
// Agent patch may not touch (./coding_workspace.ts). tests/build.mk is
// rewritten from the repository's toolchain and every lab's program each
// time a lab is added. Private parts go to the repository's data directory
// before its packages are published, so a claim always finds its reference.
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { failWith } from '../infrastructure/coded_error.ts';
import * as git from '../repository/git.ts';
import * as gitCommit from '../repository/git_commit.ts';
import * as labs from './labs.ts';
import * as courses from './courses.ts';
import { courseText } from './course_file.ts';
import * as labCourse from './lab_course.ts';
import { repositoryId } from '../repository/repositories.ts';
import * as projectConfig from '../repository/project_config.ts';
import { PRESET_IDS } from '../checking/presets/index.ts';
import { buildRules } from '../../shared/lab_toolchains.ts';
import type { LabToolchainId } from '../../shared/lab_toolchains.ts';
import type { AppContext } from '../app/app_context.ts';
import type { RepositoryEntry } from '../repository/repositories.ts';

type LabServiceContext = Pick<
  AppContext,
  'course' | 'coursePlaces' | 'openRepository' | 'record' | 'repositories' | 'requireRoot' | 'requirements' | 'store' | 'validateRoot'
>;

// Every lab of a repository is published under this one requirement.
const LAB_REQUIREMENT_ID = 'course-labs';

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );

const writeFiles = async (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
};

export const createLabService = (ctx: LabServiceContext) => {
  const requireRequirements = () => ctx.requirements ?? failWith('Requirements are unavailable', 'unsupported');

  // Publishes labs in stage order, each waiting for the one before.
  const publish = async (items: { lab: labs.LabArtifact; stage: number }[], previous: string | null, snapshot?: labCourse.LabCourse | null) => {
    const { pack, ref } = snapshot ? await labCourse.trustedLabCourse(ctx.coursePlaces(), snapshot.ref) : await ctx.course();
    let before = previous;
    const definitions = items.map(({ lab, stage }) => {
      const definition = labs.toTaskDefinition(lab, { stage, previous: before, course: ref, requirementId: LAB_REQUIREMENT_ID });
      before = definition.id;
      return definition;
    });
    const text = `课程「${pack.title}」的 lab，由 TaskPilot 写入实验仓库。`;
    const item = await requireRequirements().publishPackages(LAB_REQUIREMENT_ID, { title: '课程 lab', text }, definitions);
    ctx.store.add(definitions);
    ctx.record({ kind: 'requirement_published', requirementId: item.id, title: item.title, packageCount: definitions.length });
    logger.debug(`[labs] published course=${ref.id} packages=${definitions.map((definition) => definition.id).join(',')}`);
    return definitions;
  };

  // The folder the student picked: absolute, empty and not inside a repository.
  const checkFolder = async (root: string) => {
    if (!path.isAbsolute(root)) failWith('The folder must be an absolute path', 'root_not_absolute', 'root');
    const names = await fs.readdir(root).catch(() => failWith(`Directory not found: ${root}`, 'root_not_found', 'root'));
    if (names.length) failWith('Pick an empty folder for the lab repository', 'root_not_empty', 'root');
    if (await git.isRepo(root)) failWith('The folder is inside a git repository', 'root_in_repository', 'root');
  };

  // A new lab repository in `root` with `items` as stages 1, 2, …: written,
  // committed, added to the registry and opened, then its labs published.
  // `beforeOpen` runs once it is registered, while the repository the
  // learner came from is still the open one.
  const createRepository = async ({
    root,
    course,
    courseSnapshot,
    toolchain,
    plan,
    labs: items,
    beforeOpen,
  }: {
    root: string;
    course: string;
    courseSnapshot?: labCourse.LabCourse;
    toolchain: LabToolchainId;
    plan: labs.CoursePlan;
    labs: labs.LabArtifact[];
    beforeOpen?: (entry: RepositoryEntry) => Promise<void>;
  }): Promise<RepositoryEntry> => {
    await checkFolder(root);
    const sourcePlaces = ctx.coursePlaces();
    const places = { ...sourcePlaces, root: null };
    const snapshot = await labCourse.repositoryLabCourse(sourcePlaces, course, courseSnapshot);
    if (plan.course !== course) failWith('plan.course must be the course', 'invalid_lab', 'plan.course');
    if (!items.length) failWith('A lab repository needs at least one lab', 'invalid_lab', 'labs');
    const checked = items.map((lab, index) => ({ lab: labs.checkLab(lab, index + 1), stage: index + 1 }));
    const project = labs.projectText(
      course,
      toolchain,
      checked.map(({ lab, stage }) => labs.labEntry(lab, stage)),
    );
    projectConfig.parseProject(project, PRESET_IDS);
    const files: Record<string, string> = {
      '.gitignore': labs.GITIGNORE,
      Makefile: labs.MAKEFILE,
      [labs.GRADE_SCRIPT_PATH]: labs.GRADE_SCRIPT,
      [labs.BUILD_RULES_PATH]: buildRules(
        toolchain,
        checked.map(({ lab }) => lab),
      ),
      [projectConfig.PROJECT_FILENAME]: project,
      [labs.COURSE_PLAN_PATH]: labs.coursePlanText(plan),
    };
    if (snapshot?.ref.source === 'repository') files[`${courses.COURSES_DIR}/${course}.toml`] = courseText(snapshot.pack);
    for (const { lab, stage } of checked)
      for (const [file, content] of Object.entries(labs.repositoryFiles(lab, stage))) {
        if (file in files) failWith(`${file} is given twice`, 'invalid_lab', 'files');
        files[file] = content;
      }
    // Prepare the entire tree before touching the picked folder or registry.
    // In particular a failed course copy/confirmation must leave the ready
    // draft retryable, with no source pointer or repository switch.
    const destination = await fs.realpath(root);
    const known = ctx.repositories.list().find((entry) => entry.root === destination);
    const destinationId = known?.id ?? repositoryId(destination);
    if (!known && ctx.repositories.get(destinationId)) failWith('The lab repository identity is already in use', 'invalid_state');
    const dataDir = ctx.repositories.dataDir(destinationId);
    if (snapshot?.ref.source === 'repository') await courses.confirmationFor({ ...places, root: destination, dataDir }, snapshot.ref);
    const staging = await fs.mkdtemp(path.join(path.dirname(destination), '.taskpilot-lab-'));
    try {
      await writeFiles(staging, files);
      await gitCommit.initRepository(staging);
      await gitCommit.commitFiles(staging, Object.keys(files), 'TaskPilot: 创建课程实验仓库');
      for (const { lab } of checked) await labs.writePrivate(dataDir, lab.id, lab.private);
      if (snapshot) {
        await labCourse.trustedLabCourse(sourcePlaces, snapshot.ref);
        if (snapshot.ref.source === 'repository') {
          const targetPlaces = { ...places, root: staging, dataDir };
          const copied = await courses.readRepositoryCourse(staging, course);
          labCourse.checkLabCourse(copied.pack, snapshot.ref);
          // Transfer only the exact content already confirmed in the source,
          // using the normal v2 repository trust persistence and version guard.
          await courses.confirm(targetPlaces, copied.pack, copied.ref);
        }
      }
      await checkFolder(destination);
      await fs.rename(staging, destination);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    const entry = await ctx.repositories.add((await ctx.validateRoot(destination)).root);
    logger.debug(`[labs] created repository=${entry.id} course=${course} toolchain=${toolchain} labs=${checked.length}`);
    await beforeOpen?.(entry);
    await ctx.openRepository(entry.id);
    await publish(checked, null, snapshot);
    return entry;
  };

  // Adds the next stage to the open lab repository. Its files are new ones;
  // tests/build.mk is rewritten with every lab's program and taskpilot.toml
  // gets a [[labs]] table appended, so the student's own edits to it stay.
  // A repository from before toolchains has no build rules TaskPilot can
  // write, so it takes no new stage (lab_outdated).
  const addLab = async (artifact: labs.LabArtifact, snapshot?: labCourse.LabCourse) => {
    const root = ctx.requireRoot();
    const text = await projectConfig.readProjectText(root);
    const project = text === null ? null : projectConfig.parseProject(text, PRESET_IDS);
    if (!text || !project?.course || !project.labs.length) return failWith('This repository is not a course lab repository', 'not_lab_repository');
    if (snapshot) await labCourse.repositoryLabCourse(ctx.coursePlaces(), project.course, snapshot);
    const programs = project.labs.flatMap((entry) => (entry.program && entry.sources ? [{ program: entry.program, sources: entry.sources }] : []));
    if (!project.toolchain || programs.length !== project.labs.length)
      return failWith('This lab repository is from before lab toolchains; start a new one', 'lab_outdated');
    const last = project.labs.reduce((latest, lab) => (lab.stage > latest.stage ? lab : latest));
    if (project.labs.some((lab) => lab.id === artifact.id)) failWith(`id: "${artifact.id}" is already a lab here`, 'invalid_lab', 'id');
    if (programs.some((entry) => entry.program === artifact.program))
      failWith(`program: "${artifact.program}" is already a lab's program`, 'invalid_lab', 'program');
    const stage = last.stage + 1;
    const lab = labs.checkLab(artifact, stage);
    const files = labs.repositoryFiles(lab, stage);
    for (const file of Object.keys(files)) if (await exists(path.join(root, file))) failWith(`${file} already exists`, 'invalid_lab', 'files');
    const changed = new Set((await git.status(root)).map((entry) => entry.path));
    for (const file of [projectConfig.PROJECT_FILENAME, labs.BUILD_RULES_PATH])
      if (changed.has(file)) failWith(`${file} has uncommitted changes; commit or undo them first`, 'lab_files_changed', file);
    files[labs.BUILD_RULES_PATH] = buildRules(project.toolchain, [...programs, lab]);
    files[projectConfig.PROJECT_FILENAME] = `${text}${text.endsWith('\n') ? '' : '\n'}\n${labs.labsText([labs.labEntry(lab, stage)])}`;
    projectConfig.parseProject(files[projectConfig.PROJECT_FILENAME], PRESET_IDS);
    await labs.writePrivate(ctx.repositories.dataDir(), lab.id, lab.private);
    await writeFiles(root, files);
    await gitCommit.commitFiles(root, Object.keys(files), `TaskPilot: 加入第 ${stage} 阶段 lab「${lab.title}」`);
    logger.debug(`[labs] added lab=${lab.id} stage=${stage}`);
    return publish([{ lab, stage }], labs.packageId(last.id), snapshot);
  };

  return { createRepository, addLab };
};

export type LabService = ReturnType<typeof createLabService>;
