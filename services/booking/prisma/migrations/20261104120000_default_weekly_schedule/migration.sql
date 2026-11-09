-- Default weekly schedule agreed by the owner (2026-11-09): every date is open
-- for booking by default, every day 09:00–20:30 Europe/Paris (minutes 540–1230
-- since local midnight). The latest start stays 19:00 (booking rules), so a
-- 90-minute session at 19:00 still fits. The admin closes or changes dates
-- with exceptions (PUT /api/admin/schedule/exceptions/{date}) and may replace
-- the whole week (PUT /api/admin/schedule/weekly).
--
-- Written only when the weekly schedule is empty: a schedule the admin has
-- already set is never overwritten. Exceptions and bookings are not touched.
--
-- Explicit transaction: our migration task (`prisma migrate deploy`) would
-- otherwise run each statement in its own transaction and release the
-- calendar lock at once.
BEGIN;

-- The calendar lock of all booking writes
-- (src/modules/schedule/calendar-transaction.ts, CALENDAR_LOCK_KEY).
SELECT pg_advisory_xact_lock(7316442001);

INSERT INTO "WeeklyScheduleInterval" ("id", "weekday", "startMinute", "endMinute")
SELECT gen_random_uuid(), weekday, 540, 1230
FROM generate_series(1, 7) AS weekday
WHERE NOT EXISTS (SELECT 1 FROM "WeeklyScheduleInterval");

COMMIT;
