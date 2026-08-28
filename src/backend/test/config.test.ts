import { describe, expect, it } from 'vitest';
import { ConfigError, geminiEnvSchema, geminiVersionOf } from '../src/config/env';

describe('config errors name the feature and what is missing', () => {
  it('reports the variable and the feature that wanted it', () => {
    const e = new ConfigError('agents', ['GEMINI_API_KEY'], 'Get a key at …');
    expect(e.message).toContain('Cannot start "agents"');
    expect(e.message).toContain('GEMINI_API_KEY');
    expect(e.message).toContain('src/backend/.env');
  });
});

describe('Gemini model floor (Tech Stack §3)', () => {
  it('parses the version out of a model id', () => {
    expect(geminiVersionOf('gemini-3.5-flash')).toBe(3.5);
    expect(geminiVersionOf('gemini-2.5-flash')).toBe(2.5);
    expect(geminiVersionOf('gemini-3-pro')).toBe(3);
    expect(geminiVersionOf('some-other-model')).toBeNull();
  });

  it('rejects a model below the required floor', () => {
    const r = geminiEnvSchema().safeParse({
      GEMINI_API_KEY: 'x',
      GEMINI_MODEL: 'gemini-2.5-flash',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('below the required Gemini 3.5 floor');
  });

  it('accepts 3.5 and above', () => {
    for (const model of ['gemini-3.5-flash', 'gemini-3.5-pro', 'gemini-4-flash']) {
      expect(geminiEnvSchema().safeParse({ GEMINI_API_KEY: 'x', GEMINI_MODEL: model }).success)
        .toBe(true);
    }
  });

  it('lets an unrecognised naming scheme through rather than blocking a deploy', () => {
    expect(
      geminiEnvSchema().safeParse({ GEMINI_API_KEY: 'x', GEMINI_MODEL: 'gemini-next-experimental' })
        .success,
    ).toBe(true);
  });
});
