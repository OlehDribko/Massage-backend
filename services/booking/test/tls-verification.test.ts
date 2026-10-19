import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { killRunningChildren, startTsProcess } from "./helpers/child-process.js";

// A fake PostgreSQL server that answers the SSLRequest and completes a TLS
// handshake with a certificate for DNS:localhost signed by a throw-away CA.
// It never speaks the rest of the protocol: the test only observes whether
// the client accepted the certificate.

const SSL_REQUEST_CODE = 80877103;

// These tests require the `openssl` CLI. Without it they fail (not skip), so a
// missing tool never looks like a passed TLS check.
const run = (args: string[], cwd: string) => {
  const result = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`openssl is required for TLS verification tests: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`openssl ${args[0] ?? ""} failed: ${result.stderr}`);
  }
};

let dir = "";
let server: Server | undefined;
let port = 0;
const events: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "booking-tls-"));
  run(
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
      "-days", "1", "-subj", "/CN=Booking Test CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign",
    ],
    dir,
  );
  run(
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr",
      "-subj", "/CN=localhost"],
    dir,
  );
  writeFileSync(
    join(dir, "ext.cnf"),
    "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  run(
    ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
      "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "ext.cnf"],
    dir,
  );

  const key = readFileSync(join(dir, "server.key"));
  const cert = readFileSync(join(dir, "server.pem"));

  const fake = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (chunk) => {
      if (
        typeof chunk === "string" ||
        chunk.length < 8 ||
        chunk.readUInt32BE(4) !== SSL_REQUEST_CODE
      ) {
        events.push("plain-startup");
        socket.destroy();
        return;
      }
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, key, cert });
      secure.on("secure", () => {
        events.push("tls-established");
        secure.destroy();
      });
      secure.on("error", () => {
        events.push("tls-failed");
      });
    });
  });
  server = fake;

  // Default host binds dual-stack, so "localhost" works via ::1 or 127.0.0.1.
  await new Promise<void>((resolve) => fake.listen(0, () => resolve()));
  const address = fake.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake server has no port");
  }
  port = address.port;
});

afterEach(async () => {
  await killRunningChildren();
  events.length = 0;
});

afterAll(async () => {
  const fake = server;
  if (fake !== undefined) {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

const outcomeSchema = z.object({ result: z.enum(["connected", "error"]), code: z.string().optional() });

const connect = async (
  host: string,
  sslMode: "verify-full" | "disable",
  trustTestCa: boolean,
) => {
  const child = startTsProcess("test/fixtures/pg-tls-client.ts", {
    TEST_DATABASE_URL: `postgresql://user:pass@${host}:${port}/db`,
    TEST_SSL_MODE: sslMode,
    ...(trustTestCa ? { NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") } : {}),
  });
  await child.exited;
  const line = child
    .output()
    .split("\n")
    .find((candidate) => candidate.startsWith('{"result"'));
  if (line === undefined) {
    throw new Error(`no outcome; output:\n${child.output()}`);
  }
  const parsed: unknown = JSON.parse(line);
  return outcomeSchema.parse(parsed);
};

const TLS_ERRORS = [
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
];

describe("DATABASE_SSL_MODE=verify-full", () => {
  it("completes the TLS handshake with a trusted certificate for the requested host", async () => {
    const outcome = await connect("localhost", "verify-full", true);

    expect(events).toContain("tls-established");
    // The fake server stops after the handshake, so the client then fails
    // with a protocol error, not with a certificate error.
    expect(TLS_ERRORS).not.toContain(outcome.code);
  });

  it("rejects a trusted certificate issued for a different hostname", async () => {
    const outcome = await connect("127.0.0.1", "verify-full", true);

    expect(outcome).toEqual({ result: "error", code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(events).not.toContain("tls-established");
  });

  it("rejects a certificate from an untrusted CA", async () => {
    const outcome = await connect("localhost", "verify-full", false);

    expect(outcome).toEqual({ result: "error", code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    expect(events).not.toContain("tls-established");
  });
});

describe("DATABASE_SSL_MODE=disable", () => {
  it("does not attempt TLS", async () => {
    await connect("localhost", "disable", false);

    expect(events).toEqual(["plain-startup"]);
  });
});
