// Lint rules for the conventions in AGENTS.md that a tool can check.
// Formatting is Prettier's job (eslint-config-prettier turns off the
// overlapping style rules).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// What agents/ must not import: they render the data they are given and
// never read repository configuration or course packs themselves.
const AGENT_IMPORT_BANS = [
  { group: ['**/presets/*', '**/project_config.ts', '**/courses.ts', '**/course_file.ts'], message: 'Agents receive data; load it in the caller.' },
  { group: ['smol-toml'], message: 'Agents receive data; parse TOML in the caller.' },
];

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'evals/*/reports/**', '**/*.d.ts'] },
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
    files: ['src/**/*.{ts,vue}'],
    rules: { complexity: ['warn', { max: 20, variant: 'classic' }] },
  },
  {
    // Components and views read stores; only stores and lib/ talk to the main process.
    files: ['src/renderer/src/components/**/*.{ts,vue}', 'src/renderer/src/views/**/*.{ts,vue}'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration from src/main/env.ts.' },
        { object: 'window', property: 'taskpilot', message: 'Call the main process through a store in src/renderer/src/stores/.' },
      ],
    },
  },
  {
    // [人工决策-2026-10-26 15:38:21] agents/ 只接收课程包等数据结构并渲染，不读 presets、project_config、课程包加载器或 toml。
    files: ['src/main/agents/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: AGENT_IMPORT_BANS }] },
  },
  {
    // Writes the CLIs' own TOML config, not repository configuration.
    files: ['src/main/agents/native_model_profile.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: AGENT_IMPORT_BANS.filter((ban) => !ban.group.includes('smol-toml')) }] },
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
