import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'fixtures/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            '禁止使用 Math.random()；请使用可寻址随机源 R(seed, tick, agentId, eventTag, counter)。',
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'crypto'],
              message: 'src/core 不得依赖 Node 运行时。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'src/core 不得发起网络请求。' },
        { name: 'localStorage', message: 'src/core 不得访问浏览器存储。' },
        { name: 'performance', message: 'src/core 不得读取 wall clock。' },
        { name: 'process', message: 'src/core 不得依赖 Node 运行时。' },
        { name: 'Buffer', message: 'src/core 不得依赖 Node 运行时。' },
        { name: 'setTimeout', message: 'src/core 不得自行调度定时器。' },
        { name: 'setInterval', message: 'src/core 不得自行调度定时器。' },
        { name: 'queueMicrotask', message: 'src/core 不得自行调度微任务。' },
        { name: 'crypto', message: 'src/core 不得使用运行时熵源或非确定性加密接口。' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: '禁止使用 Math.random()；请使用可寻址随机源。',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'src/core 不得读取 wall clock；时间必须由调用方注入。',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: 'src/core 不得读取 wall clock；时间必须由调用方注入。',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts', '**/*.config.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
