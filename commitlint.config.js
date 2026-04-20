export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Subject is the most visible part of `git log --oneline`; keep it strict.
    'header-max-length': [2, 'always', 50],
    // Body/footer line length stays a warning: legitimate exceptions exist
    // (quoted URLs, stack traces, long issue refs).
    'body-max-line-length': [1, 'always', 72],
    'footer-max-line-length': [1, 'always', 72],
    // Warn (not error) so solo drift gets surfaced without blocking; empty
    // scopes are still allowed (for cross-cutting chores like tooling bumps).
    'scope-enum': [
      1,
      'always',
      ['core', 'wasm', 'sim', 'api', 'web', 'desktop', 'cli', 'tools', 'docs'],
    ],
  },
};
