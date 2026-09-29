import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'e2e/output/**', 'client/art-preview.html'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['client/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['client/src/workers/**', 'client/src/sw/**'],
    languageOptions: { globals: { ...globals.worker, ...globals.serviceworker } },
  },
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'scripts/**', 'e2e/**', '*.config.{js,ts}', 'client/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
);
