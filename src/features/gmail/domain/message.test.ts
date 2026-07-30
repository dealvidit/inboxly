import { describe, expect, it } from 'vitest';
import {
  GmailMessageSchema,
  MAX_BODY_CHARS,
  extractBodyText,
  findHeader,
  hasAttachments,
  parseAddressList,
  resolveReceivedAt,
  stripHtml,
  toEmailProjection,
  type GmailMessage,
  type GmailPart,
} from './message';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

function message(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return GmailMessageSchema.parse({
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'A snippet',
    internalDate: '1785400000000',
    sizeEstimate: 4096,
    ...overrides,
  });
}

function textPart(mimeType: string, body: string, filename?: string): GmailPart {
  return {
    mimeType,
    ...(filename === undefined ? {} : { filename }),
    body: { size: body.length, data: b64(body) },
  };
}

describe('GmailMessageSchema', () => {
  it('accepts a message with only the fields Gmail always sends', () => {
    const parsed = GmailMessageSchema.parse({ id: 'a', threadId: 'b' });

    expect(parsed.labelIds).toEqual([]);
    expect(parsed.snippet).toBe('');
    expect(parsed.sizeEstimate).toBe(0);
  });

  it('rejects a message with no id, which we could not key on', () => {
    expect(GmailMessageSchema.safeParse({ threadId: 'b' }).success).toBe(false);
  });

  it('parses deeply nested multipart payloads', () => {
    const parsed = GmailMessageSchema.parse({
      id: 'a',
      threadId: 'b',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [{ mimeType: 'text/plain', body: { size: 5, data: b64('hello') } }],
          },
        ],
      },
    });

    expect(parsed.payload?.parts?.[0]?.parts?.[0]?.mimeType).toBe('text/plain');
  });
});

describe('findHeader', () => {
  const part: GmailPart = {
    headers: [
      { name: 'Subject', value: 'Hello' },
      { name: 'from', value: 'a@b.com' },
    ],
  };

  it('finds headers regardless of case, since Gmail does not guarantee it', () => {
    expect(findHeader(part, 'subject')).toBe('Hello');
    expect(findHeader(part, 'SUBJECT')).toBe('Hello');
    expect(findHeader(part, 'From')).toBe('a@b.com');
  });

  it('returns null for a missing header or a missing part', () => {
    expect(findHeader(part, 'Cc')).toBeNull();
    expect(findHeader(undefined, 'Subject')).toBeNull();
  });
});

describe('parseAddressList', () => {
  it('parses a bare address', () => {
    expect(parseAddressList('person@example.com')).toEqual([
      { name: null, email: 'person@example.com' },
    ]);
  });

  it('parses a display name with an angled address', () => {
    expect(parseAddressList('A Person <person@example.com>')).toEqual([
      { name: 'A Person', email: 'person@example.com' },
    ]);
  });

  it('keeps a comma inside a quoted display name together', () => {
    // The reason this function is not a split(',') — "Doe, Jane" is extremely common.
    expect(parseAddressList('"Doe, Jane" <jane@example.com>')).toEqual([
      { name: 'Doe, Jane', email: 'jane@example.com' },
    ]);
  });

  it('parses several addresses', () => {
    expect(
      parseAddressList(
        'One <one@example.com>, two@example.com, "Three" <3@example.com>',
      ),
    ).toEqual([
      { name: 'One', email: 'one@example.com' },
      { name: null, email: 'two@example.com' },
      { name: 'Three', email: '3@example.com' },
    ]);
  });

  it('normalises addresses to lower case so they compare reliably', () => {
    expect(parseAddressList('Person <Person@Example.COM>')[0]?.email).toBe(
      'person@example.com',
    );
  });

  it('returns an empty list for absent or unusable headers', () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('undisclosed recipients')).toEqual([]);
  });

  it('skips entries that are not addresses but keeps the ones that are', () => {
    expect(parseAddressList('not-an-address, real@example.com')).toEqual([
      { name: null, email: 'real@example.com' },
    ]);
  });
});

describe('extractBodyText', () => {
  it('prefers text/plain', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/alternative',
      parts: [
        textPart('text/plain', 'The plain version'),
        textPart('text/html', '<p>The HTML version</p>'),
      ],
    };

    expect(extractBodyText(payload)).toBe('The plain version');
  });

  it('falls back to HTML with tags stripped, because much real mail is HTML-only', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/alternative',
      parts: [textPart('text/html', '<p>Hello <b>there</b></p>')],
    };

    expect(extractBodyText(payload)).toBe('Hello there');
  });

  it('reads a single-part text message', () => {
    expect(extractBodyText(textPart('text/plain', 'Just text'))).toBe('Just text');
  });

  it('finds text nested several levels down', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/related',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [textPart('text/plain', 'Deeply nested')],
            },
          ],
        },
      ],
    };

    expect(extractBodyText(payload)).toBe('Deeply nested');
  });

  it('ignores attachments, so their contents are not spliced into the body', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/plain', 'The real body'),
        textPart('text/plain', 'ATTACHED FILE CONTENTS', 'notes.txt'),
      ],
    };

    expect(extractBodyText(payload)).toBe('The real body');
  });

  it('returns null when there is no text at all', () => {
    expect(extractBodyText(undefined)).toBeNull();
    expect(extractBodyText({ mimeType: 'image/png', body: { size: 100 } })).toBeNull();
    expect(extractBodyText(textPart('text/plain', '   '))).toBeNull();
  });

  it('truncates a very long body rather than storing it whole', () => {
    const body = extractBodyText(
      textPart('text/plain', 'x'.repeat(MAX_BODY_CHARS * 2)),
    );

    expect(body).toHaveLength(MAX_BODY_CHARS + 1);
    expect(body?.endsWith('…')).toBe(true);
  });

  it('survives undecodable part data instead of throwing', () => {
    expect(
      extractBodyText({
        mimeType: 'text/plain',
        body: { size: 4, data: '!!!not-base64!!!' },
      }),
    ).not.toBeUndefined();
  });
});

describe('stripHtml', () => {
  it('drops script and style bodies so they do not reach the summary', () => {
    const stripped = stripHtml(
      '<style>.a{color:red}</style><script>alert(1)</script><p>Real text</p>',
    );

    expect(stripped).toBe('Real text');
    expect(stripped).not.toContain('alert');
    expect(stripped).not.toContain('color');
  });

  it('turns block-level markup into line breaks', () => {
    expect(stripHtml('<p>One</p><p>Two</p>')).toBe('One\nTwo');
    expect(stripHtml('Line one<br>Line two')).toBe('Line one\nLine two');
  });

  it('decodes the common entities', () => {
    expect(stripHtml('<p>Tom &amp; Jerry &lt;tag&gt; &quot;quoted&quot;</p>')).toBe(
      'Tom & Jerry <tag> "quoted"',
    );
  });

  it('collapses runs of whitespace and blank lines', () => {
    expect(stripHtml('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });
});

describe('hasAttachments', () => {
  it('detects an attachment by its filename', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        textPart('text/plain', 'body'),
        textPart('application/pdf', 'x', 'a.pdf'),
      ],
    };

    expect(hasAttachments(payload)).toBe(true);
  });

  it('reports none for a plain message', () => {
    expect(hasAttachments(textPart('text/plain', 'body'))).toBe(false);
    expect(hasAttachments(undefined)).toBe(false);
  });

  it('finds an attachment nested inside a subpart', () => {
    expect(
      hasAttachments({
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/related',
            parts: [textPart('image/png', 'x', 'i.png')],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe('resolveReceivedAt', () => {
  it('prefers internalDate, which is Gmail’s own record of receipt', () => {
    const received = resolveReceivedAt(
      message({
        internalDate: '1785400000000',
        payload: {
          headers: [{ name: 'Date', value: 'Thu, 1 Jan 2020 00:00:00 +0000' }],
        },
      }),
    );

    expect(received.getTime()).toBe(1785400000000);
  });

  it('falls back to the Date header when internalDate is absent', () => {
    const received = resolveReceivedAt(
      GmailMessageSchema.parse({
        id: 'a',
        threadId: 'b',
        payload: {
          headers: [{ name: 'Date', value: 'Wed, 15 Jul 2026 09:30:00 +0000' }],
        },
      }),
    );

    expect(received.toISOString()).toBe('2026-07-15T09:30:00.000Z');
  });

  it('falls back to now when both are missing or nonsense, so sorting still works', () => {
    const now = new Date('2026-07-30T12:00:00Z');

    expect(
      resolveReceivedAt(GmailMessageSchema.parse({ id: 'a', threadId: 'b' }), now),
    ).toEqual(now);
    expect(
      resolveReceivedAt(
        GmailMessageSchema.parse({
          id: 'a',
          threadId: 'b',
          internalDate: 'not-a-number',
        }),
        now,
      ),
    ).toEqual(now);
    expect(
      resolveReceivedAt(
        GmailMessageSchema.parse({
          id: 'a',
          threadId: 'b',
          payload: { headers: [{ name: 'Date', value: 'garbage' }] },
        }),
        now,
      ),
    ).toEqual(now);
  });
});

describe('toEmailProjection', () => {
  const full = message({
    labelIds: ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'Subject', value: 'Quarterly invoice' },
        { name: 'From', value: 'Acme Billing <billing@acme.test>' },
        { name: 'To', value: 'me@example.com, other@example.com' },
        { name: 'Cc', value: 'cc@example.com' },
        { name: 'Reply-To', value: 'ar@acme.test' },
      ],
      parts: [
        textPart('text/plain', 'Please remit by Friday.'),
        textPart('application/pdf', 'pdf', 'invoice.pdf'),
      ],
    },
  });

  it('maps the message onto the columns we store', () => {
    const projection = toEmailProjection(full);

    expect(projection).toMatchObject({
      gmailMessageId: 'msg-1',
      gmailThreadId: 'thread-1',
      subject: 'Quarterly invoice',
      snippet: 'A snippet',
      bodyText: 'Please remit by Friday.',
      fromName: 'Acme Billing',
      fromEmail: 'billing@acme.test',
      toEmails: ['me@example.com', 'other@example.com'],
      ccEmails: ['cc@example.com'],
      replyTo: 'ar@acme.test',
      hasAttachments: true,
      sizeEstimate: 4096,
    });
  });

  it('derives the flags from Gmail labels', () => {
    const projection = toEmailProjection(full);

    expect(projection.isUnread).toBe(true);
    expect(projection.isStarred).toBe(true);
    expect(projection.isImportant).toBe(true);

    const read = toEmailProjection(message({ labelIds: ['INBOX'] }));
    expect(read.isUnread).toBe(false);
    expect(read.isStarred).toBe(false);
    expect(read.isImportant).toBe(false);
  });

  it('keeps the raw label list, so views can filter on labels we have not modelled', () => {
    expect(toEmailProjection(full).labels).toEqual([
      'INBOX',
      'UNREAD',
      'STARRED',
      'IMPORTANT',
    ]);
  });

  it('handles a message with no headers at all', () => {
    const projection = toEmailProjection(message({ payload: undefined }));

    expect(projection.subject).toBe('');
    // Empty rather than absent: the mailbox should still show the message.
    expect(projection.fromEmail).toBe('');
    expect(projection.toEmails).toEqual([]);
    expect(projection.bodyText).toBeNull();
  });

  it('truncates an abusive subject line', () => {
    const projection = toEmailProjection(
      message({
        payload: { headers: [{ name: 'Subject', value: 'y'.repeat(2000) }] },
      }),
    );

    expect(projection.subject.length).toBeLessThanOrEqual(501);
  });
});
