import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Child-process tests start real servers; keep a generous per-test ceiling.
    testTimeout: 20_000,
  },
});
