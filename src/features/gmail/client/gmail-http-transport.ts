import { withRetry, type RetryDecision } from '@/lib/retry';
import { ExternalServiceError, RateLimitError } from '@/server/errors';
import { logger } from '@/server/logger';
import { GmailHistoryListSchema } from '../domain/history';
import {
  GmailMessageListSchema,
  GmailMessageSchema,
  GmailProfileSchema,
} from '../domain/message';
import {
  GmailAuthorizationError,
  GmailHistoryExpiredError,
  GmailMessageNotFoundError,
  type GmailTransport,
} from './gmail-transport';

/**
 * The real Gmail client: HTTP against the REST API, with all the reliability behaviour
 * in one place.
 *
 * This talks to the API directly rather than through `googleapis`. Four endpoints are
 * used, and what matters most about them is retry policy, backoff, `Retry-After`
 * handling, and quota accounting — behaviour we want to own and test rather than inherit.
 * Adding a large dependency to hide four fetch calls, and then working around its retry
 * defaults, would be the worse trade. See ADR 0004.
 *
 * Access tokens are obtained through a callback rather than passed in, so a token that
 * expires part-way through a long sync is refreshed transparently by the account service.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

const log = logger.child({ component: 'gmail-transport' });

/** Errors Gmail returns that a retry could plausibly fix. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Gmail's per-user rate limit is short-window, so the first retry should be quick. The
 * cap keeps a single call from stalling a whole invocation's time budget.
 */
const RETRY_DEFAULTS = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 8000,
} as const;

export interface GmailHttpTransportDeps {
  /** Returns a currently valid access token, refreshing if needed. */
  readonly getAccessToken: (userId: string) => Promise<string>;
  readonly fetchFn?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export function createGmailHttpTransport(deps: GmailHttpTransportDeps): GmailTransport {
  const fetchFn = deps.fetchFn ?? fetch;
  let callCount = 0;

  async function request<T>(
    userId: string,
    path: string,
    query: Record<string, string | number | undefined>,
    parse: (payload: unknown) => T,
  ): Promise<T> {
    const url = new URL(`${GMAIL_API_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    return withRetry(
      async (attempt) => {
        // Fetched inside the retried operation so that a token expiring mid-sync is
        // replaced on the next attempt rather than reused.
        const accessToken = await deps.getAccessToken(userId);
        callCount += 1;

        let response: Response;
        try {
          response = await fetchFn(url.toString(), {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
          });
        } catch (cause) {
          throw new ExternalServiceError('gmail', 'Request failed', {
            cause,
            retryable: true,
            context: { path, attempt },
          });
        }

        if (!response.ok) {
          throw await toGmailError(response, path);
        }

        const payload: unknown = await response.json();
        return parse(payload);
      },
      {
        ...RETRY_DEFAULTS,
        shouldRetry: decideRetry,
        onRetry: ({ attempt, delayMs, error }) => {
          log.warn('retrying gmail request', {
            path,
            attempt,
            delayMs,
            reason: error instanceof Error ? error.message : String(error),
          });
        },
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.random ? { random: deps.random } : {}),
      },
    );
  }

  return {
    get callCount() {
      return callCount;
    },

    async getProfile(userId) {
      return request(userId, '/users/me/profile', {}, (payload) =>
        parseOrThrow(GmailProfileSchema, payload, 'profile'),
      );
    },

    async listMessages(userId, options) {
      return request(
        userId,
        '/users/me/messages',
        {
          maxResults: options.maxResults,
          pageToken: options.pageToken,
          q: options.query,
        },
        (payload) => parseOrThrow(GmailMessageListSchema, payload, 'messages.list'),
      );
    },

    async getMessage(userId, messageId) {
      return request(
        userId,
        `/users/me/messages/${encodeURIComponent(messageId)}`,
        { format: 'full' },
        (payload) => parseOrThrow(GmailMessageSchema, payload, 'messages.get'),
      );
    },

    async listHistory(userId, options) {
      return request(
        userId,
        '/users/me/history',
        {
          startHistoryId: options.startHistoryId,
          pageToken: options.pageToken,
          maxResults: options.maxResults ?? 500,
        },
        (payload) => parseOrThrow(GmailHistoryListSchema, payload, 'history.list'),
      );
    },
  };
}

function parseOrThrow<T>(
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown };
  },
  payload: unknown,
  operation: string,
): T {
  const result = schema.safeParse(payload);
  if (!result.success || result.data === undefined) {
    throw new ExternalServiceError(
      'gmail',
      `${operation} response did not match the expected shape`,
      { retryable: false },
    );
  }
  return result.data;
}

/**
 * Maps Gmail's HTTP failures onto our error taxonomy.
 *
 * The distinctions that matter:
 *   401 / 403 insufficient scope → reconnect, terminal
 *   403 rate-limit variants      → retryable, despite being a 4xx
 *   404 on history.list          → expired history id, handled by falling back to backfill
 *   404 on messages.get          → the message is gone, treated as a deletion
 */
async function toGmailError(response: Response, path: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  const reason = extractReason(body);

  if (response.status === 401) {
    return new GmailAuthorizationError(reason ?? 'access token rejected');
  }

  if (response.status === 403) {
    // Gmail signals quota problems with 403 as well as 429, distinguished only by reason.
    if (
      reason &&
      /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason)
    ) {
      return new RateLimitError('Gmail rate limit exceeded', {
        ...parseRetryAfter(response),
      });
    }
    return new GmailAuthorizationError(reason ?? 'insufficient permissions');
  }

  if (response.status === 404) {
    if (path.includes('/history')) {
      return new GmailHistoryExpiredError('unknown');
    }
    const messageId = path.split('/').pop() ?? 'unknown';
    return new GmailMessageNotFoundError(decodeURIComponent(messageId));
  }

  if (response.status === 429) {
    return new RateLimitError('Gmail rate limit exceeded', {
      ...parseRetryAfter(response),
    });
  }

  return new ExternalServiceError(
    'gmail',
    `${response.status} ${reason ?? response.statusText}`,
    { retryable: RETRYABLE_STATUSES.has(response.status) },
  );
}

/** Gmail's errors are `{ error: { code, message, errors: [{ reason }] } }`. */
function extractReason(body: string): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return null;

    const details = error as {
      message?: unknown;
      errors?: Array<{ reason?: unknown }>;
    };
    const firstReason = details.errors?.[0]?.reason;

    if (typeof firstReason === 'string') return firstReason;
    if (typeof details.message === 'string') return details.message;
    return null;
  } catch {
    return null;
  }
}

/** `Retry-After` is seconds or an HTTP date; both appear in practice. */
function parseRetryAfter(response: Response): { retryAfterSeconds?: number } {
  const header = response.headers.get('retry-after');
  if (!header) return {};

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterSeconds: Math.ceil(seconds) };
  }

  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    const delta = Math.ceil((date.getTime() - Date.now()) / 1000);
    if (delta > 0) return { retryAfterSeconds: delta };
  }

  return {};
}

/**
 * Retry policy, written once against our own error types rather than against HTTP status
 * codes at each call site.
 */
function decideRetry(error: unknown): RetryDecision {
  if (error instanceof RateLimitError) {
    return {
      retry: true,
      // Honour the server's instruction when it gave one.
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterMs: error.retryAfterSeconds * 1000 }),
    };
  }

  if (error instanceof ExternalServiceError) {
    return { retry: error.retryable };
  }

  // Authorization failures, schema mismatches, and anything unrecognised: do not retry.
  return { retry: false };
}
