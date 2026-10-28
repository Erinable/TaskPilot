// Window startup and full-screen state.
import { event, invoke } from './contract.ts';
import type { Contract } from './contract.ts';

export const appContract = {
  // Calls back with whether the window is full screen, now and on each change.
  onFullScreen: event<boolean>('window:full-screen'),
  // Every other call waits for this: the stores load after the window opens.
  ready: invoke<[retry: boolean], boolean>('startup:ready'),
} satisfies Contract;
