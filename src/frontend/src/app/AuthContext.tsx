import type { User } from '@proteus/schema';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiClient } from '../api/client';
import { currentToken, signInWithGoogle, signOutOfProteus, watchAuth, type FirebaseUser } from '../lib/firebase';

interface AuthState {
  firebaseUser: FirebaseUser | null;
  profile: User | null;
  api: ApiClient;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  setProfile: (u: User) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const api = useMemo(
    () => new ApiClient(import.meta.env.VITE_API_BASE_URL ?? '', currentToken),
    [],
  );

  useEffect(() => watchAuth(async (u) => {
    setFirebaseUser(u);
    if (u) {
      // GET /me creates the profile on first sign-in and returns preferences,
      // which the theme reads before first paint settles.
      try { setProfile(await api.me()); } catch { setProfile(null); }
    } else {
      setProfile(null);
    }
    setLoading(false);
  }), [api]);

  const value: AuthState = {
    firebaseUser, profile, api, loading,
    // Deliberately not caught here. A sign-in that fails must reach the screen
    // that offered it: swallowing the rejection is how a popup opens, closes and
    // leaves the user staring at an unchanged page with the reason in a console
    // they are not looking at.
    signIn: async () => { await signInWithGoogle(); },
    signOut: async () => { await signOutOfProteus(); },
    setProfile,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth used outside AuthProvider');
  return ctx;
}
