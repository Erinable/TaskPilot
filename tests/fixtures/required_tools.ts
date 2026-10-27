// Whether the external tools an end-to-end test drives are on the PATH. A
// developer machine without them skips the test; CI installs them, so there a
// missing tool fails the test file instead of skipping it silently.
import * as workspace from '../../src/main/workspace.ts';
import { env } from '../../src/main/env.ts';

export const hasTools = async (...tools: string[]) => {
  const missing = (await Promise.all(tools.map(async (tool) => ((await workspace.resolveExecutable(tool, { envPath: env.path })) ? null : tool)))).filter(
    (tool) => tool !== null,
  );
  if (missing.length && process.env.CI) throw new Error(`CI must install ${missing.join(', ')} for this test file`);
  return missing.length === 0;
};
