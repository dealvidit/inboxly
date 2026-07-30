import { z } from 'zod';
import { GmailMessageRefSchema } from './message';

/**
 * Gmail's History API format, and its reduction into the changes we apply.
 *
 * A single history record can contain several kinds of change at once, and the same
 * message can appear in several records within one page — added, then labelled, then
 * deleted. `reduceHistory` collapses a page into one intent per message, so the apply
 * step is a simple walk rather than a state machine.
 */

const LabelChangeSchema = z.object({
  message: GmailMessageRefSchema,
  labelIds: z.array(z.string()).default([]),
});

const GmailHistoryRecordSchema = z.object({
  id: z.string(),
  messages: z.array(GmailMessageRefSchema).default([]),
  messagesAdded: z.array(z.object({ message: GmailMessageRefSchema })).default([]),
  messagesDeleted: z.array(z.object({ message: GmailMessageRefSchema })).default([]),
  labelsAdded: z.array(LabelChangeSchema).default([]),
  labelsRemoved: z.array(LabelChangeSchema).default([]),
});

export const GmailHistoryListSchema = z.object({
  history: z.array(GmailHistoryRecordSchema).default([]),
  nextPageToken: z.string().optional(),
  /** The mailbox's current history id — the checkpoint to store after applying a page. */
  historyId: z.string().optional(),
});

export type GmailHistoryList = z.infer<typeof GmailHistoryListSchema>;

/**
 * What a page of history asks us to do.
 *
 * Three disjoint sets. `deleted` wins over the others: a message deleted within the page
 * needs no fetch and no label update, and processing it as an addition first would mean
 * fetching a message that no longer exists.
 */
export interface HistoryChanges {
  /** Messages to fetch and upsert. */
  readonly addedMessageIds: string[];
  /** Messages to soft-delete. */
  readonly deletedMessageIds: string[];
  /**
   * Messages whose labels changed. These need re-fetching too: Gmail reports which
   * labels were added or removed, but the authoritative set is on the message, and
   * applying deltas to our stored copy would drift the moment one event is missed.
   */
  readonly labelChangedMessageIds: string[];
}

export function reduceHistory(page: GmailHistoryList): HistoryChanges {
  const added = new Set<string>();
  const deleted = new Set<string>();
  const labelChanged = new Set<string>();

  for (const record of page.history) {
    for (const entry of record.messagesAdded) {
      added.add(entry.message.id);
    }

    for (const entry of record.messagesDeleted) {
      deleted.add(entry.message.id);
    }

    for (const entry of [...record.labelsAdded, ...record.labelsRemoved]) {
      labelChanged.add(entry.message.id);
    }
  }

  // A message deleted in this page is deleted, whatever else happened to it first.
  for (const id of deleted) {
    added.delete(id);
    labelChanged.delete(id);
  }

  // A message added in this page will be fetched anyway, so its label change is moot.
  for (const id of added) {
    labelChanged.delete(id);
  }

  return {
    addedMessageIds: [...added],
    deletedMessageIds: [...deleted],
    labelChangedMessageIds: [...labelChanged],
  };
}

/** Total messages a page of changes will require us to fetch. */
export function fetchCount(changes: HistoryChanges): number {
  return changes.addedMessageIds.length + changes.labelChangedMessageIds.length;
}
