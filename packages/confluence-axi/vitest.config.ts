import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Before anything else in every test file: no test can find the desktop's
    // real password store, or the real settings folder.
    setupFiles: ["test/setup.ts"],
  },
});
