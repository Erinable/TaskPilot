// Startup runs once, while the window opens. Every caller shares the attempt in
// flight or the one that succeeded; a retry starts over only after a failure.
import { logger } from '../infrastructure/logger.ts';
export const createStartupGate = (initialize: () => Promise<void>) => {
  const attempt = () =>
    initialize().catch((error) => {
      logger.error('[startup] initialization failed', error);
      throw error;
    });
  let current = attempt();
  // Handled here so a failure nobody has asked about yet isn't unhandled.
  current.catch(() => {});
  return {
    ready: (retry: boolean) => {
      if (retry) current = current.catch(attempt);
      return current;
    },
  };
};
