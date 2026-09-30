/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/spec'],
    testMatch: ['**/*.spec.ts'],
    testTimeout: 120000,
    maxWorkers: '50%',
    collectCoverageFrom: ['src/**/*.{ts,tsx}'],
    coverageThreshold: {
        // keep the bar just below the measured values so small platform
        // variance stays green while real regressions fail loudly
        global: {
            statements: 95,
            branches: 88,
            functions: 92,
            lines: 95,
        },
    },
};

