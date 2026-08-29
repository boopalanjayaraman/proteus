/**
 * Firebase auth failures, said in a way someone can act on.
 *
 * The popup opening and closing with nothing on screen is the worst version of
 * this: the SDK rejects with a precise code and, if nobody catches it, the whole
 * thing surfaces as an unhandled rejection in a console the user is not looking
 * at. Every message below names the console setting that fixes it, because that
 * is where the fix always is — none of these are code bugs.
 */

export interface AuthFailure {
  code: string;
  message: string;
  /** Where to go and fix it. Absent when there is nothing to configure. */
  fix?: string;
}

const MESSAGES: Record<string, { message: string; fix?: string }> = {
  'auth/operation-not-allowed': {
    message: 'Google sign-in is not enabled for this Firebase project.',
    fix: 'Firebase console → Authentication → Sign-in method → enable Google, '
      + 'and set a project support email.',
  },
  'auth/unauthorized-domain': {
    message: 'This address is not authorized for sign-in.',
    fix: 'Firebase console → Authentication → Settings → Authorized domains → '
      + 'add this host. Note that 127.0.0.1 and localhost are different entries.',
  },
  'auth/invalid-api-key': {
    message: 'The Firebase API key is missing or wrong.',
    fix: 'Check VITE_FIREBASE_API_KEY in src/frontend/.env, then restart Vite — '
      + 'these values are inlined at build time, so a running dev server keeps the old one.',
  },
  'auth/configuration-not-found': {
    message: 'This Firebase project has no identity configuration.',
    fix: 'Firebase console → Authentication → Get started. The project exists but '
      + 'Authentication has never been enabled on it.',
  },
  'auth/popup-blocked': {
    message: 'The browser blocked the sign-in popup.',
    fix: 'Allow popups for this site and try again.',
  },
  'auth/popup-closed-by-user': {
    message: 'The sign-in window closed before it finished.',
    fix: 'If it closed on its own, the cause is usually Google sign-in not being '
      + 'enabled, or this host missing from Firebase authorized domains.',
  },
  'auth/cancelled-popup-request': {
    message: 'An earlier sign-in window was still open.',
  },
  'auth/network-request-failed': {
    message: 'Could not reach Firebase.',
    fix: 'Check the network, and any extension blocking identitytoolkit.googleapis.com.',
  },
};

/** Firebase errors carry `code`; anything else is reported as it arrives. */
export function describeAuthError(error: unknown): AuthFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown';

  const known = MESSAGES[code];
  if (known) return { code, ...known };

  return {
    code,
    message: error instanceof Error ? error.message : 'Sign-in failed.',
  };
}
