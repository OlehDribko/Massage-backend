import { defineConfig } from "vitest/config";

// Smoke test of the built Docker images; needs a running Docker daemon and the
// image names in BOOKING_RUNTIME_IMAGE / BOOKING_MIGRATE_IMAGE. Fails (never
// skips) when either is missing. Run with: npm run test:smoke
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.test.ts"],
    environment: "node",
    testTimeout: 360_000,
    hookTimeout: 360_000,
    fileParallelism: false,
  },
});
