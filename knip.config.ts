import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  ignoreBinaries: ['build'],
  ignoreDependencies: ['@noble/curves'],
  rules: {
    exports: 'off',
    types: 'off',
    unlisted: 'off',
  },
  compilers: {
    css: (text: string) =>
      [...text.matchAll(/(?<=@)import[^;]+/g)].join('\n'),
  },
  workspaces: {
    'packages/client': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
    },
    'packages/server': {
      entry: ['main.ts'],
      project: ['lib/**/*.ts'],
    },
    'packages/relay': {
      entry: ['index.html'],
      project: ['src/**'],
    },
  },
};

export default config;
