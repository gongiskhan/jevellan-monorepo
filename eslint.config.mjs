// Lint of the repository (`npm run lint`, which is `eslint .`). Copied from gongiskhan/jevellan at 8e2788ec and
// adjusted to this layout: the build output of every package (dist/, dist-test/), test and evidence output, the
// lifted viewer's plain browser scripts (packages/ui/viewer, served as they are) and agent folders are not linted.
// The rule adjustments keep the lifted runtime's style legal without hiding real defects: a leading underscore
// marks a deliberately unused name (a rest sibling dropped from an object, an argument a signature requires), and
// tests may use `any` for parsed JSON and spell indented output out in regular expressions. The compiler stays the
// main lint (strict, noUncheckedIndexedAccess, noImplicitOverride; M-010). M-003 records the three lint packages.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Node's globals, written out because the `globals` package is not a dependency (no new dependencies).
const nodeGlobals = Object.fromEntries(
  [
    'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'AbortController',
    'AbortSignal', 'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'TextEncoder', 'TextDecoder',
    'performance', 'crypto', 'EventTarget', 'Event',
  ].map((name) => [name, 'readonly']),
);

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-test/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
      '**/.jv-evidence/**',
      '.claude/**',
      '.codex/**',
      'acceptance/shots/**',
      'packages/ui/viewer/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: nodeGlobals } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['packages/*/test/**', 'scripts/test/**', 'acceptance/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-regex-spaces': 'off',
    },
  },
);
