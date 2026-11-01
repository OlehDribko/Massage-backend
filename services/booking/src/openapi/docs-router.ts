import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Router } from "express";
import { buildOpenApiDocument } from "./document.js";

/**
 * API documentation, mounted only when ENABLE_API_DOCS=true (off by
 * default): GET /openapi.json and Swagger UI at /docs. Everything is served
 * from this process: the document is built from code (no database,
 * Firebase or Brevo), the UI from the swagger-ui-dist package (no CDN), with
 * the online validator off. The token pasted in "Authorize" is not stored
 * (persistAuthorization: false); "Try it out" calls this origin.
 */
/** The only files of swagger-ui-dist we serve (not its demo index and initializer). */
const ASSETS = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "text/javascript; charset=utf-8",
  "favicon-32x32.png": "image/png",
} satisfies Record<string, string>;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Massage booking API</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
    <link rel="icon" type="image/png" href="/docs/favicon-32x32.png" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/swagger-init.js"></script>
  </body>
</html>
`;

const INIT_JS = `window.ui = SwaggerUIBundle({
  url: "/openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  persistAuthorization: false,
  validatorUrl: "none",
  tryItOutEnabled: false,
  displayRequestDuration: true,
});
`;

export const createDocsRouter = (): Router => {
  const router = Router();
  // Resolved only when the documentation is switched on.
  const swaggerUiDir = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));
  // Built once, from code only.
  const document = JSON.stringify(buildOpenApiDocument());

  router.get("/openapi.json", (_req, res) => {
    res.type("application/json").send(document);
  });

  // "/docs" and "/docs/" reach the same route (non-strict routing): the
  // page needs the trailing slash for its relative state, so redirect once.
  router.get("/docs", (req, res) => {
    if (!req.originalUrl.split("?")[0]?.endsWith("/")) {
      res.redirect(301, "/docs/");
      return;
    }
    res.type("text/html; charset=utf-8").send(INDEX_HTML);
  });

  router.get("/docs/swagger-init.js", (_req, res) => {
    res.type("text/javascript; charset=utf-8").send(INIT_JS);
  });

  for (const [file, type] of Object.entries(ASSETS)) {
    router.get(`/docs/${file}`, (_req, res) => {
      res.type(type).sendFile(join(swaggerUiDir, file));
    });
  }

  return router;
};
