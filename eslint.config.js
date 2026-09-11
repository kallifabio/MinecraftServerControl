'use strict';

const nodeGlobals = {
    require: 'readonly',
    module: 'readonly',
    exports: 'writable',
    __dirname: 'readonly',
    __filename: 'readonly',
    process: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    queueMicrotask: 'readonly'
};

const browserGlobals = {
    window: 'readonly',
    document: 'readonly',
    console: 'readonly',
    fetch: 'readonly',
    CustomEvent: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    prompt: 'readonly',
    FileReader: 'readonly',
    Uint8Array: 'readonly'
};

const baseRules = {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-undef': 'error',
    eqeqeq: ['warn', 'smart'],
    'no-var': 'error',
    'prefer-const': 'warn'
};

module.exports = [
    {
        ignores: ['node_modules/**', 'dist/**', 'jars/**']
    },
    {
        files: ['main.js', 'lib/**/*.js', 'test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: nodeGlobals
        },
        rules: baseRules
    },
    {
        // Preload-Skripte laufen in einem Sonderkontext mit sowohl Node- als
        // auch Browser-Globals (contextIsolation).
        files: ['preload.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...nodeGlobals, ...browserGlobals }
        },
        rules: baseRules
    },
    {
        files: ['renderer/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: browserGlobals
        },
        rules: baseRules
    }
];
