// Local test client for real Firebase sign-in (docs/firebase-staging-checklist.md).
// Serves the page on http://localhost:5173 and forwards /api/* and /health/*
// to API_BASE_URL, so the backend needs no CORS change for localhost.
// No dependencies. Never logs request headers or bodies (ID tokens).
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? "5173");
const apiBase = new URL(process.env.API_BASE_URL ?? "http://127.0.0.1:3001");
const local = ["127.0.0.1", "localhost", "[::1]"].includes(apiBase.hostname);
if (apiBase.protocol !== "https:" && !local) {
  console.error("API_BASE_URL must be https (or a local http address)");
  process.exit(1);
}

const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/firebase-config.json": ["firebase-config.local.json", "application/json"],
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const forward = async (req, res) => {
  const target = new URL(req.url, apiBase);
  const headers = {};
  for (const name of ["authorization", "content-type"]) {
    if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
  }
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  try {
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: "manual" });
    const out = { "content-type": upstream.headers.get("content-type") ?? "text/plain" };
    for (const name of ["retry-after", "www-authenticate"]) {
      const value = upstream.headers.get(name);
      if (value !== null) out[name] = value;
    }
    res.writeHead(upstream.status, out).end(Buffer.from(await upstream.arrayBuffer()));
    console.log(`${req.method} ${target.pathname} -> ${upstream.status}`);
  } catch {
    res.writeHead(502, { "content-type": "application/json" }).end('{"code":"API_UNREACHABLE"}');
    console.log(`${req.method} ${target.pathname} -> API unreachable`);
  }
};

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path.startsWith("/api/") || path.startsWith("/health/")) {
    await forward(req, res);
    return;
  }
  const file = files[path];
  if (file === undefined || req.method !== "GET") {
    res.writeHead(404).end();
    return;
  }
  let content;
  try {
    content = await readFile(join(here, file[0]));
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end(`${file[0]} not found (see README.md)`);
    return;
  }
  res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" }).end(content);
}).listen(port, "127.0.0.1", () => {
  console.log(`Open http://localhost:${port}  (API: ${apiBase.origin})`);
});
