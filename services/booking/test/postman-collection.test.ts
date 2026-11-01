import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adminCancelSchema, clientCancelSchema, createBookingSchema, idempotencyKeySchema, rescheduleBookingSchema } from "../src/modules/bookings/booking.schema.js";
import { actionTokenSchema } from "../src/modules/email/schema/email.schema.js";
import { MARKETING_CONSENT_TEXT_VERSION } from "../src/modules/marketing/consent.js";
import { subscribeSchema } from "../src/modules/marketing/marketing.routes.js";
import { ownSubscriptionSchema, syncSchema } from "../src/modules/profiles/profile.routes.js";
import { updateOwnProfileSchema } from "../src/modules/profiles/profile.schema.js";
import { scheduleExceptionSchema, weeklyScheduleSchema } from "../src/modules/schedule/schedule.schema.js";
import { buildOpenApiDocument } from "../src/openapi/document.js";

// The Postman collection (postman/, docs/postman.md) against the current API:
// every request maps to an OpenAPI operation and every operation has a request,
// tokens match the security of the operation and the role, request bodies pass
// the validation schemas of the modules, and the files carry no secrets. The
// scripts store tokens only in the environment and never print values.

const read = (name: string): string => readFileSync(new URL(`../../../postman/${name}`, import.meta.url), "utf8");
const collectionText = read("massage-booking.postman_collection.json");
const environmentText = read("massage-staging.postman_environment.json");

const STAGING_URL = "https://5jrfe932fc.execute-api.eu-west-3.amazonaws.com";
const FIREBASE_PROJECT_ID = "massage-fr";
const TOKEN_VARIABLES = ["clientIdToken", "adminIdToken", "guestIdToken"];
const PERMISSION_FOLDER = "6. Permission checks (expected errors)";
const MARKETING_FOLDER = "7. Marketing — DISABLED on staging (404 NOT_FOUND)";

// --- Postman collection v2.1 (the subset used here) --------------------------

const authSchema = z.object({
  type: z.enum(["noauth", "bearer"]),
  bearer: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});
type Auth = z.infer<typeof authSchema>;
const eventSchema = z.object({ listen: z.enum(["prerequest", "test"]), script: z.object({ exec: z.array(z.string()) }) });
const requestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  auth: authSchema.optional(),
  header: z.array(z.object({ key: z.string(), value: z.string() })),
  body: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("raw"), raw: z.string() }),
      z.object({ mode: z.literal("urlencoded"), urlencoded: z.array(z.object({ key: z.string(), value: z.string() })) }),
    ])
    .optional(),
  url: z.object({
    raw: z.string(),
    host: z.array(z.string()),
    path: z.array(z.string()),
    query: z.array(z.object({ key: z.string(), value: z.string(), disabled: z.boolean().optional() })).optional(),
  }),
  description: z.string().min(1),
});
const requestItemSchema = z.object({ name: z.string(), event: z.array(eventSchema).optional(), request: requestSchema });
type Folder = { name: string; auth?: Auth | undefined; event?: z.infer<typeof eventSchema>[] | undefined; item: (Folder | z.infer<typeof requestItemSchema>)[] };
const folderSchema: z.ZodType<Folder> = z.lazy(() =>
  z.object({
    name: z.string(),
    auth: authSchema.optional(),
    event: z.array(eventSchema).optional(),
    item: z.array(z.union([requestItemSchema, folderSchema])),
  }),
);
const collectionSchema = z.object({
  info: z.object({ name: z.string(), schema: z.literal("https://schema.getpostman.com/json/collection/v2.1.0/collection.json") }),
  item: z.array(folderSchema),
});
const environmentSchema = z.object({
  name: z.string(),
  values: z.array(z.object({ key: z.string(), value: z.string(), type: z.enum(["default", "secret"]), enabled: z.literal(true) })),
  _postman_variable_scope: z.literal("environment"),
});

const parseJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};
const collection = collectionSchema.parse(parseJson(collectionText));
const environment = environmentSchema.parse(parseJson(environmentText));

type Request = { name: string; folder: string; auth: Auth; scripts: string[]; request: z.infer<typeof requestSchema> };
const flatten = (folder: Folder, top: string, inherited: Auth): Request[] =>
  folder.item.flatMap((child): Request[] => {
    const scripts = (child.event ?? []).map((event) => event.script.exec.join("\n"));
    if ("request" in child) {
      return [{ name: child.name, folder: top, auth: child.request.auth ?? inherited, scripts, request: child.request }];
    }
    return flatten(child, top, child.auth ?? inherited);
  });
const requests = collection.item.flatMap((folder) => flatten(folder, folder.name, folder.auth ?? { type: "noauth" }));
const allScripts = [
  ...requests.flatMap((r) => r.scripts),
  ...collection.item.flatMap((folder) => (folder.event ?? []).map((event) => event.script.exec.join("\n"))),
];

const isApi = (r: Request) => r.request.url.host[0] === "{{baseUrl}}";
const apiRequests = requests.filter(isApi);
const firebaseRequests = requests.filter((r) => !isApi(r));

// --- OpenAPI ------------------------------------------------------------------

const document = buildOpenApiDocument();
type Operation = { method: string; path: string; operationId: string; isPublic: boolean; hasBody: boolean };
const operations: Operation[] = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    method: method.toUpperCase(),
    path,
    operationId: operation.operationId,
    isPublic: operation.security.length === 0,
    hasBody: operation.requestBody !== undefined,
  })),
);

const isVariable = (segment: string) => /^\{\{\w+\}\}$/.test(segment);
const isTemplate = (segment: string) => /^\{\w+\}$/.test(segment);
const operationOf = (r: Request): Operation | undefined =>
  operations.find((op) => {
    const template = op.path.split("/").filter(Boolean);
    const actual = r.request.url.path;
    return (
      op.method === r.request.method &&
      template.length === actual.length &&
      template.every((segment, i) => {
        const value = actual[i] ?? "";
        return isTemplate(segment) ? isVariable(value) : segment === value;
      })
    );
  });

const bearerVariable = (auth: Auth): string | undefined => {
  const value = auth.bearer?.find((entry) => entry.key === "token")?.value;
  return value?.replace(/^\{\{(\w+)\}\}$/, "$1");
};

// Invented values for the variables of request bodies.
const SAMPLES: Record<string, string> = {
  serviceId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  bookingStartsAt: "2027-03-02T09:00:00+01:00",
  rescheduleStartsAt: "2027-03-03T10:00:00+01:00",
  marketingFormEmail: "anna@example.invalid",
  marketingActionToken: "token-from-the-emailed-link",
};
const substitute = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => SAMPLES[name] ?? `missing sample ${name}`);

const BODY_SCHEMAS: Record<string, z.ZodType> = {
  syncProfile: syncSchema,
  updateProfile: updateOwnProfileSchema,
  requestOwnSubscription: ownSubscriptionSchema,
  requestSubscription: subscribeSchema,
  confirmSubscription: actionTokenSchema,
  unsubscribeByLink: actionTokenSchema,
  createBooking: createBookingSchema,
  rescheduleBooking: rescheduleBookingSchema,
  cancelOwnBooking: clientCancelSchema,
  replaceWeeklySchedule: weeklyScheduleSchema,
  setScheduleException: scheduleExceptionSchema,
  cancelAnyBooking: adminCancelSchema,
};

describe("Postman collection", () => {
  it("every API request is an OpenAPI operation, and every operation has a request", () => {
    const unknown = apiRequests.filter((r) => operationOf(r) === undefined).map((r) => `${r.request.method} ${r.request.url.raw}`);
    expect(unknown).toEqual([]);
    const covered = new Set(apiRequests.map((r) => operationOf(r)?.operationId));
    expect(operations.filter((op) => !covered.has(op.operationId)).map((op) => op.operationId)).toEqual([]);
  });

  it("tokens follow the security of the operation and the role", () => {
    for (const r of apiRequests) {
      const op = operationOf(r);
      const token = bearerVariable(r.auth);
      if (op?.isPublic === true) {
        expect(r.auth.type, r.name).toBe("noauth");
        continue;
      }
      if (r.folder === PERMISSION_FOLDER && r.auth.type === "noauth") {
        continue; // deliberate request without a token
      }
      expect(r.auth.type, r.name).toBe("bearer");
      expect(TOKEN_VARIABLES, r.name).toContain(token);
      if (op?.path.startsWith("/api/admin") === true && r.folder !== PERMISSION_FOLDER) {
        expect(token, r.name).toBe("adminIdToken");
      }
    }
  });

  it("request bodies pass the validation schemas of the modules", () => {
    for (const r of apiRequests) {
      const op = operationOf(r);
      if (op === undefined) {
        throw new Error(`no operation for ${r.name}`);
      }
      const body = r.request.body;
      if (!op.hasBody) {
        expect(body, r.name).toBeUndefined();
        continue;
      }
      const schema = BODY_SCHEMAS[op.operationId];
      if (schema === undefined) {
        throw new Error(`no body schema for ${op.operationId}`);
      }
      if (body === undefined) {
        expect(schema.safeParse(undefined).success, r.name).toBe(true);
        continue;
      }
      if (body.mode !== "raw") {
        throw new Error(`${r.name}: JSON body expected`);
      }
      const parsed = schema.safeParse(parseJson(substitute(body.raw)));
      expect(parsed.error, r.name).toBeUndefined();
      expect(r.request.header.find((h) => h.key === "Content-Type")?.value, r.name).toBe("application/json");
    }
  });

  it("marketing requests use the current consent text version and stay marked as disabled", () => {
    const marketing = apiRequests.filter((r) => operationOf(r)?.path.includes("marketing") === true);
    expect(marketing.length).toBeGreaterThan(0);
    for (const r of marketing) {
      expect(r.folder, r.name).toBe(MARKETING_FOLDER);
      const raw = r.request.body?.mode === "raw" ? r.request.body.raw : "{}";
      const version = z.object({ consentTextVersion: z.string().optional() }).parse(parseJson(substitute(raw))).consentTextVersion;
      expect([undefined, MARKETING_CONSENT_TEXT_VERSION], r.name).toContain(version);
    }
  });

  it("createBooking always sends an Idempotency-Key and generates one only while the variable is empty", () => {
    const creates = apiRequests.filter((r) => operationOf(r)?.operationId === "createBooking");
    expect(creates.length).toBeGreaterThan(0);
    for (const r of creates) {
      const key = r.request.header.find((h) => h.key === "Idempotency-Key")?.value ?? "";
      expect(key === "{{bookingIdempotencyKey}}" || idempotencyKeySchema.safeParse(key).success, r.name).toBe(true);
    }
    const generators = allScripts.filter((s) => s.includes("{{$guid}}"));
    expect(generators).toHaveLength(1);
    expect(generators[0]).toContain('if (missing.length === 0 && !pm.environment.get("bookingIdempotencyKey"))');
  });

  it("every API request that changes data is marked ⚠️ (except profile sync and expected refusals)", () => {
    const unmarked = apiRequests.filter(
      (r) =>
        r.request.method !== "GET" &&
        !r.name.includes("⚠️") &&
        operationOf(r)?.operationId !== "syncProfile" &&
        r.folder !== PERMISSION_FOLDER,
    );
    expect(unmarked.map((r) => r.name)).toEqual([]);
  });

  it("Firebase: only sign-in, refresh, verification email and anonymous sign-in; emails are explicit", () => {
    const endpoints = new Set(firebaseRequests.map((r) => `${r.request.url.host.join(".")}/${r.request.url.path.join("/")}`));
    expect([...endpoints].sort()).toEqual([
      "identitytoolkit.googleapis.com/v1/accounts:sendOobCode",
      "identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
      "identitytoolkit.googleapis.com/v1/accounts:signUp",
      "securetoken.googleapis.com/v1/token",
    ]);
    for (const r of firebaseRequests) {
      expect(r.auth.type, r.name).toBe("noauth");
      expect(r.request.url.raw.endsWith("?key={{firebaseWebApiKey}}"), r.name).toBe(true);
      if (r.request.url.path.join("/").endsWith("sendOobCode")) {
        expect(r.name).toContain("⚠️ SEND verification email");
      }
      if (r.request.url.path.join("/").endsWith("accounts:signUp")) {
        // Anonymous only: a body with an email or a password would create a registered account.
        expect(r.request.body?.mode === "raw" ? parseJson(r.request.body.raw) : undefined, r.name).toEqual({ returnSecureToken: true });
      }
    }
  });

  it("scripts keep tokens in the environment only and print no values", () => {
    const saved = new Set(allScripts.flatMap((s) => [...s.matchAll(/pm\.environment\.set\((\w+|"\w+")/g)].map((m) => m[1] ?? "")));
    expect([...saved].sort()).toEqual(['"adminProfileId"', '"bookingId"', '"bookingIdempotencyKey"', '"clientProfileId"', "ID_VAR", "REFRESH_VAR"]);
    for (const s of allScripts) {
      expect(s).not.toMatch(/pm\.(globals|collectionVariables)\.set|pm\.variables\.set|pm\.sendRequest|setNextRequest|postman\.set/);
      for (const call of s.match(/console\.\w+\([^\n]*/g) ?? []) {
        expect(call).toMatch(/^console\.warn\("[^"]*"( \+ missing\.join\(", "\) \+ "[^"]*")?\);$/);
      }
    }
    const roles = new Set(allScripts.flatMap((s) => [...s.matchAll(/const ID_VAR = "(\w+)";/g)].map((m) => m[1])));
    expect([...roles].sort()).toEqual(["adminIdToken", "clientIdToken", "guestIdToken"]);
  });

  it("contains no secrets and only invented example addresses", () => {
    for (const text of [collectionText, environmentText]) {
      expect(text).not.toMatch(/eyJ[\w-]{10,}/); // JWT
      expect(text).not.toMatch(/AIza[\w-]{20,}/); // Google API key
      for (const address of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
        expect(address).toMatch(/@example\.invalid$/);
      }
    }
  });
});

describe("Postman environment template", () => {
  const values = new Map(environment.values.map((v) => [v.key, v]));

  it("has only the known non-secret values; everything else is empty", () => {
    expect(values.size).toBe(environment.values.length);
    expect(values.get("baseUrl")?.value).toBe(STAGING_URL);
    expect(values.get("firebaseProjectId")?.value).toBe(FIREBASE_PROJECT_ID);
    const filled = environment.values.filter((v) => v.value !== "").map((v) => v.key);
    expect(filled.sort()).toEqual(["baseUrl", "firebaseProjectId"]);
  });

  it("marks keys, passwords and tokens as secret", () => {
    for (const v of environment.values) {
      if (/ApiKey|Password|Token$/.test(v.key)) {
        expect(v.type, v.key).toBe("secret");
      }
    }
  });

  it("defines every variable the collection uses", () => {
    const used = new Set([...collectionText.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? ""));
    const fromScripts = allScripts.flatMap((s) => [...s.matchAll(/pm\.environment\.get\("(\w+)"\)/g)].map((m) => m[1] ?? ""));
    for (const name of [...used, ...fromScripts]) {
      expect(values.has(name), name).toBe(true);
    }
  });
});
