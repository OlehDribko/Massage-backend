import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENAPI_SNAPSHOT_PATH, serializeOpenApi } from "./tools/export-openapi.js";

describe("docs/openapi.json", () => {
  it("is the document built from the code (run npm run openapi:export -w services/booking after API changes)", () => {
    expect(readFileSync(OPENAPI_SNAPSHOT_PATH, "utf8")).toBe(serializeOpenApi());
  });
});
