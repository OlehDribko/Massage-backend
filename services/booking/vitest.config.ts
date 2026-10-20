import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Docker-based tests run separately: npm run test:integration.
    exclude: [...configDefaults.exclude, "test/integration/**"],
    environment: "node",
    // Child-process tests start real servers; keep a generous per-test ceiling.
    testTimeout: 20_000,
  },
});
