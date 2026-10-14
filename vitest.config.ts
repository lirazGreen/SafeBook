import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before every test file's module graph is loaded, so it pins LLM_MODE
    // before src/config/env.ts reads process.env. See the file for why.
    setupFiles: ['tests/setup/offlineLlm.ts'],
  },
});
