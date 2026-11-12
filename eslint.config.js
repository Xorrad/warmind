/**
 * ESLint flat config. `npm run lint` checks every JS file; CI runs it on
 * each push and pull request.
 *
 * Environments: client/ runs in the browser, server/ and tests/ in Node,
 * engine/ is pure (shared by both): it gets no environment globals, which
 * keeps DOM and Node APIs out of it.
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['node_modules/', 'docs/', 'data/', 'coverage/'] },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: {
            // Unused names starting with "_" are deliberate
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-var': 'error',
            'prefer-const': 'error',
            'no-implicit-globals': 'error',
            'no-shadow': ['error', { builtinGlobals: false }],
            'no-console': 'off',
        },
    },
    {
        files: ['engine/**/*.js'],
        rules: {
            // Determinism: randomness comes from the seeded rng (engine/rng.js)
            'no-restricted-properties': [
                'error',
                { object: 'Math', property: 'random', message: 'Use the seeded rng from engine/rng.js.' },
            ],
        },
    },
    { files: ['client/**/*.js'], languageOptions: { globals: globals.browser } },
    { files: ['server/**/*.js', 'tests/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
];
