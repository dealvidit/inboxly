import { describe, expect, it } from 'vitest';
import { GmailHistoryListSchema, fetchCount, reduceHistory } from './history';

/** Builds a history page from a compact description. */
function page(
  records: Array<{
    id: string;
    added?: string[];
    deleted?: string[];
    labelsAdded?: string[];
    labelsRemoved?: string[];
  }>,
  extras: { historyId?: string; nextPageToken?: string } = {},
) {
  return GmailHistoryListSchema.parse({
    history: records.map((record) => ({
      id: record.id,
      messagesAdded: (record.added ?? []).map((id) => ({
        message: { id, threadId: `t-${id}` },
      })),
      messagesDeleted: (record.deleted ?? []).map((id) => ({
        message: { id, threadId: `t-${id}` },
      })),
      labelsAdded: (record.labelsAdded ?? []).map((id) => ({
        message: { id, threadId: `t-${id}` },
        labelIds: ['STARRED'],
      })),
      labelsRemoved: (record.labelsRemoved ?? []).map((id) => ({
        message: { id, threadId: `t-${id}` },
        labelIds: ['UNREAD'],
      })),
    })),
    ...extras,
  });
}

describe('GmailHistoryListSchema', () => {
  it('accepts an empty page, which is what "nothing changed" looks like', () => {
    const parsed = GmailHistoryListSchema.parse({ historyId: '12345' });

    expect(parsed.history).toEqual([]);
    expect(parsed.historyId).toBe('12345');
  });

  it('defaults every change collection, since Gmail omits the empty ones', () => {
    const parsed = GmailHistoryListSchema.parse({ history: [{ id: '1' }] });

    expect(parsed.history[0]?.messagesAdded).toEqual([]);
    expect(parsed.history[0]?.messagesDeleted).toEqual([]);
    expect(parsed.history[0]?.labelsAdded).toEqual([]);
  });
});

describe('reduceHistory', () => {
  it('collects additions, deletions, and label changes separately', () => {
    const changes = reduceHistory(
      page([
        { id: '1', added: ['a'] },
        { id: '2', deleted: ['b'] },
        { id: '3', labelsAdded: ['c'] },
      ]),
    );

    expect(changes.addedMessageIds).toEqual(['a']);
    expect(changes.deletedMessageIds).toEqual(['b']);
    expect(changes.labelChangedMessageIds).toEqual(['c']);
  });

  it('de-duplicates a message that appears in several records', () => {
    const changes = reduceHistory(
      page([
        { id: '1', added: ['a'] },
        { id: '2', added: ['a'] },
        { id: '3', labelsAdded: ['b'] },
        { id: '4', labelsRemoved: ['b'] },
      ]),
    );

    expect(changes.addedMessageIds).toEqual(['a']);
    expect(changes.labelChangedMessageIds).toEqual(['b']);
  });

  it('lets a deletion win over an addition in the same page', () => {
    // Otherwise we would fetch a message that no longer exists, and get a 404.
    const changes = reduceHistory(
      page([
        { id: '1', added: ['a'] },
        { id: '2', deleted: ['a'] },
      ]),
    );

    expect(changes.addedMessageIds).toEqual([]);
    expect(changes.deletedMessageIds).toEqual(['a']);
  });

  it('lets a deletion win even when it precedes the addition record', () => {
    const changes = reduceHistory(
      page([
        { id: '1', deleted: ['a'] },
        { id: '2', added: ['a'] },
      ]),
    );

    expect(changes.addedMessageIds).toEqual([]);
    expect(changes.deletedMessageIds).toEqual(['a']);
  });

  it('lets a deletion win over a label change', () => {
    const changes = reduceHistory(
      page([
        { id: '1', labelsAdded: ['a'] },
        { id: '2', deleted: ['a'] },
      ]),
    );

    expect(changes.labelChangedMessageIds).toEqual([]);
    expect(changes.deletedMessageIds).toEqual(['a']);
  });

  it('does not schedule a label change for a message it is already fetching', () => {
    const changes = reduceHistory(
      page([
        { id: '1', added: ['a'] },
        { id: '2', labelsAdded: ['a'] },
      ]),
    );

    expect(changes.addedMessageIds).toEqual(['a']);
    expect(changes.labelChangedMessageIds).toEqual([]);
  });

  it('treats labelsAdded and labelsRemoved identically, because the message is refetched', () => {
    const changes = reduceHistory(
      page([
        { id: '1', labelsAdded: ['a'] },
        { id: '2', labelsRemoved: ['b'] },
      ]),
    );

    expect(changes.labelChangedMessageIds.sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty page', () => {
    const changes = reduceHistory(page([]));

    expect(changes.addedMessageIds).toEqual([]);
    expect(changes.deletedMessageIds).toEqual([]);
    expect(changes.labelChangedMessageIds).toEqual([]);
  });
});

describe('fetchCount', () => {
  it('counts additions and label changes, but not deletions', () => {
    // Deletions need no API call — the message id is all we need to soft-delete.
    const changes = reduceHistory(
      page([{ id: '1', added: ['a', 'b'], deleted: ['c'], labelsAdded: ['d'] }]),
    );

    expect(fetchCount(changes)).toBe(3);
  });
});
