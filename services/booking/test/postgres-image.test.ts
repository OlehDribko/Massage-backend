import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Integration tests, the Docker smoke test and CI must use the same
// PostgreSQL image as the local Compose stack.

const repoFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const match = (text: string, pattern: RegExp): string | undefined => pattern.exec(text)?.[1];

describe("PostgreSQL image version", () => {
  it("is the same in compose.yaml, the test helper and the CI workflow", () => {
    const compose = match(repoFile("compose.yaml"), /\$\{POSTGRES_IMAGE:-([^}]+)\}/);
    const helper = match(
      repoFile("services/booking/test/integration/helpers/postgres-container.ts"),
      /INTEGRATION_POSTGRES_IMAGE \?\? "([^"]+)"/,
    );
    const workflow = match(repoFile(".github/workflows/ci.yml"), /^\s+POSTGRES_IMAGE: (\S+)$/m);

    expect(compose).toMatch(/^postgres:\d+\.\d+-/);
    expect(helper).toBe(compose);
    expect(workflow).toBe(compose);
  });
});
