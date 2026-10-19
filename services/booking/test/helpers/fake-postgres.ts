import { createServer, type Server, type Socket } from "node:net";

// Minimal PostgreSQL wire-protocol server for driver-level tests: accepts any
// startup without TLS or password, then either answers simple queries with a
// single row ("respond") or never answers them ("hang"), keeping the
// connection open — like a stuck server or a black-holed network path.

export type FakePostgresMode = "hang" | "respond";

export type FakePostgres = {
  port: number;
  setMode: (mode: FakePostgresMode) => void;
  queriesReceived: () => number;
  closedConnections: () => number;
  waitFor: (condition: () => boolean, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
};

const message = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

const int32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};

const int16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};

const cstring = (value: string): Buffer => Buffer.from(`${value}\0`, "utf8");

const READY = message("Z", Buffer.from("I"));
const AUTH_OK = message("R", int32(0));

// RowDescription + DataRow for `SELECT 1` (one int4 column), then completion.
const SELECT_ONE_RESPONSE = Buffer.concat([
  message(
    "T",
    Buffer.concat([
      int16(1),
      cstring("?column?"),
      int32(0),
      int16(0),
      int32(23),
      int16(4),
      int32(-1),
      int16(0),
    ]),
  ),
  message("D", Buffer.concat([int16(1), int32(1), Buffer.from("1")])),
  message("C", cstring("SELECT 1")),
  READY,
]);

export const startFakePostgres = async (): Promise<FakePostgres> => {
  let mode: FakePostgresMode = "respond";
  let queries = 0;
  let closed = 0;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let started = false;
    let pending = Buffer.alloc(0);

    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      closed += 1;
    });

    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);

      if (!started) {
        if (pending.length < 4) {
          return;
        }
        const length = pending.readInt32BE(0);
        if (pending.length < length) {
          return;
        }
        pending = pending.subarray(length);
        started = true;
        socket.write(Buffer.concat([AUTH_OK, READY]));
      }

      while (pending.length >= 5) {
        const type = String.fromCharCode(pending.readUInt8(0));
        const length = pending.readInt32BE(1);
        if (pending.length < length + 1) {
          return;
        }
        pending = pending.subarray(length + 1);

        if (type === "X") {
          socket.end();
          return;
        }
        if (type === "Q") {
          queries += 1;
          if (mode === "respond") {
            socket.write(SELECT_ONE_RESPONSE);
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake postgres has no port");
  }

  return {
    port: address.port,
    setMode: (next) => {
      mode = next;
    },
    queriesReceived: () => queries,
    closedConnections: () => closed,
    // Polls a condition instead of sleeping for an arbitrary time.
    waitFor: async (condition, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) {
          throw new Error("condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
