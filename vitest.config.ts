import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'plugin/tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
