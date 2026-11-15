-- Manual blocks of the calendar (docs/booking.md, "Блоки зайнятості").
-- Additive only: two new tables; the schedule, closures and bookings are
-- untouched, and older API versions neither read nor write them.

-- CreateTable
CREATE TABLE "ScheduleBlock" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "createdByProfileId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduleBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleBlockRequest" (
    "adminProfileId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "blockId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduleBlockRequest_pkey" PRIMARY KEY ("adminProfileId","idempotencyKey")
);

-- CreateIndex
CREATE INDEX "ScheduleBlock_startsAt_idx" ON "ScheduleBlock"("startsAt");

-- CreateIndex
CREATE INDEX "ScheduleBlock_endsAt_idx" ON "ScheduleBlock"("endsAt");

-- CreateIndex
CREATE INDEX "ScheduleBlockRequest_blockId_idx" ON "ScheduleBlockRequest"("blockId");

-- AddForeignKey
ALTER TABLE "ScheduleBlock" ADD CONSTRAINT "ScheduleBlock_createdByProfileId_fkey" FOREIGN KEY ("createdByProfileId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleBlockRequest" ADD CONSTRAINT "ScheduleBlockRequest_adminProfileId_fkey" FOREIGN KEY ("adminProfileId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleBlockRequest" ADD CONSTRAINT "ScheduleBlockRequest_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "ScheduleBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Title 1–100 characters, note 1–500 or NULL (empty is stored as NULL);
-- a positive span of at most 25 hours of real time (24 local hours on the
-- autumn change of time; the API keeps both bounds on one local date); bounds on the 5-minute grid.
ALTER TABLE "ScheduleBlock"
    ADD CONSTRAINT "ScheduleBlock_title_length" CHECK (char_length("title") BETWEEN 1 AND 100),
    ADD CONSTRAINT "ScheduleBlock_note_length" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500),
    ADD CONSTRAINT "ScheduleBlock_span" CHECK (
        "endsAt" - "startsAt" >= interval '15 minutes' AND "endsAt" - "startsAt" <= interval '25 hours'
    ),
    ADD CONSTRAINT "ScheduleBlock_grid" CHECK (
        date_part('second', "startsAt") = 0 AND date_part('second', "endsAt") = 0
        AND date_part('minute', "startsAt")::int % 5 = 0 AND date_part('minute', "endsAt")::int % 5 = 0
    );

ALTER TABLE "ScheduleBlockRequest"
    ADD CONSTRAINT "ScheduleBlockRequest_idempotency_key_format" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{8,128}$');
