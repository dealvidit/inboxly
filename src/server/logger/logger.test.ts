import { describe, expect, it } from 'vitest';
import { UnauthorizedError, ValidationError } from '@/server/errors';
import { createLogger, type LogLevel } from './logger';

/** Collects records instead of writing them, so assertions run against structure. */
function collectingLogger(level: LogLevel = 'debug') {
  const records: Array<{ level: LogLevel; record: Record<string, unknown> }> = [];
  const logger = createLogger(
    {},
    { level, sink: (l, record) => records.push({ level: l, record }) },
  );
  return { logger, records };
}

describe('levels', () => {
  it('writes records at or above the configured level', () => {
    const { logger, records } = collectingLogger('warn');

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(records.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  it('includes a level, timestamp, and message on every record', () => {
    const { logger, records } = collectingLogger();

    logger.info('sync started');

    expect(records[0]?.record).toMatchObject({
      level: 'info',
      message: 'sync started',
    });
    expect(String(records[0]?.record.time)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

describe('child loggers', () => {
  it('carries bindings onto every record', () => {
    const { logger, records } = collectingLogger();

    logger.child({ userId: 'user-1', component: 'sync' }).info('page fetched');

    expect(records[0]?.record).toMatchObject({
      userId: 'user-1',
      component: 'sync',
      message: 'page fetched',
    });
  });

  it('merges nested bindings, with the innermost winning', () => {
    const { logger, records } = collectingLogger();

    logger
      .child({ component: 'sync', phase: 'backfill' })
      .child({ phase: 'incremental' })
      .info('x');

    expect(records[0]?.record).toMatchObject({
      component: 'sync',
      phase: 'incremental',
    });
  });
});

describe('redaction', () => {
  it('removes credentials by field name', () => {
    const { logger, records } = collectingLogger();

    logger.info('token refreshed', {
      refreshToken: 'super-secret',
      access_token: 'also-secret',
      apiKey: 'sk-ant-real-key',
      authorization: 'Bearer abc',
      userId: 'user-1',
    });

    const record = records[0]!.record;
    expect(record.refreshToken).toBe('[redacted]');
    expect(record.access_token).toBe('[redacted]');
    expect(record.apiKey).toBe('[redacted]');
    expect(record.authorization).toBe('[redacted]');
    expect(record.userId).toBe('user-1');
  });

  it('removes email content, which must never reach the logs', () => {
    const { logger, records } = collectingLogger();

    logger.info('email analysed', {
      subject: 'Q3 salary review',
      snippet: 'Your new compensation is',
      fromEmail: 'hr@example.com',
      summary: 'HR is discussing a raise',
      emailId: 'email-1',
    });

    const record = records[0]!.record;
    expect(record.subject).toBe('[redacted]');
    expect(record.snippet).toBe('[redacted]');
    expect(record.fromEmail).toBe('[redacted]');
    expect(record.summary).toBe('[redacted]');
    // The identifier is safe and is what makes the log useful.
    expect(record.emailId).toBe('email-1');
  });

  it('redacts at any depth, not only the top level', () => {
    const { logger, records } = collectingLogger();

    logger.info('nested', {
      request: { headers: { cookie: 'session=abc' }, path: '/api/trpc' },
      items: [{ subject: 'secret subject' }],
    });

    const record = records[0]!.record as {
      request: { headers: { cookie: string }; path: string };
      items: Array<{ subject: string }>;
    };
    expect(record.request.headers.cookie).toBe('[redacted]');
    expect(record.request.path).toBe('/api/trpc');
    expect(record.items[0]?.subject).toBe('[redacted]');
  });

  it('matches credential names case-insensitively and by substring', () => {
    const { logger, records } = collectingLogger();

    logger.info('variants', {
      REFRESH_TOKEN: 'a',
      googleRefreshTokenCiphertext: 'b',
      codeVerifier: 'c',
    });

    const record = records[0]!.record;
    expect(record.REFRESH_TOKEN).toBe('[redacted]');
    expect(record.googleRefreshTokenCiphertext).toBe('[redacted]');
    expect(record.codeVerifier).toBe('[redacted]');
  });

  it('keeps identifiers and counts that merely contain a content word', () => {
    const { logger, records } = collectingLogger();

    logger.info('sync finished', {
      emailId: 'email-1',
      emailCount: 42,
      subjectLine: 'not the subject field',
      email: 'person@example.com',
    });

    const record = records[0]!.record;
    expect(record.emailId).toBe('email-1');
    expect(record.emailCount).toBe(42);
    expect(record.subjectLine).toBe('not the subject field');
    expect(record.email).toBe('[redacted]');
  });

  it('terminates on a cyclic object instead of hanging', () => {
    const { logger, records } = collectingLogger();
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    logger.info('cyclic', { cyclic });

    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0]?.record)).toContain('[max depth]');
  });
});

describe('error serialization', () => {
  it('records the code and retryability of an application error', () => {
    const { logger, records } = collectingLogger();

    logger.error('request failed', new UnauthorizedError('no session'), {
      path: 'emails.list',
    });

    const error = records[0]!.record.error as Record<string, unknown>;
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('no session');
    expect(error.retryable).toBe(false);
    expect(records[0]?.record.path).toBe('emails.list');
  });

  it('serializes a plain Error, which JSON.stringify would otherwise flatten to {}', () => {
    const { logger, records } = collectingLogger();

    logger.error('boom', new Error('something broke'));

    const error = records[0]!.record.error as Record<string, unknown>;
    expect(error.name).toBe('Error');
    expect(error.message).toBe('something broke');
  });

  it('handles a thrown non-Error value', () => {
    const { logger, records } = collectingLogger();

    logger.error('odd', 'just a string');

    expect((records[0]!.record.error as Record<string, unknown>).message).toBe(
      'just a string',
    );
  });

  it('redacts context attached to an application error', () => {
    const { logger, records } = collectingLogger();

    logger.error(
      'validation failed',
      new ValidationError('bad input', { context: { subject: 'private', field: 'x' } }),
    );

    const context = (records[0]!.record.error as { context: Record<string, unknown> })
      .context;
    expect(context.subject).toBe('[redacted]');
    expect(context.field).toBe('x');
  });
});
