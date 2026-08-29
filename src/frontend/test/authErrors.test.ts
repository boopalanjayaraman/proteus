import { describe, expect, it } from 'vitest';
import { describeAuthError } from '../src/lib/authErrors';

/**
 * The popup that opens and closes with nothing on screen.
 *
 * Every case here is a console setting, not a code bug — which is exactly why
 * the message has to name the setting. "Sign-in failed" sends someone to the
 * source; "enable Google in Authentication → Sign-in method" fixes it.
 */

const fbError = (code: string) => Object.assign(new Error(code), { code });

describe('describeAuthError', () => {
  it('names the console setting for a provider that is not enabled', () => {
    const f = describeAuthError(fbError('auth/operation-not-allowed'));
    expect(f.message).toContain('not enabled');
    expect(f.fix).toContain('Sign-in method');
  });

  it('warns that localhost and 127.0.0.1 are different authorized domains', () => {
    // The one that catches people out: Firebase authorizes `localhost` by
    // default and `127.0.0.1` never.
    const f = describeAuthError(fbError('auth/unauthorized-domain'));
    expect(f.fix).toContain('127.0.0.1');
  });

  it('says a restart is needed for a bad key, because Vite inlines it', () => {
    const f = describeAuthError(fbError('auth/invalid-api-key'));
    expect(f.fix).toContain('restart');
  });

  it('explains a self-closing popup rather than blaming the user', () => {
    const f = describeAuthError(fbError('auth/popup-closed-by-user'));
    expect(f.fix).toContain('closed on its own');
  });

  it('passes an unknown error through with its message', () => {
    expect(describeAuthError(new Error('boom')).message).toBe('boom');
    expect(describeAuthError(new Error('boom')).code).toBe('unknown');
  });

  it('survives something that is not an Error at all', () => {
    const f = describeAuthError('nope');
    expect(f.code).toBe('unknown');
    expect(f.message).toBe('Sign-in failed.');
  });
});
