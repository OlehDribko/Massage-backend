-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('confirmed', 'cancelled');

-- CreateEnum
CREATE TYPE "BookingActor" AS ENUM ('client', 'admin');

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationMinutes" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyScheduleInterval" (
    "id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "WeeklyScheduleInterval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleException" (
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "ScheduleExceptionInterval" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "ScheduleExceptionInterval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "clientProfileId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "serviceName" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "blockedUntil" TIMESTAMPTZ(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'confirmed',
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledBy" "BookingActor",
    "cancelledByProfileId" UUID,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingTimeChange" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "previousStartsAt" TIMESTAMPTZ(3) NOT NULL,
    "previousEndsAt" TIMESTAMPTZ(3) NOT NULL,
    "newStartsAt" TIMESTAMPTZ(3) NOT NULL,
    "newEndsAt" TIMESTAMPTZ(3) NOT NULL,
    "changedByProfileId" UUID NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookingTimeChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "position" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeeklyScheduleInterval_weekday_idx" ON "WeeklyScheduleInterval"("weekday");

-- CreateIndex
CREATE INDEX "ScheduleExceptionInterval_date_idx" ON "ScheduleExceptionInterval"("date");

-- CreateIndex
CREATE INDEX "Booking_startsAt_idx" ON "Booking"("startsAt");

-- CreateIndex
CREATE INDEX "Booking_clientProfileId_startsAt_idx" ON "Booking"("clientProfileId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_clientProfileId_idempotencyKey_key" ON "Booking"("clientProfileId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BookingTimeChange_bookingId_changedAt_idx" ON "BookingTimeChange"("bookingId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_position_key" ON "OutboxEvent"("position");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_position_idx" ON "OutboxEvent"("publishedAt", "position");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateId_idx" ON "OutboxEvent"("aggregateId");

-- AddForeignKey
ALTER TABLE "ScheduleExceptionInterval" ADD CONSTRAINT "ScheduleExceptionInterval_date_fkey" FOREIGN KEY ("date") REFERENCES "ScheduleException"("date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingTimeChange" ADD CONSTRAINT "BookingTimeChange_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invariants Prisma cannot express; enforced for every writer, including
-- manual SQL. Money: integer euro cents, EUR only. Durations: whole minutes.
ALTER TABLE "Service"
    ADD CONSTRAINT "Service_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    ADD CONSTRAINT "Service_description_length" CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 2000),
    ADD CONSTRAINT "Service_duration_range" CHECK ("durationMinutes" BETWEEN 5 AND 480),
    ADD CONSTRAINT "Service_price_range" CHECK ("priceCents" BETWEEN 0 AND 10000000),
    ADD CONSTRAINT "Service_currency_eur" CHECK ("currency" = 'EUR');

-- Local wall-clock intervals: minutes since local midnight, [start, end).
ALTER TABLE "WeeklyScheduleInterval"
    ADD CONSTRAINT "WeeklyScheduleInterval_weekday_iso" CHECK ("weekday" BETWEEN 1 AND 7),
    ADD CONSTRAINT "WeeklyScheduleInterval_minutes" CHECK (0 <= "startMinute" AND "startMinute" < "endMinute" AND "endMinute" <= 1440);

ALTER TABLE "ScheduleExceptionInterval"
    ADD CONSTRAINT "ScheduleExceptionInterval_minutes" CHECK (0 <= "startMinute" AND "startMinute" < "endMinute" AND "endMinute" <= 1440);

-- A booking's end follows from its own snapshot of the duration; the occupied
-- time [startsAt, blockedUntil) includes the one 15-minute rest break after
-- the session. With the exclusion constraint below this guarantees exactly
-- one break between two sessions (the next may start when the break ends).
-- Cancellation fields are set together, and only on cancelled bookings.
ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_currency_eur" CHECK ("currency" = 'EUR'),
    ADD CONSTRAINT "Booking_price_range" CHECK ("priceCents" BETWEEN 0 AND 10000000),
    ADD CONSTRAINT "Booking_duration_range" CHECK ("durationMinutes" BETWEEN 5 AND 480),
    ADD CONSTRAINT "Booking_service_name_length" CHECK (char_length("serviceName") BETWEEN 1 AND 120),
    ADD CONSTRAINT "Booking_end_matches_duration" CHECK ("endsAt" = "startsAt" + make_interval(mins => "durationMinutes")),
    ADD CONSTRAINT "Booking_break_after_end" CHECK ("blockedUntil" = "endsAt" + interval '15 minutes'),
    ADD CONSTRAINT "Booking_idempotency_key_format" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{8,128}$'),
    ADD CONSTRAINT "Booking_cancellation_consistent" CHECK (
        ("status" = 'cancelled') = ("cancelledAt" IS NOT NULL)
        AND ("status" = 'cancelled') = ("cancelledBy" IS NOT NULL)
        AND ("status" = 'cancelled') = ("cancelledByProfileId" IS NOT NULL)
        AND ("cancellationReason" IS NULL OR ("status" = 'cancelled' AND char_length("cancellationReason") BETWEEN 1 AND 500))
    ),
    -- No two confirmed bookings may occupy overlapping time (break included).
    -- Checked by PostgreSQL for every writer and every process: the last line
    -- of defence behind the application's calendar lock.
    ADD CONSTRAINT "Booking_no_overlap" EXCLUDE USING gist (
        tstzrange("startsAt", "blockedUntil", '[)') WITH &&
    ) WHERE ("status" = 'confirmed');

ALTER TABLE "BookingTimeChange"
    ADD CONSTRAINT "BookingTimeChange_times" CHECK ("previousEndsAt" > "previousStartsAt" AND "newEndsAt" > "newStartsAt");

ALTER TABLE "OutboxEvent"
    ADD CONSTRAINT "OutboxEvent_type_known" CHECK ("type" IN ('booking.created', 'booking.rescheduled', 'booking.cancelled')),
    ADD CONSTRAINT "OutboxEvent_schema_version" CHECK ("schemaVersion" >= 1),
    ADD CONSTRAINT "OutboxEvent_aggregate_type" CHECK ("aggregateType" = 'booking');
