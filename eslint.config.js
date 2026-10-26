import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // Errors are intentionally swallowed in many places (see AGENTS.md).
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // stdout carries the MCP stdio protocol; library code logs to stderr.
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    // The CLI talks to the user on stdout.
    files: ['bin/**/*.js', 'src/cli/**/*.js', 'scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.js'],
    rules: {
      'no-console': 'off',
      // Warn only: tests are changed only on request (AGENTS.md).
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
