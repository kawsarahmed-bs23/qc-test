type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const isDebugEnabled = (): boolean => process.env.DEBUG_LOGS === 'true';

function write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  if (level === 'debug' && !isDebugEnabled()) return;

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  const args = meta === undefined ? [line] : [line, meta];

  switch (level) {
    case 'error':
      console.error(...args);
      break;
    case 'warn':
      console.warn(...args);
      break;
    default:
      console.log(...args);
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Creates a logger whose lines are prefixed with the given scope (e.g. a page or helper name). */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => write('debug', scope, message, meta),
    info: (message, meta) => write('info', scope, message, meta),
    warn: (message, meta) => write('warn', scope, message, meta),
    error: (message, meta) => write('error', scope, message, meta),
  };
}

export const logger = createLogger('framework');
