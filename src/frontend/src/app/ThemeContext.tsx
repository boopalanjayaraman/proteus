import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';

type Theme = 'dark' | 'light';

/**
 * Theme, persisted server-side.
 *
 * The authoritative value lives in `users.preferences` so it follows the user to
 * another device. localStorage holds a copy used only as a paint hint — without
 * it the first frame renders in the default theme and then flips, which is
 * exactly the flicker recorded as a risk in PRD-04 §8.
 */
const STORAGE_KEY = 'proteus.theme.hint';

const Ctx = createContext<{ theme: Theme; toggle: () => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { profile, api, setProfile } = useAuth();
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'dark',
  );

  // The server value wins once the profile has loaded.
  useEffect(() => {
    if (profile?.preferences.theme && profile.preferences.theme !== theme) {
      setTheme(profile.preferences.theme);
    }
  }, [profile?.preferences.theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // Optimistic: the toggle must feel instant. A failed write leaves the hint
    // correct for this device and reconciles on next sign-in.
    void api.updatePreferences({ theme: next }).then(setProfile).catch(() => undefined);
  };

  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme used outside ThemeProvider');
  return ctx;
}
