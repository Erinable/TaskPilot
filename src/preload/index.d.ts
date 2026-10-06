import type { TaskPilotApi } from './index.ts';

declare global {
  interface Window {
    taskpilot: TaskPilotApi;
  }
}
