// Only contract-declared calls reach the renderer; ipcRenderer never does.
import { contextBridge, ipcRenderer } from 'electron';

import { buildApi } from '../shared/ipc/contract.ts';
import { CONTRACTS } from '../shared/ipc/contracts.ts';

// Passed by the main process (BrowserWindow additionalArguments).
const TIME_ZONE_ARG = '--taskpilot-time-zone=';
const timeZoneArg = process.argv.find((arg) => arg.startsWith(TIME_ZONE_ARG));
if (!timeZoneArg) throw new Error('The main process did not pass the business time zone');

const api = { ...buildApi(CONTRACTS, ipcRenderer), businessTimeZone: timeZoneArg.slice(TIME_ZONE_ARG.length) };
contextBridge.exposeInMainWorld('taskpilot', api);
