import {
  ExternalServiceError,
  RateLimitError,
  UnauthorizedError,
} from '@/server/errors';
import type { GmailHistoryList } from '../domain/history';
import type { GmailMessage, GmailMessageList, GmailProfile } from '../domain/message';

/**
 * The Gmail boundary.
 *
 * Sync logic depends on this interface, never on an HTTP client or an SDK, which is what
 * lets the whole synchronization engine be tested against a fake mailbox with no network
 * access. It is one of the three interfaces the architecture admits (ADR 0001).
 *
 * Only the four operations synchronization actually performs are here. A wider surface
 * would be a wider fake to maintain, for endpoints nothing calls.
 */
export interface GmailTransport {
  /** The mailbox's address and current history id. */
  getProfile(userId: string): Promise<GmailProfile>;

  listMessages(
    userId: string,
    options: { pageToken?: string; maxResults: number; query?: string },
  ): Promise<GmailMessageList>;

  getMessage(userId: string, messageId: string): Promise<GmailMessage>;

  listHistory(
    userId: string,
    options: { startHistoryId: string; pageToken?: string; maxResults?: number },
  ): Promise<GmailHistoryList>;

  /** Gmail API calls made so far, for quota accounting on a SyncRun. */
  readonly callCount: number;
}

/**
 * Raised when Gmail rejects a history id as too old.
 *
 * This is expected behaviour rather than a fault — history ids expire after roughly a
 * week of inactivity — and the sync service handles it by falling back to a backfill.
 * It gets its own type so that path cannot be confused with a real failure.
 */
export class GmailHistoryExpiredError extends ExternalServiceError {
  constructor(startHistoryId: string) {
    super('gmail', `History id ${startHistoryId} has expired`, {
      retryable: false,
      userMessage: 'Resynchronizing your mailbox from scratch.',
    });
  }
}

/** Raised when the message is gone. Treated as a deletion, not an error. */
export class GmailMessageNotFoundError extends ExternalServiceError {
  constructor(messageId: string) {
    super('gmail', `Message ${messageId} not found`, { retryable: false });
  }
}

/**
 * Raised when Gmail says our credentials or scopes are insufficient. Terminal: the sync
 * stops and the account is marked for reconnection.
 */
export class GmailAuthorizationError extends UnauthorizedError {
  constructor(reason: string) {
    super(`Gmail authorization failed: ${reason}`, {
      userMessage: 'Reconnect Gmail to resume synchronization.',
    });
  }
}

export { RateLimitError };
