import { createServer, connect, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startTsProcess } from "../helpers/child-process.js";
import type { LogEntry } from "../helpers/logs.js";
import { runMigrations } from "./helpers/migrations.js";
import { CURRENT_INIT_DIR, assertDockerAvailable, startPostgres, type PostgresContainer } from "./helpers/postgres-container.js";

// The owner's assign-role command against real PostgreSQL (runtime role),
// without Firebase: profiles are inserted directly. A TCP proxy that delays
// every new connection reproduces a database waking up (Neon after 5 min idle),
// the cause of P2028 "Unable to start a transaction in the given time" in staging.

let db: PostgresContainer;
let proxy: Server;
const sockets = new Set<Socket>();
let proxyPort = 0;
let connectDelayMs = 0;

const VERIFIED = "00000000-0000-4000-8000-0000000000a1";
const UNVERIFIED = "00000000-0000-4000-8000-0000000000a2";
const ANONYMOUS = "00000000-0000-4000-8000-0000000000a3";

beforeAll(async () => {
  assertDockerAvailable();
  db = await startPostgres(CURRENT_INIT_DIR);
  await runMigrations(db);
  await db.query(
    "migrator",
    `INSERT INTO "UserProfile" (id, "firebaseUid", email, "emailVerified", "isAnonymous", "signInProvider", "identityIssuedAt", "updatedAt") VALUES
       ('${VERIFIED}', 'uid-verified', 'owner@example.invalid', true, false, 'password', now(), now()),
       ('${UNVERIFIED}', 'uid-unverified', 'new@example.invalid', false, false, 'password', now(), now()),
       ('${ANONYMOUS}', 'uid-anonymous', NULL, false, true, 'anonymous', now(), now())`,
  );

  proxy = createServer((incoming) => {
    sockets.add(incoming);
    incoming.pause();
    setTimeout(() => {
      const outgoing = connect(db.port, "127.0.0.1", () => {
        incoming.pipe(outgoing).pipe(incoming);
        incoming.resume();
      });
      sockets.add(outgoing);
      const end = () => {
        incoming.destroy();
        outgoing.destroy();
      };
      incoming.on("error", end).on("close", end);
      outgoing.on("error", end).on("close", end);
    }, connectDelayMs);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (address === null || typeof address === "string") {
    throw new Error("no proxy port");
  }
  proxyPort = address.port;
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  db.stop();
});

const urlThroughProxy = () => {
  const url = new URL(db.url("app"));
  url.hostname = "127.0.0.1";
  url.port = String(proxyPort);
  return url.toString();
};

const run = async (args: string[], options: { url?: string } = {}) => {
  const child = startTsProcess(
    "src/admin/assign-role.ts",
    { DATABASE_URL: options.url ?? db.url("app"), DATABASE_SSL_MODE: "disable" },
    args,
  );
  const exit = await child.exited;
  return { code: exit.code, entries: child.entries(), output: child.output() };
};

const roleOf = async (id: string) => {
  const result = await db.query("migrator", `SELECT role FROM "UserProfile" WHERE id = '${id}'`);
  return z.array(z.object({ role: z.string() })).parse(result.rows)[0]?.role;
};

const last = (entries: LogEntry[]) => entries.at(-1) ?? {};

const grant = (id: string, email: string, ...extra: string[]) => ["--profile-id", id, "--email", email, "--role", "admin", ...extra];

describe("assign-role command", () => {
  it("dry run reports what would change and changes nothing; --apply is required", async () => {
    const dryRun = await run(grant(VERIFIED, "OWNER@example.invalid"));
    expect(dryRun.code).toBe(0);
    expect(last(dryRun.entries)).toMatchObject({
      msg: "dry run: nothing changed (add --apply)",
      dryRun: true,
      previousRole: "client",
      role: "admin",
      changed: true,
      applied: false,
    });
    expect(await roleOf(VERIFIED)).toBe("client");
  });

  it("refusals exit with 2 and the reason, without changing anything", async () => {
    const cases: [string[], string][] = [
      [grant(UNVERIFIED, "new@example.invalid", "--apply"), "email_not_verified"],
      [grant(VERIFIED, "someone@example.invalid", "--apply"), "email_mismatch"],
      [grant(ANONYMOUS, "x@example.invalid", "--apply"), "email_mismatch"],
      [grant("00000000-0000-4000-8000-000000000000", "x@example.invalid", "--apply"), "profile_not_found"],
    ];
    for (const [args, reason] of cases) {
      const result = await run(args);
      expect(result.code, reason).toBe(2);
      expect(last(result.entries), reason).toMatchObject({ msg: "role assignment refused", reason });
    }
    expect(await roleOf(UNVERIFIED)).toBe("client");
    expect(await roleOf(VERIFIED)).toBe("client");
  });

  it("invalid arguments exit with 1 before connecting", async () => {
    const result = await run(["--profile-id", "not-a-uuid", "--email", "owner@example.invalid", "--role", "root"]);
    expect(result.code).toBe(1);
    expect(last(result.entries)).toMatchObject({ msg: "invalid configuration" });
  });

  it("a slowly waking database (connect takes > 2 s) still gets a dry run and then the change", async () => {
    connectDelayMs = 3_500;
    try {
      const dryRun = await run(grant(VERIFIED, "owner@example.invalid"), { url: urlThroughProxy() });
      expect(dryRun.code, dryRun.output).toBe(0);
      expect(last(dryRun.entries)).toMatchObject({ msg: "dry run: nothing changed (add --apply)", applied: false });
      expect(await roleOf(VERIFIED)).toBe("client");

      const applied = await run(grant(VERIFIED, "owner@example.invalid", "--apply"), { url: urlThroughProxy() });
      expect(applied.code, applied.output).toBe(0);
      expect(last(applied.entries)).toMatchObject({ msg: "role assignment done", previousRole: "client", role: "admin", applied: true });
      expect(await roleOf(VERIFIED)).toBe("admin");
      expect(applied.output).not.toContain("postgresql://");
    } finally {
      connectDelayMs = 0;
    }
  });

  it("running --apply again is a no-op; revoking needs only the email match", async () => {
    const again = await run(grant(VERIFIED, "owner@example.invalid", "--apply"));
    expect(again.code).toBe(0);
    expect(last(again.entries)).toMatchObject({ previousRole: "admin", changed: false, applied: false });

    const revoke = await run(["--profile-id", VERIFIED, "--email", "owner@example.invalid", "--role", "client", "--apply"]);
    expect(revoke.code).toBe(0);
    expect(await roleOf(VERIFIED)).toBe("client");
  });

  it("an unreachable database exits with 1 and logs the stage and a safe reason, not the URL", async () => {
    const url = new URL(db.url("app"));
    url.port = "9";
    const result = await run(grant(VERIFIED, "owner@example.invalid"), { url: url.toString() });
    expect(result.code).toBe(1);
    expect(last(result.entries)).toMatchObject({ msg: "role assignment failed", stage: "connect", cause: "database_unreachable" });
    expect(result.output).not.toContain(url.password);
    expect(result.output).not.toContain("postgresql://");
  });
});
