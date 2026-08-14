module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', {}] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 60000,
};
