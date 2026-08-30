import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, useCloudLogging } from '../src/config/logger';

/**
 * The operational logger (TD-008).
 *
 * It crashed the process on the first real request: `scrub` walked Fastify's
 * request object into `raw.socket.server` and never came back. A logger that can
 * take the server down is worse than no logger, so the cases below are the two
 * shapes that did it and the one it was quietly destroying.
 */

describe('log redaction survives real objects', () => {
  const log = (value: unknown) => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { written.push(String(chunk)); cb(); },
    });
    // The logger under test, writing somewhere we can read.
    createLogger('info', false, sink).info(value as Record<string, unknown>, 'test');
    return written.join('');
  };

  it('does not recurse forever on a circular object', () => {
    // The exact shape that killed the process: `a.b.a`.
    const a: Record<string, unknown> = { name: 'req' };
    const b: Record<string, unknown> = { parent: a };
    a['child'] = b;

    expect(() => log({ req: a })).not.toThrow();
    expect(log({ req: a })).toContain('[Circular]');
  });

  it('does not recurse forever on a self-referencing array', () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => log({ arr })).not.toThrow();
  });

  it('stops at a depth limit rather than walking an arbitrarily deep tree', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    expect(() => log({ deep })).not.toThrow();
    expect(log({ deep })).toContain('[Truncated]');
  });

  it('renders the same object twice when it is a sibling, not a cycle', () => {
    // Path-based detection, not visited-based: a diamond is not a loop.
    const shared = { id: 'PQC-0001' };
    const out = log({ left: shared, right: shared });
    expect(out.match(/PQC-0001/g)).toHaveLength(2);
  });

  it('keeps an Error’s message and stack instead of flattening it to {}', () => {
    // `Object.entries(new Error('x'))` is `{}` — walking one threw away the
    // entire reason something failed.
    const out = log({ err: new Error('mongo is unreachable') });
    expect(out).toContain('mongo is unreachable');
  });

  it('redacts sensitive keys whatever their casing', () => {
    const out = log({ githubToken: 'ghp_x', Authorization: 'Bearer y', nested: { secret: 'z' } });
    expect(out).not.toContain('ghp_x');
    expect(out).not.toContain('Bearer y');
    expect(out).not.toContain('"z"');
  });

  it('redacts a token-shaped string wherever it appears', () => {
    const out = log({ message: `cloned with ghp_${'a'.repeat(36)} ok` });
    expect(out).not.toContain('ghp_aaaa');
    expect(out).toContain('[REDACTED]');
  });
});

describe('Cloud Logging shape', () => {
  const lines = (): { write: (s: string) => void; all: string[] } => {
    const all: string[] = [];
    return { write: (s: string) => all.push(s), all };
  };

  it('emits severity, message and an ISO timestamp', () => {
    const sink = lines();
    const log = createLogger('info', false, sink as never, true);
    log.warn({ projectId: 'PQC-0001' }, 'branch could not be pushed');

    const row = JSON.parse(sink.all[0]!);
    // Cloud Logging indexes these three. pino's defaults — a numeric `level`,
    // `msg`, and epoch millis — are not recognised by any of them.
    expect(row.severity).toBe('WARNING');
    expect(row.message).toBe('branch could not be pushed');
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(row.level).toBeUndefined();
    expect(row.projectId).toBe('PQC-0001');
  });

  it('maps every pino level to a severity Cloud Logging understands', () => {
    const sink = lines();
    const log = createLogger('trace', false, sink as never, true);
    log.trace('a'); log.debug('b'); log.info('c');
    log.warn('d'); log.error('e'); log.fatal('f');
    expect(sink.all.map((l) => JSON.parse(l).severity))
      .toEqual(['DEBUG', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);
  });

  it('still redacts under the Cloud Logging formatters', () => {
    const sink = lines();
    const log = createLogger('info', false, sink as never, true);
    log.info({ githubToken: 'ghp_realtokenvalue0000000000' }, 'cloning');
    expect(sink.all[0]).not.toContain('ghp_realtokenvalue');
    expect(sink.all[0]).toContain('[REDACTED]');
  });

  it('turns itself on under Cloud Run and off locally', () => {
    expect(useCloudLogging({ K_SERVICE: 'proteus-api' } as never)).toBe(true);
    expect(useCloudLogging({ LOG_FORMAT: 'GCP' } as never)).toBe(true);
    expect(useCloudLogging({} as never)).toBe(false);
  });
});
