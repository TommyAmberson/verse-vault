export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 50],
    'body-max-line-length': [2, 'always', 72],
    'scope-enum': [
      2,
      'always',
      ['core', 'wasm', 'sim', 'api', 'web', 'desktop', 'cli', 'tools', 'docs'],
    ],
  },
};
