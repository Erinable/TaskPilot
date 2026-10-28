// Every renderer namespace and its complete wire contract.
import { commitContract } from './commit.ts';
import { appContract } from './app.ts';
import { tasksContract, packagesContract, reviewContract, deviationContract, practiceContract } from './packages.ts';
import { workspaceContract, diffContract, verifyContract } from './workspace.ts';
import { preferencesContract, environmentContract, dataContract, agentContract } from './settings.ts';
import { requirementsContract } from './requirements.ts';
import { codingContract } from './coding.ts';
import { activityContract, costsContract, engineeringMapContract } from './activity.ts';
import { envContract } from './environment.ts';
import { releaseContract } from './release.ts';
import { repositoriesContract } from './repositories.ts';
import { tutorContract } from './tutor.ts';
import { notesContract } from './notes.ts';
import { masteryContract } from './mastery.ts';
import { coursesContract } from './courses.ts';
import { stateContract } from './state.ts';
import type { ApiOf } from './contract.ts';

export const CONTRACTS = {
  commit: commitContract,
  app: appContract,
  tasks: tasksContract,
  packages: packagesContract,
  review: reviewContract,
  deviation: deviationContract,
  practice: practiceContract,
  workspace: workspaceContract,
  diff: diffContract,
  verify: verifyContract,
  preferences: preferencesContract,
  environment: environmentContract,
  data: dataContract,
  agent: agentContract,
  requirements: requirementsContract,
  coding: codingContract,
  activity: activityContract,
  costs: costsContract,
  engineeringMap: engineeringMapContract,
  env: envContract,
  release: releaseContract,
  repositories: repositoriesContract,
  tutor: tutorContract,
  notes: notesContract,
  mastery: masteryContract,
  courses: coursesContract,
  state: stateContract,
};

export type ContractApi = ApiOf<typeof CONTRACTS>;
