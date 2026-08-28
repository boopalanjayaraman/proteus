import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/env';

describe('config errors name the feature and what is missing', () => {
  it('reports the variable and the feature that wanted it', () => {
    const e = new ConfigError('agents', ['GEMINI_API_KEY'], 'Get a key at …');
    expect(e.message).toContain('Cannot start "agents"');
    expect(e.message).toContain('GEMINI_API_KEY');
    expect(e.message).toContain('src/backend/.env');
  });
});
