/// <reference types="vite/client" />

/**
 * Only VITE_* reaches the bundle. Declaring them means a typo is a compile
 * error, and it documents in one place exactly what the browser is given —
 * which should never be more than this.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
