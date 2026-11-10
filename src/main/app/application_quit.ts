// Electron's native Quit call must return before a prevented quit is resumed.
// A Promise callback can reenter native Quit on macOS and leave an app with no
// windows alive in the Dock. Resume from a timer task after draining writes.
import { logger } from '../infrastructure/logger.ts';

type QuitEvent = { preventDefault: () => void };
type QuitDependencies = {
  shutdown: () => Promise<void>;
  flushLogs: () => Promise<void>;
  quit: () => void;
  deadlineMs?: number;
};

export const createQuitHandler = ({ shutdown, flushLogs, quit, deadlineMs = 3000 }: QuitDependencies) => {
  let phase: 'running' | 'draining' | 'ready' = 'running';
  let pending: Promise<void> | undefined;

  const drain = async () => {
    try {
      await shutdown();
    } catch (error) {
      logger.error('[shutdown] could not finish background runs', error);
    }
    try {
      await flushLogs();
    } catch (error) {
      logger.error('[shutdown] could not flush logs', error);
    }
  };

  const beforeQuit = (event: QuitEvent): Promise<void> | undefined => {
    if (phase === 'ready') return;
    // A second native request must not bypass an in-flight write or cancellation.
    event.preventDefault();
    if (pending) return pending;
    phase = 'draining';
    let deadline: ReturnType<typeof setTimeout>;
    const expired = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        logger.error('[shutdown] cleanup deadline exceeded; continuing application quit');
        resolve();
      }, deadlineMs);
    });
    pending = Promise.race([drain(), expired]).then(() => {
      clearTimeout(deadline);
      return new Promise<void>((resolve) => {
        // Do not move this into a .then/finally call to quit: native Quit may
        // still be on the stack while Electron runs the microtask checkpoint.
        setTimeout(() => {
          phase = 'ready';
          quit();
          resolve();
        }, 0);
      });
    });
    return pending;
  };

  return { beforeQuit, isQuitting: () => phase !== 'running' };
};
