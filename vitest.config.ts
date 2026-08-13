import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tst/**/*.test.ts'],
    },
});
