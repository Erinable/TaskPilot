import type { ContractApi } from '../shared/ipc/contracts.ts';

export type TaskPilotApi = ContractApi & { businessTimeZone: string };

declare global {
  interface Window {
    taskpilot: TaskPilotApi;
  }
}
