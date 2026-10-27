import { describe, expect, it } from "vitest";
import {
  bookingReadiness,
  canBookForSelf,
  canCancelAppointment,
  canManageCatalog,
  canRescheduleAppointment,
  receivesAppointmentNotifications,
  type Actor,
} from "../src/modules/access/policies.js";

const client: Actor = {
  id: "client-1",
  role: "client",
  isAnonymous: false,
  emailVerified: true,
  name: "Marie",
  phoneE164: "+33612345678",
};
const admin: Actor = { ...client, id: "admin-1", role: "admin" };
const guest: Actor = { ...client, id: "guest-1", isAnonymous: true, emailVerified: false, name: null, phoneE164: null };

describe("access policies", () => {
  it("a complete, verified, registered client is booking-ready", () => {
    expect(bookingReadiness(client)).toEqual({ ready: true, blockers: [] });
    expect(canBookForSelf(client)).toBe(true);
  });

  it.each([
    ["anonymous", { isAnonymous: true }, "anonymous_session"],
    ["unverified email", { emailVerified: false }, "email_not_verified"],
    ["no name", { name: null }, "name_missing"],
    ["no phone", { phoneE164: null }, "phone_missing"],
    ["admin", { role: "admin" }, "not_a_client"],
  ] satisfies [string, Partial<Actor>, string][])("%s blocks booking", (_label, change, blocker) => {
    const readiness = bookingReadiness({ ...client, ...change });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toEqual([blocker]);
  });

  it("admins manage the catalogue and get notifications; clients and guests do not", () => {
    expect(canManageCatalog(admin)).toBe(true);
    expect(receivesAppointmentNotifications(admin)).toBe(true);
    for (const actor of [client, guest, { ...admin, emailVerified: false }, { ...admin, isAnonymous: true }]) {
      expect(canManageCatalog(actor)).toBe(false);
      expect(receivesAppointmentNotifications(actor)).toBe(false);
    }
  });

  it("the owner or an admin may cancel; another client or a guest may not", () => {
    const appointment = { clientProfileId: client.id };
    expect(canCancelAppointment(client, appointment)).toBe(true);
    expect(canCancelAppointment(admin, appointment)).toBe(true);
    expect(canCancelAppointment({ ...client, id: "client-2" }, appointment)).toBe(false);
    expect(canCancelAppointment({ ...guest, id: client.id }, appointment)).toBe(false);
  });

  it("only the booking-ready owner may reschedule; admins may not move other people's appointments", () => {
    const appointment = { clientProfileId: client.id };
    expect(canRescheduleAppointment(client, appointment)).toBe(true);
    expect(canRescheduleAppointment(admin, appointment)).toBe(false);
    expect(canRescheduleAppointment({ ...admin, id: client.id }, appointment)).toBe(false);
    expect(canRescheduleAppointment({ ...client, id: "client-2" }, appointment)).toBe(false);
    expect(canRescheduleAppointment({ ...client, phoneE164: null }, appointment)).toBe(false);
  });
});
