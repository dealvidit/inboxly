import type { GmailTransport } from '@/features/gmail/client/gmail-transport';
import {
  GmailHistoryExpiredError,
  GmailMessageNotFoundError,
} from '@/features/gmail/client/gmail-transport';
import { GmailHistoryListSchema } from '@/features/gmail/domain/history';
import {
  GmailMessageListSchema,
  GmailMessageSchema,
  GmailProfileSchema,
  type GmailMessage,
} from '@/features/gmail/domain/message';

/**
 * An in-memory Gmail, used to drive the synchronization engine in tests.
 *
 * This is the payoff of putting Gmail behind an interface (ADR 0001): backfill,
 * incremental sync, pagination, deletions, label changes, expired history ids, and
 * mid-run failures can all be exercised deterministically, with no network and no
 * credentials.
 *
 * It models Gmail closely enough to be useful — a message store, a monotonic history
 * log, and page tokens — and no more.
 */

export interface FakeMessageInput {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  body?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
}

interface HistoryEvent {
  historyId: number;
  type: 'added' | 'deleted' | 'labels';
  messageId: string;
}

export class FakeGmail implements GmailTransport {
  private readonly messages = new Map<string, GmailMessage>();
  /** Insertion order, newest first — Gmail lists most-recent-first. */
  private order: string[] = [];
  private readonly events: HistoryEvent[] = [];
  private nextHistoryId = 1000;

  callCount = 0;

  /** Set to make the next call of a given kind fail, simulating a mid-run interruption. */
  failNextGetMessage: Error | null = null;
  failNextListMessages: Error | null = null;
  /** When true, listHistory rejects any startHistoryId as expired. */
  historyExpired = false;

  /** Page size used by listMessages, so pagination can be tested with few messages. */
  constructor(private readonly pageSize = 2) {}

  /* ─── Test authoring API ───────────────────────────────────────────────── */

  addMessage(input: FakeMessageInput): void {
    this.nextHistoryId += 1;

    const message = GmailMessageSchema.parse({
      id: input.id,
      threadId: input.threadId ?? `thread-${input.id}`,
      labelIds: input.labelIds ?? ['INBOX', 'UNREAD'],
      snippet: input.snippet ?? `Snippet for ${input.id}`,
      historyId: String(this.nextHistoryId),
      internalDate: input.internalDate ?? String(Date.parse('2026-07-01T00:00:00Z')),
      sizeEstimate: 1024,
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: input.subject ?? `Subject ${input.id}` },
          { name: 'From', value: input.from ?? `sender-${input.id}@example.test` },
          { name: 'To', value: 'me@example.test' },
        ],
        body: {
          size: (input.body ?? '').length,
          data: Buffer.from(input.body ?? `Body of ${input.id}`, 'utf8').toString(
            'base64url',
          ),
        },
      },
    });

    if (!this.messages.has(input.id)) this.order.unshift(input.id);
    this.messages.set(input.id, message);
    this.events.push({
      historyId: this.nextHistoryId,
      type: 'added',
      messageId: input.id,
    });
  }

  deleteMessage(id: string): void {
    this.nextHistoryId += 1;
    this.messages.delete(id);
    this.order = this.order.filter((existing) => existing !== id);
    this.events.push({ historyId: this.nextHistoryId, type: 'deleted', messageId: id });
  }

  changeLabels(id: string, labelIds: string[]): void {
    const existing = this.messages.get(id);
    if (!existing) throw new Error(`FakeGmail: no message ${id}`);

    this.nextHistoryId += 1;
    this.messages.set(id, { ...existing, labelIds });
    this.events.push({ historyId: this.nextHistoryId, type: 'labels', messageId: id });
  }

  get currentHistoryId(): string {
    return String(this.nextHistoryId);
  }

  get messageCount(): number {
    return this.messages.size;
  }

  /* ─── GmailTransport ───────────────────────────────────────────────────── */

  async getProfile() {
    this.callCount += 1;
    return GmailProfileSchema.parse({
      emailAddress: 'me@example.test',
      messagesTotal: this.messages.size,
      threadsTotal: this.messages.size,
      historyId: this.currentHistoryId,
    });
  }

  async listMessages(
    _userId: string,
    options: { pageToken?: string; maxResults: number },
  ) {
    this.callCount += 1;

    if (this.failNextListMessages) {
      const error = this.failNextListMessages;
      this.failNextListMessages = null;
      throw error;
    }

    const offset = options.pageToken ? Number(options.pageToken) : 0;
    const size = Math.min(this.pageSize, options.maxResults);
    const slice = this.order.slice(offset, offset + size);
    const nextOffset = offset + slice.length;

    return GmailMessageListSchema.parse({
      messages: slice.map((id) => ({ id, threadId: `thread-${id}` })),
      ...(nextOffset < this.order.length ? { nextPageToken: String(nextOffset) } : {}),
      resultSizeEstimate: this.order.length,
    });
  }

  async getMessage(_userId: string, messageId: string) {
    this.callCount += 1;

    if (this.failNextGetMessage) {
      const error = this.failNextGetMessage;
      this.failNextGetMessage = null;
      throw error;
    }

    const message = this.messages.get(messageId);
    if (!message) throw new GmailMessageNotFoundError(messageId);
    return message;
  }

  async listHistory(_userId: string, options: { startHistoryId: string }) {
    this.callCount += 1;

    if (this.historyExpired) {
      throw new GmailHistoryExpiredError(options.startHistoryId);
    }

    const start = Number(options.startHistoryId);
    const relevant = this.events.filter((event) => event.historyId > start);

    return GmailHistoryListSchema.parse({
      history: relevant.map((event) => ({
        id: String(event.historyId),
        messagesAdded:
          event.type === 'added'
            ? [
                {
                  message: {
                    id: event.messageId,
                    threadId: `thread-${event.messageId}`,
                  },
                },
              ]
            : [],
        messagesDeleted:
          event.type === 'deleted'
            ? [
                {
                  message: {
                    id: event.messageId,
                    threadId: `thread-${event.messageId}`,
                  },
                },
              ]
            : [],
        labelsAdded:
          event.type === 'labels'
            ? [
                {
                  message: {
                    id: event.messageId,
                    threadId: `thread-${event.messageId}`,
                  },
                  labelIds: ['STARRED'],
                },
              ]
            : [],
        labelsRemoved: [],
      })),
      historyId: this.currentHistoryId,
    });
  }
}
