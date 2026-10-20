import { defineConfig } from "vitest/config";

// Integration tests need a running Docker daemon; they fail (never skip) when
// it is unavailable. Run with: npm run test:integration
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
