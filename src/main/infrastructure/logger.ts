import { appendFile, chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LoggerOptions = { level?: LogLevel; sink?: (level: LogLevel, values: unknown[]) => void };

// At startup a log past this size moves to taskpilot.log.1, the older ones to
// .2 and .3, and the oldest is dropped, so the folder stays bounded.
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const KEPT_LOGS = 3;

const rotate = async (file: string) => {
  const size = await stat(file).then(
    (info) => info.size,
    () => 0,
  );
  if (size <= MAX_LOG_BYTES) return;
  await rm(`${file}.${KEPT_LOGS}`, { force: true });
  for (let index = KEPT_LOGS - 1; index >= 1; index -= 1) {
    await rename(`${file}.${index}`, `${file}.${index + 1}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await rename(file, `${file}.1`);
  await chmod(`${file}.1`, 0o600);
};

const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const fallbackSink = (level: LogLevel, values: unknown[]) => {
  if (level === 'warn' || level === 'error') {
    try {
      process.stderr.write(`[${level}] ${values.map(serialize).join(' ')}\n`);
    } catch {
      // Logging must never escape.
    }
  }
};

const serialize = (value: unknown): string => {
  try {
    if (typeof value === 'string') return value;
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint') return `${item}n`;
        if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
          if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack, code: (item as Error & { code?: unknown }).code };
        }
        return item;
      }) ?? String(value)
    );
  } catch {
    return '[Unserializable]';
  }
};

class Logger {
  private level: LogLevel = 'info';
  private sink = fallbackSink;
  private file: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private reportingFailure = false;

  configure(options: LoggerOptions = {}) {
    if (options.level) this.level = options.level;
    if (options.sink) this.sink = options.sink;
  }

  initialize(directory: string, options: LoggerOptions = {}): Promise<void> {
    this.configure(options);
    return (async () => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        this.file = path.join(directory, 'taskpilot.log');
        // A failed rotation is reported and logging goes on in the same file.
        await rotate(this.file).catch((error) => this.fail(error));
        const handle = await open(this.file, 'a', 0o600);
        await handle.close();
        await chmod(this.file, 0o600);
      } catch (error) {
        this.file = null;
        this.fail(error);
      }
    })();
  }

  log(level: LogLevel, ...values: unknown[]) {
    if (weights[level] < weights[this.level]) return;
    try {
      this.sink(level, values);
    } catch {
      // Injected sinks are untrusted.
    }
    const file = this.file;
    if (!file) return;
    const line = `${new Date().toISOString()} [${level}] ${values.map((value) => serialize(value)).join(' ')}\n`;
    this.chain = this.chain
      .then(() => appendFile(file, line, { mode: 0o600 }))
      .catch((error) => {
        this.fail(error);
      });
  }
  debug(...values: unknown[]) {
    this.log('debug', ...values);
  }
  info(...values: unknown[]) {
    this.log('info', ...values);
  }
  warn(...values: unknown[]) {
    this.log('warn', ...values);
  }
  error(...values: unknown[]) {
    this.log('error', ...values);
  }
  async flush() {
    await this.chain;
  }
  private fail(error: unknown) {
    if (this.reportingFailure) return;
    this.reportingFailure = true;
    try {
      fallbackSink('error', ['log write failed', error]);
    } finally {
      this.reportingFailure = false;
    }
  }
}

export const logger = new Logger();
export const initializeLogging = (directory: string, options?: LoggerOptions) => logger.initialize(directory, options);
export const flushLogs = () => logger.flush();
export const createLogger = (options?: LoggerOptions) => {
  const instance = new Logger();
  instance.configure(options);
  return instance;
};
