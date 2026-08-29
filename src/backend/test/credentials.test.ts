import { describe, expect, it } from 'vitest';
import {
  CreateProjectInput,
  GITHUB_TOKEN_PATTERN,
  Project,
  REQUIRED_GITHUB_SCOPES,
  RepositoryCredential,
  redactTokens,
} from '@proteus/schema';

const TOKEN = 'github_pat_11ABCDEFGH0123456789_abcdefghijklmnopqrstuvwxyz012345';

describe('the token is write-only input', () => {
  it('is accepted on create', () => {
    const r = CreateProjectInput.safeParse({
      name: 'Payment API PQC Migration',
      repositoryUrl: 'https://github.com/northwind-pay/payments-api',
      githubToken: TOKEN,
    });
    expect(r.success).toBe(true);
  });

  it('rejects something that is not a GitHub token', () => {
    const r = CreateProjectInput.safeParse({
      name: 'x',
      repositoryUrl: 'https://github.com/a/b',
      githubToken: 'not-a-token-but-long-enough-to-pass-min',
    });
    expect(r.success).toBe(false);
  });

  it('has no field on Project that could hold it', () => {
    // Design rule 8: the credential never enters the database. If someone adds a
    // token field to the repository shape, this fails.
    const shape = Object.keys(
      (Project.shape.repository as unknown as { shape: Record<string, unknown> }).shape,
    );
    expect(shape).not.toContain('githubToken');
    expect(shape).not.toContain('token');
    expect(shape).toContain('credential');
  });
});

describe('the stored reference cannot authenticate', () => {
  const cred = {
    secretName: 'proteus-PQC-0184-github-pat',
    secretVersion: '3',
    displayPrefix: TOKEN.slice(0, 12),
    declaredScopes: [...REQUIRED_GITHUB_SCOPES],
    status: 'STORED' as const,
    storedAt: new Date(),
    rotationDueAt: new Date(Date.now() + 90 * 864e5),
  };

  it('parses, and holds only a recognisable prefix', () => {
    const r = RepositoryCredential.safeParse(cred);
    expect(r.success).toBe(true);
    expect(cred.displayPrefix.length).toBeLessThanOrEqual(12);
    expect(TOKEN.startsWith(cred.displayPrefix)).toBe(true);
    // The prefix is far too short to be a usable token.
    expect(cred.displayPrefix.length).toBeLessThan(TOKEN.length / 3);
  });

  it('pins a version rather than tracking latest', () => {
    expect(cred.secretVersion).not.toBe('latest');
  });
});

describe('redaction runs at the write boundary', () => {
  it('strips tokens from strings, arrays and nested objects', () => {
    const payload = {
      command: `git push https://${TOKEN}@github.com/a/b`,
      logs: [`Authorization: Bearer ${TOKEN}`, 'ok'],
      nested: { deep: { note: TOKEN } },
      untouched: 42,
    };
    const clean = redactTokens(payload);
    const asText = JSON.stringify(clean);
    expect(asText).not.toContain(TOKEN);
    expect(asText).toContain('[REDACTED]');
    expect(clean.untouched).toBe(42);
    expect(clean.logs[1]).toBe('ok');
  });

  it('matches every GitHub token format', () => {
    for (const t of [
      'ghp_0123456789abcdefghijklmnopqrstuvwx',
      'gho_0123456789abcdefghijklmnopqrstuvwx',
      'ghs_0123456789abcdefghijklmnopqrstuvwx',
      TOKEN,
    ]) {
      GITHUB_TOKEN_PATTERN.lastIndex = 0;
      expect(redactTokens(`token=${t}`)).toBe('token=[REDACTED]');
    }
  });

  it('leaves ordinary text alone', () => {
    expect(redactTokens('cloned northwind-pay/payments-api at 7c41ab9')).toBe(
      'cloned northwind-pay/payments-api at 7c41ab9',
    );
  });
});

describe('redaction preserves values it must not rebuild', () => {
  // Regression: redactTokens rebuilt every object via Object.entries(), which
  // turns a Date into {} because a Date has no enumerable own properties. Since
  // redaction runs on every write, that corrupted every timestamp in the
  // database — silently, because nothing throws.
  it('leaves a Date a Date', () => {
    const at = new Date('2026-08-29T10:00:00Z');
    const out = redactTokens({ storedAt: at, nested: { rotationDueAt: at } });
    expect(out.storedAt).toBeInstanceOf(Date);
    expect(out.storedAt.toISOString()).toBe('2026-08-29T10:00:00.000Z');
    expect(out.nested.rotationDueAt).toBeInstanceOf(Date);
  });

  it('leaves a Buffer a Buffer', () => {
    const out = redactTokens({ data: Buffer.from('spec') });
    expect(Buffer.isBuffer(out.data)).toBe(true);
    expect(out.data.toString()).toBe('spec');
  });

  it('still redacts inside a plain object beside them', () => {
    const out = redactTokens({ at: new Date(0), note: `use ${TOKEN} here` });
    expect(out.at).toBeInstanceOf(Date);
    expect(out.note).toBe('use [REDACTED] here');
  });
});
