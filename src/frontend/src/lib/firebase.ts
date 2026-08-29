import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut,
  type Auth, type User as FirebaseUser,
} from 'firebase/auth';

/**
 * Firebase web config.
 *
 * These values are public by design — Vite inlines every VITE_* variable into the
 * bundle at build time, so anyone can read them. That is fine: this config
 * identifies the project, it does not protect it. Access control lives in the
 * backend's per-project ownership checks.
 */
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function firebaseAuth(): Auth {
  if (!auth) {
    app = initializeApp(config);
    auth = getAuth(app);
  }
  return auth;
}

export const signInWithGoogle = () =>
  signInWithPopup(firebaseAuth(), new GoogleAuthProvider());

export const signOutOfProteus = () => signOut(firebaseAuth());

export const watchAuth = (cb: (user: FirebaseUser | null) => void) =>
  onAuthStateChanged(firebaseAuth(), cb);

/**
 * A current token, refreshed when close to expiry.
 *
 * Passed to the API and stream clients as a function rather than a value, so a
 * long-running migration screen cannot end up holding a token that expired an
 * hour ago.
 */
export const currentToken = async (): Promise<string | null> =>
  (await firebaseAuth().currentUser?.getIdToken()) ?? null;

export type { FirebaseUser };
