module.exports = [
  {
    files: [
      'main/**/*.js',
      'security-utils.js',
      'license-utils.js',
      'preload.js',
      'scripts/**/*.js',
      'tests/**/*.js'
    ],
    ignores: ['dist/**', 'node_modules/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs'
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-with': 'error'
    }
  }
];
