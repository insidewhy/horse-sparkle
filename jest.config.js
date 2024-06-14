export default {
  testEnvironment: 'node',
  testRegex: 'spec\\.ts$',
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        diagnostics: false,
        tsconfig: "<rootDir>/src/tsconfig.json",
      }
    ]
  },
  roots: ['<rootDir>/src'],
  coveragePathIgnorePatterns: ['expectAfterSomeTicks.ts']
}
