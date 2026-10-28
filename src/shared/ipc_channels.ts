// Channel keys are namespace + capitalized method, derived from the wire contracts.
import { channelsOf } from './ipc/contract.ts';
import { CONTRACTS } from './ipc/contracts.ts';

export const CHANNELS = channelsOf(CONTRACTS);

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
