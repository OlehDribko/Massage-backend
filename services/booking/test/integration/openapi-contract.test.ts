import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import {
  adminBookingSchema,
  availabilitySchema,
  clientBookingSchema,
  errorSchema,
  liveSchema,
  publicServiceSchema,
  readySchema,
  scheduleExceptionViewSchema,
  scheduleViewSchema,
  syncResponseSchema,
} from "../../src/openapi/schemas.js";
import { bearer, createUsers, insertService, resetCalendar, startBookingStack, type BookingStack } from "./helpers/booking-app.js";

// Contract: real responses (real application, PostgreSQL, booking emails on)
// parse with the documented response schemas, which are strict objects: a
// field the documentation does not describe fails the test.

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;

const paris = (date: string, hhmm: string) => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const serviceResponse = z.strictObject({ service: publicServiceSchema });
const bookingResponse = z.strictObject({ booking: clientBookingSchema });
const adminBookingResponse = z.strictObject({ booking: adminBookingSchema });
const write = (schema: z.ZodType) => z.strictObject({ booking: schema, changed: z.boolean() });

beforeAll(async () => {
  stack = await startBookingStack(1, { notifications: { wake: () => undefined } });
  users = await createUsers(stack);
  await resetCalendar(stack.db);
  stack.setNow("2027-03-01T06:00:00Z");
});

afterAll(async () => {
  await stack.close();
});

describe("documented responses (catalogue, availability, bookings, administration)", () => {
  it("match real responses", async () => {
    const serviceId = await insertService(stack.db, { name: "Massage example", durationMinutes: 60, priceCents: 8500 });
    await stack.db.query(
      "migrator",
      `UPDATE "Service" SET "salePriceCents" = 6900, "saleEndsAt" = '2027-03-10T23:00:00Z' WHERE id = '${serviceId}'`,
    );
    const admin = bearer(users.admin);
    const anna = bearer(users.clientA);

    // Health and profile sync.
    liveSchema.parse((await request(stack.app).get("/health/live").expect(200)).body);
    readySchema.parse((await request(stack.app).get("/health/ready").expect(200)).body);
    syncResponseSchema.parse((await request(stack.app).post("/api/me/sync").set(anna).expect(200)).body);

    // Catalogue and availability (public).
    z.strictObject({ services: z.array(publicServiceSchema) }).parse((await request(stack.app).get("/api/services").expect(200)).body);
    const service = serviceResponse.parse((await request(stack.app).get(`/api/services/${serviceId}`).expect(200)).body);
    expect(service.service).toMatchObject({ priceCents: 8500, effectivePriceCents: 6900, salePriceCents: 6900 });

    // Admin schedule.
    scheduleViewSchema.parse(
      (
        await request(stack.app)
          .put("/api/admin/schedule/weekly")
          .set(admin)
          .send({ intervals: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "20:00" })) })
          .expect(200)
      ).body,
    );
    scheduleViewSchema.parse((await request(stack.app).get("/api/admin/schedule").set(admin).expect(200)).body);
    scheduleExceptionViewSchema.parse(
      (await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-08").set(admin).send({ closed: true }).expect(200)).body,
    );
    z.strictObject({ timeZone: z.literal("Europe/Paris"), exceptions: z.array(scheduleExceptionViewSchema) }).parse(
      (await request(stack.app).get("/api/admin/schedule/exceptions?from=2027-03-01&to=2027-03-31").set(admin).expect(200)).body,
    );
    z.strictObject({ date: z.iso.date(), removed: z.boolean() }).parse(
      (await request(stack.app).delete("/api/admin/schedule/exceptions/2027-03-08").set(admin).expect(200)).body,
    );
    availabilitySchema.parse((await request(stack.app).get(`/api/services/${serviceId}/availability?from=2027-03-02&to=2027-03-03`).expect(200)).body);

    // Client bookings.
    const created = bookingResponse.parse(
      (
        await request(stack.app)
          .post("/api/bookings")
          .set(anna)
          .set("Idempotency-Key", "contract-0001")
          .send({ serviceId, startsAt: paris("2027-03-02", "09:00") })
          .expect(201)
      ).body,
    );
    expect(created.booking.service.priceCents).toBe(6900);
    const bookingId = created.booking.id;
    bookingResponse.parse(
      (
        await request(stack.app)
          .post("/api/bookings")
          .set(anna)
          .set("Idempotency-Key", "contract-0001")
          .send({ serviceId, startsAt: paris("2027-03-02", "09:00") })
          .expect(200)
      ).body,
    );
    z.strictObject({ bookings: z.array(clientBookingSchema) }).parse((await request(stack.app).get("/api/bookings").set(anna).expect(200)).body);
    bookingResponse.parse((await request(stack.app).get(`/api/bookings/${bookingId}`).set(anna).expect(200)).body);
    write(clientBookingSchema).parse(
      (await request(stack.app).post(`/api/bookings/${bookingId}/reschedule`).set(anna).send({ startsAt: paris("2027-03-03", "10:00") }).expect(200)).body,
    );

    // Admin bookings.
    z.strictObject({ date: z.iso.date(), timeZone: z.literal("Europe/Paris"), bookings: z.array(adminBookingSchema) }).parse(
      (await request(stack.app).get("/api/admin/bookings?date=2027-03-03").set(admin).expect(200)).body,
    );
    adminBookingResponse.parse((await request(stack.app).get(`/api/admin/bookings/${bookingId}`).set(admin).expect(200)).body);
    write(adminBookingSchema).parse(
      (await request(stack.app).post(`/api/admin/bookings/${bookingId}/cancel`).set(admin).send({ reason: "Fermeture" }).expect(200)).body,
    );
    const second = bookingResponse.parse(
      (
        await request(stack.app)
          .post("/api/bookings")
          .set(anna)
          .set("Idempotency-Key", "contract-0002")
          .send({ serviceId, startsAt: paris("2027-03-04", "09:00") })
          .expect(201)
      ).body,
    );
    write(clientBookingSchema).parse((await request(stack.app).post(`/api/bookings/${second.booking.id}/cancel`).set(anna).send({}).expect(200)).body);
  });

  it("error bodies keep the documented shape", async () => {
    const serviceId = await insertService(stack.db, { name: "Other", durationMinutes: 30, priceCents: 3000 });
    const anna = bearer(users.clientA);
    const bodies = [
      (await request(stack.app).get(`/api/services/${serviceId}/availability?from=nope`).expect(400)).body,
      (await request(stack.app).post("/api/bookings").set(anna).send({ serviceId, startsAt: paris("2027-03-02", "11:00") }).expect(400)).body,
      (await request(stack.app).post("/api/bookings").set(bearer(users.guest)).set("Idempotency-Key", "contract-0003").send({ serviceId, startsAt: paris("2027-03-02", "11:00") }).expect(403)).body,
      (await request(stack.app).post("/api/bookings").set(anna).set("Idempotency-Key", "contract-0004").send({ serviceId, startsAt: paris("2027-03-01", "10:00") }).expect(409)).body,
      (await request(stack.app).get("/api/admin/schedule").set(anna).expect(403)).body,
      (await request(stack.app).get("/api/bookings").expect(401)).body,
      (await request(stack.app).get("/api/services/8f0c2b1e-4a5d-4c6e-9f7a-1b2c3d4e5f60").expect(404)).body,
    ];
    for (const body of bodies) {
      errorSchema.parse(body);
    }
    expect(errorSchema.parse(bodies[2]).blockers).toContain("anonymous_session");
    expect(errorSchema.parse(bodies[3]).reason).toBe("too_soon");
  });
});
