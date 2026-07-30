import { env, isProduction } from '@/lib/env';
import { isAppError } from '@/server/errors';

/**
 * Structured logging.
 *
 * This is deliberately a small module rather than a logging library. What the
 * application needs is JSON lines with consistent fields, level filtering, child
 * loggers that carry context, and — the part that actually matters here — redaction.
 *
 * Inboxly handles people's mail. Subjects, bodies, snippets, and addresses must never
 * reach the logs, and "remember not to log that" is not a control. `REDACTED_KEYS`
 * makes it structural: anything named like message content or a credential is replaced
 * before serialization, at any depth.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Credentials. Matched by substring, because a credential is never safe to log under
 * any name: `token` catches `refreshToken`, `refresh_token`, and
 * `googleRefreshTokenCiphertext` alike. Over-matching here costs nothing.
 */
const SECRET_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'ciphertext',
  'codeverifier',
  'code_verifier',
];

/**
 * Message content and personal data. Matched by exact key name rather than substring,
 * because the useful half of a log line is the identifiers: `emailId` and `emailCount`
 * must survive while `email` and `fromEmail` do not. Substring matching on "email"
 * would redact both and leave the log saying nothing.
 */
const CONTENT_KEYS = new Set([
  'subject',
  'snippet',
  'body',
  'bodytext',
  'summary',
  'suggestedreply',
  'rawresponse',
  'actionitems',
  'email',
  'emails',
  'useremail',
  'fromemail',
  'fromname',
  'toemails',
  'ccemails',
  'replyto',
  'gmailaddress',
  'avatarurl',
]);

const REDACTED = '[redacted]';

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
  /** Returns a logger that adds `bindings` to every record it writes. */
  child(bindings: LogContext): Logger;
}

function shouldRedact(key: string): boolean {
  const normalised = key.toLowerCase();
  return (
    CONTENT_KEYS.has(normalised) ||
    SECRET_SUBSTRINGS.some((needle) => normalised.includes(needle))
  );
}

/** Recursively replaces sensitive values. Depth-limited so a cycle cannot hang a log call. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max depth]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = shouldRedact(key) ? REDACTED : redact(entry, depth + 1);
  }
  return result;
}

/**
 * Errors are serialized explicitly: `JSON.stringify(new Error())` yields `{}`, which is
 * the single most common way an error disappears from logs.
 */
function serializeError(error: unknown): Record<string, unknown> {
  if (isAppError(error)) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.context ? { context: redact(error.context) } : {}),
      ...(isProduction ? {} : { stack: error.stack }),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(isProduction ? {} : { stack: error.stack }),
    };
  }

  return { message: String(error) };
}

/** Swapped out in tests. */
export type LogSink = (level: LogLevel, record: Record<string, unknown>) => void;

const consoleSink: LogSink = (level, record) => {
  const line = JSON.stringify(record);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    // Vercel captures stdout; console.log is the only way onto it. `no-console`
    // is disabled for this single line rather than for the file.
    // eslint-disable-next-line no-console
    console.log(line);
  }
};

export function createLogger(
  bindings: LogContext = {},
  options: { level?: LogLevel; sink?: LogSink } = {},
): Logger {
  const minimum = LEVEL_ORDER[options.level ?? env.LOG_LEVEL];
  const sink = options.sink ?? consoleSink;

  function write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < minimum) return;

    sink(level, {
      level,
      time: new Date().toISOString(),
      message,
      ...(redact(bindings) as LogContext),
      ...(context ? (redact(context) as LogContext) : {}),
    });
  }

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, error, context) =>
      write('error', message, {
        ...context,
        ...(error === undefined ? {} : { error: serializeError(error) }),
      }),
    child: (extra) => createLogger({ ...bindings, ...extra }, options),
  };
}

/** The root logger. Prefer a child with meaningful bindings over using this directly. */
export const logger = createLogger();
