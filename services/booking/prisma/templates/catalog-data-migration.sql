-- Catalogue data migration template (docs/booking.md, "Каталог послуг").
-- Copy to prisma/migrations/<timestamp>_catalog_<change>/migration.sql,
-- replace the sample row, delete what is not needed. Never edit an applied
-- migration: every change of the catalogue is a new migration.
--
-- Explicit transaction: `prisma migrate deploy` (our migration task) runs
-- each statement of a migration in its own transaction unless the file says
-- otherwise (verified in test/integration/catalog-data-migration.test.ts).
-- Without BEGIN/COMMIT the calendar lock below would be released right after
-- the SELECT. With them: all changes and the lock are one transaction, and
-- any error rolls everything back.
BEGIN;

-- The calendar lock of all booking writes
-- (src/modules/schedule/calendar-transaction.ts, CALENDAR_LOCK_KEY): no
-- booking is created for a service while it changes.
SELECT pg_advisory_xact_lock(7316442001);

-- Add or change services. Fixed ids: the frontend keys photos and texts by
-- them; never reuse an id for another service. No description: texts live
-- in the frontend (the column stays NULL). Limits (database checks): name
-- 1–120 characters, duration 5–480 minutes, price 0–10 000 000 euro cents.
-- Existing bookings keep their own snapshot of name, duration and price.
INSERT INTO "Service" ("id", "name", "durationMinutes", "priceCents", "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000000', 'Sample service', 60, 6500, now())
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "durationMinutes" = EXCLUDED."durationMinutes",
  "priceCents" = EXCLUDED."priceCents",
  "updatedAt" = now();

-- Sale price (docs/booking.md, "Акційна ціна"): both fields together, the
-- sale price in cents strictly below priceCents. The end is a human date in
-- Europe/Paris converted by PostgreSQL (winter and summer time handled);
-- "until 30 November inclusive" ends on 1 December at 00:00 Paris:
-- UPDATE "Service" SET "salePriceCents" = 6900,
--   "saleEndsAt" = TIMESTAMP '2026-12-01 00:00' AT TIME ZONE 'Europe/Paris', "updatedAt" = now()
--   WHERE "id" = '<id>';
-- End or remove a sale (existing bookings keep their agreed price):
-- UPDATE "Service" SET "salePriceCents" = NULL, "saleEndsAt" = NULL, "updatedAt" = now() WHERE "id" = '<id>';
-- An expired sale needs no clean-up: it is simply not active any more.

-- Stop new bookings for a service (existing bookings stay valid):
-- UPDATE "Service" SET "archivedAt" = now(), "updatedAt" = now() WHERE "id" = '<id>';
-- Bookable again:
-- UPDATE "Service" SET "archivedAt" = NULL, "updatedAt" = now() WHERE "id" = '<id>';
-- Delete only a service that was never booked (the database refuses otherwise):
-- DELETE FROM "Service" WHERE "id" = '<id>';

COMMIT;
