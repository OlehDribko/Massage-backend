import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { PublicServiceView } from "../src/modules/catalog/catalog.service.js";
import type { AdminBookingView, ClientBookingView } from "../src/modules/bookings/booking.view.js";
import type { MarketingStatus } from "../src/modules/marketing/consent.js";
import type { ProfileView } from "../src/modules/profiles/profile.service.js";
import type { AdminNotificationStatus, ClientNotificationStatus } from "../src/notifications/status.js";
import type {
  adminBookingSchema,
  adminNotificationSchema,
  clientBookingSchema,
  clientNotificationSchema,
  marketingStatusSchema,
  profileViewSchema,
  publicServiceSchema,
} from "../src/openapi/schemas.js";

// Compile-time check (npm run typecheck): the documented response schemas
// describe exactly the view types the routes send. A field added, removed or
// retyped on one side only fails the type check.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const checks: true[] = [
  true satisfies Same<z.output<typeof publicServiceSchema>, PublicServiceView>,
  true satisfies Same<z.output<typeof clientBookingSchema>, ClientBookingView>,
  true satisfies Same<z.output<typeof adminBookingSchema>, AdminBookingView>,
  true satisfies Same<z.output<typeof profileViewSchema>, ProfileView>,
  true satisfies Same<z.output<typeof marketingStatusSchema>, MarketingStatus>,
  true satisfies Same<z.output<typeof clientNotificationSchema>, ClientNotificationStatus>,
  true satisfies Same<z.output<typeof adminNotificationSchema>, AdminNotificationStatus>,
];

describe("documented response schemas", () => {
  it("match the view types of the modules (checked by the compiler)", () => {
    expect(checks.every(Boolean)).toBe(true);
  });
});
