// Writes the OpenAPI document built from code to docs/openapi.json (the
// committed contract for the frontend; the live /openapi.json is off unless
// ENABLE_API_DOCS=true). Run after changing routes or schemas:
//   npm run openapi:export -w services/booking
// test/openapi-snapshot.test.ts fails while the file is out of date.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../../src/openapi/document.js";

export const OPENAPI_SNAPSHOT_PATH = fileURLToPath(new URL("../../../../docs/openapi.json", import.meta.url));

export const serializeOpenApi = (): string => `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OPENAPI_SNAPSHOT_PATH, serializeOpenApi());
  console.log(`OpenAPI written to ${OPENAPI_SNAPSHOT_PATH}`);
}
