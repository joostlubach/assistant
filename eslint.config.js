const FS = require('fs')
const yaml = require('yaml')

module.exports = [
  // Global ignores (applies to all configs)
  {
    ignores: [
      'bin/**',
      'dist/**',
      'node_modules/**',
      'tsconfig.json'
    ]
  },
  
  {
    files: [
      'src/**/*.ts',
    ],

    languageOptions: {
      globals: {
        ...require('globals').browser,
        ...require('globals').es2022,
      },
      
      parser: require('@typescript-eslint/parser'),
      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
        ecmaVersion: 2022,
      }
    },

    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
      '@stylistic': require('@stylistic/eslint-plugin'),
      'unused-imports': require('eslint-plugin-unused-imports'),
      '@mosdev': require('@mosdev/eslint-plugin')
    },

    rules: yaml.parse(FS.readFileSync('../../eslint.rules.yml', 'utf-8'))
  }
]