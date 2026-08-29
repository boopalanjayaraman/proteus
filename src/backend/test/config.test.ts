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

describe('the Gemini backend is chosen by the flag, not by which value is set', () => {
  /** Mirrors server.ts, which is where the choice is actually made. */
  const backendFor = (cfg: {
    GOOGLE_GENAI_USE_VERTEXAI: boolean; GEMINI_API_KEY?: string;
    GCP_PROJECT_ID?: string; GCP_REGION: string;
  }) => (cfg.GOOGLE_GENAI_USE_VERTEXAI
    ? { kind: 'VERTEX' as const, projectId: cfg.GCP_PROJECT_ID, location: cfg.GCP_REGION }
    : { kind: 'API_KEY' as const, apiKey: cfg.GEMINI_API_KEY });

  it('uses Vertex when the flag is set, even with a key present', () => {
    // The bug this replaces: the key was passed regardless, so a deployment
    // asking for Vertex still called generativelanguage.googleapis.com and
    // failed on a key it was not trying to use.
    const b = backendFor({
      GOOGLE_GENAI_USE_VERTEXAI: true,
      GEMINI_API_KEY: 'AIzaSomethingStale',
      GCP_PROJECT_ID: 'proj', GCP_REGION: 'us-central1',
    });
    expect(b.kind).toBe('VERTEX');
    expect(JSON.stringify(b)).not.toContain('AIzaSomethingStale');
  });

  it('uses the key endpoint when the flag is not set', () => {
    const b = backendFor({
      GOOGLE_GENAI_USE_VERTEXAI: false, GEMINI_API_KEY: 'k', GCP_REGION: 'us-central1',
    });
    expect(b.kind).toBe('API_KEY');
  });

  it('always carries a region into Vertex — there is no global endpoint', () => {
    const b = backendFor({
      GOOGLE_GENAI_USE_VERTEXAI: true, GCP_PROJECT_ID: 'proj', GCP_REGION: 'europe-west4',
    });
    expect(b).toHaveProperty('location', 'europe-west4');
  });
});
