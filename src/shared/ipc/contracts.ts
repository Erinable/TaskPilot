// Every contract table, under the namespace it has on window.taskpilot.
// Domains still written out by hand in src/preload/index.ts move here one at a time.
import { commitContract } from './commit.ts';
import type { ApiOf } from './contract.ts';

export const CONTRACTS = { commit: commitContract };

export type ContractApi = ApiOf<typeof CONTRACTS>;
