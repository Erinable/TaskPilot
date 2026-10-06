// Lint rules for the conventions in AGENTS.md that a tool can check.
// Formatting is Prettier's job (eslint-config-prettier turns off the
// overlapping style rules).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'evals/product-lead/reports/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
    rules: {
      // Functions are const arrow functions; classes keep their methods.
      'func-style': ['error', 'expression'],
      'prefer-arrow-callback': 'error',
      // Comments use // only.
      'multiline-comment-style': ['error', 'separate-lines'],
      // Export inline where a symbol is defined.
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportNamedDeclaration[declaration=null][source=null]', message: 'Export inline where the symbol is defined.' },
        {
          selector: 'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Build DOM with textContent / DOM APIs; agent text must never become markup.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'Build DOM with textContent / DOM APIs; agent text must never become markup.',
        },
      ],
      // process.env is read in one config module only.
      'no-restricted-properties': ['error', { object: 'process', property: 'env', message: 'Read configuration from src/main/env.ts.' }],
      'vue/no-v-html': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Single-word view names (QueueView is two) and short prop forms are the project's style.
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    // The config module, scripts and tests may read the environment directly.
    files: ['src/main/env.ts', 'evals/**', 'tests/**', '*.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Tests feed malformed input on purpose and stub loosely typed globals.
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
