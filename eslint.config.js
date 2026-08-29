import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint (TD-005).
 *
 * The architectural boundary that matters — `core/` and `verification/` may never
 * import `agent/` — is enforced by `test/architecture.test.ts` rather than a lint
 * rule. eslint-plugin-import does not yet support eslint 9, and a test states the
 * rule more directly, runs in CI with everything else, and can explain itself when
 * it fails.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', 'fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // The driver's generics force a few narrow casts at the Mongo boundary.
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['warn', { allow: ['error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
);
