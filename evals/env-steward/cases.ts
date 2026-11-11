import type { ScriptKind } from '../../src/shared/ipc/environment.ts';

export type EnvironmentCase = {
  id: string;
  files: Record<string, string>;
  configurationExpected: boolean;
  requiredChecks: ScriptKind[];
};

export const cases: EnvironmentCase[] = [
  {
    id: 'expo-skeleton',
    files: {
      'package.json': JSON.stringify({
        name: 'morning-news',
        private: true,
        scripts: { start: 'expo start', android: 'expo start --android', ios: 'expo start --ios', test: 'jest' },
        dependencies: { expo: '~58.0.0', react: '19.3.0', 'react-native': '0.88.1' },
        devDependencies: { typescript: '~6.0.0', jest: '^30.0.0', 'jest-expo': '~58.0.0' },
      }),
      'tsconfig.json': '{"extends":"expo/tsconfig.base","compilerOptions":{"strict":true}}',
      'taskpilot.toml': 'preset = "typescript"\n',
      '.gitignore': 'node_modules/\n.expo/\n.env\n',
    },
    configurationExpected: true,
    requiredChecks: ['typecheck', 'lint', 'format'],
  },
  {
    id: 'configured-node',
    files: {
      'package.json': JSON.stringify({
        name: 'ready-app',
        private: true,
        engines: { node: '>=22' },
        scripts: {
          test: 'vitest run',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          'format:check': 'prettier --check .',
          build: 'tsc',
          coverage: 'vitest run --coverage',
        },
        devDependencies: {
          typescript: '^5.9.0',
          vitest: '^3.0.0',
          '@vitest/coverage-v8': '^3.0.0',
          eslint: '^9.0.0',
          'typescript-eslint': '^8.0.0',
          prettier: '^3.0.0',
        },
      }),
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
      'tsconfig.json': '{"compilerOptions":{"strict":true,"outDir":"dist"},"include":["src"]}',
      'eslint.config.js': 'import tseslint from "typescript-eslint"; export default tseslint.configs.recommended;',
      '.prettierrc.json': '{"singleQuote":true}',
      '.prettierignore': 'dist/\nnode_modules/\n',
      '.nvmrc': '22\n',
      '.github/workflows/ci.yml':
        'name: checks\non: [push]\njobs:\n  checks:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n      - run: npm ci\n      - run: npm run lint\n      - run: npm run typecheck\n      - run: npm run format:check\n      - run: npm test\n      - run: npm run coverage\n      - run: npm run build\n',
      'taskpilot.toml': 'preset = "typescript"\n',
    },
    configurationExpected: false,
    requiredChecks: [],
  },
  {
    id: 'javascript-without-checks',
    files: {
      'package.json': JSON.stringify({ name: 'simple-js', private: true, scripts: { start: 'node src/index.js' }, engines: { node: '>=22' } }),
      'src/index.js': 'console.log("hello");\n',
      '.gitignore': 'node_modules/\n.env\n',
    },
    configurationExpected: true,
    requiredChecks: ['lint', 'format'],
  },
];
