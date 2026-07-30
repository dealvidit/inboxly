/**
 * The application's error taxonomy.
 *
 * Two ideas run through this file.
 *
 * First, every error carries a `userMessage` that is safe to show a person, kept
 * separate from the `message` used for logs. Provider messages, stack traces, and
 * internal identifiers never reach the browser — the tRPC error formatter (ADR 0008)
 * returns only `userMessage`.
 *
 * Second, `retryable` is a property of the error rather than a decision made at the
 * call site. Retry policy is then written once, against our taxonomy, instead of being
 * re-derived from each vendor's error shapes.
 */

export type AppErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'EXTERNAL_SERVICE'
  | 'CONFIGURATION'
  | 'INTERNAL';

export interface AppErrorOptions {
  /** Safe to render to a person. Defaults to a generic message per error type. */
  readonly userMessage?: string;
  readonly cause?: unknown;
  /** Structured detail for logs. Must never contain email content or secrets. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  abstract readonly httpStatus: number;
  /** Whether retrying the same operation could plausibly succeed. */
  abstract readonly retryable: boolean;

  readonly userMessage: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;

  protected constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.userMessage = options.userMessage ?? message;
    this.context = options.context;
    Error.captureStackTrace?.(this, new.target);
  }

  /** The shape sent to clients. Deliberately excludes `message`, `cause`, and context. */
  toClientPayload(): { code: AppErrorCode; message: string } {
    return { code: this.code, message: this.userMessage };
  }
}

/** Input failed validation. The user can fix this by changing what they sent. */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { userMessage: message, ...options });
  }
}

/** No valid session. The user should sign in. */
export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED' as const;
  readonly httpStatus = 401;
  readonly retryable = false;

  constructor(message = 'Authentication required', options: AppErrorOptions = {}) {
    super(message, { userMessage: 'Please sign in to continue.', ...options });
  }
}

/** Authenticated, but not allowed. Distinct from UNAUTHORIZED so the UI can differ. */
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN' as const;
  readonly httpStatus = 403;
  readonly retryable = false;

  constructor(message = 'Access denied', options: AppErrorOptions = {}) {
    super(message, {
      userMessage: 'You do not have access to this.',
      ...options,
    });
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
  readonly httpStatus = 404;
  readonly retryable = false;

  constructor(resource: string, options: AppErrorOptions = {}) {
    super(`${resource} not found`, {
      userMessage: 'That item no longer exists.',
      ...options,
    });
  }
}

/** The request conflicts with current state — a concurrent update, or a duplicate. */
export class ConflictError extends AppError {
  readonly code = 'CONFLICT' as const;
  readonly httpStatus = 409;
  readonly retryable = false;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { userMessage: message, ...options });
  }
}

export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMITED' as const;
  readonly httpStatus = 429;
  readonly retryable = true;

  /** Seconds to wait before retrying, when the upstream told us. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message = 'Rate limit exceeded',
    options: AppErrorOptions & { retryAfterSeconds?: number } = {},
  ) {
    super(message, {
      userMessage: 'Too many requests. Please try again in a moment.',
      ...options,
    });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** An upstream dependency failed. `retryable` distinguishes a blip from a dead end. */
export class ExternalServiceError extends AppError {
  readonly code = 'EXTERNAL_SERVICE' as const;
  readonly httpStatus = 502;
  readonly retryable: boolean;

  readonly service: string;

  constructor(
    service: string,
    message: string,
    options: AppErrorOptions & { retryable?: boolean } = {},
  ) {
    super(`${service}: ${message}`, {
      userMessage: 'A connected service is unavailable. Please try again shortly.',
      ...options,
    });
    this.service = service;
    this.retryable = options.retryable ?? true;
  }
}

/** The deployment is misconfigured. Retrying will not help; a human must act. */
export class ConfigurationError extends AppError {
  readonly code = 'CONFIGURATION' as const;
  readonly httpStatus = 500;
  readonly retryable = false;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, {
      userMessage: 'The application is misconfigured. Please contact support.',
      ...options,
    });
  }
}

/** A bug, or something genuinely unexpected. */
export class InternalError extends AppError {
  readonly code = 'INTERNAL' as const;
  readonly httpStatus = 500;
  readonly retryable = false;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, {
      userMessage: 'Something went wrong on our end.',
      ...options,
    });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** True when retrying the operation could plausibly succeed. */
export function isRetryable(error: unknown): boolean {
  return isAppError(error) && error.retryable;
}

/**
 * Wraps anything thrown into an AppError, so error handling upstream has one shape to
 * deal with. An unrecognised error becomes InternalError, whose user-facing message
 * reveals nothing about what actually happened.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const message =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  return new InternalError(message, { cause: error });
}
