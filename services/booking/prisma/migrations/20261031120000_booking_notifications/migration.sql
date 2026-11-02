-- Additive only: new tables and enums. OutboxEvent is left unchanged; its
-- unused column publishedAt stays until a later release, because API
-- versions released before this one select it (Prisma returns all fields)
-- and must keep working during rollout and after a rollback.

-- CreateEnum
CREATE TYPE "NotificationEventStatus" AS ENUM ('planned', 'invalid');

-- CreateEnum
CREATE TYPE "NotificationRecipientRole" AS ENUM ('client', 'studio');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'in_progress', 'accepted', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "eventId" UUID NOT NULL,
    "position" BIGINT NOT NULL,
    "status" "NotificationEventStatus" NOT NULL,
    "reasonCode" TEXT,
    "processedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventPosition" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "bookingId" UUID NOT NULL,
    "recipientRole" "NotificationRecipientRole" NOT NULL,
    "recipientEmail" TEXT,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "leaseOwner" TEXT,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "resultCode" TEXT,
    "providerMessageId" TEXT,
    "acceptedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_bookingId_recipientRole_eventPosition_idx" ON "NotificationDelivery"("bookingId", "recipientRole", "eventPosition");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_eventId_recipientRole_key" ON "NotificationDelivery"("eventId", "recipientRole");

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent"("eventId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A processed event is either planned (deliveries recorded) or invalid with a reason.
ALTER TABLE "NotificationEvent"
    ADD CONSTRAINT "NotificationEvent_reason" CHECK (("status" = 'invalid') = ("reasonCode" IS NOT NULL));

-- Lease fields exist exactly while a worker holds the delivery; terminal
-- states carry their completion time and result code.
ALTER TABLE "NotificationDelivery"
    ADD CONSTRAINT "NotificationDelivery_event_type" CHECK ("eventType" IN ('booking.created', 'booking.rescheduled', 'booking.cancelled')),
    ADD CONSTRAINT "NotificationDelivery_attempts" CHECK ("attempts" >= 0),
    ADD CONSTRAINT "NotificationDelivery_lease" CHECK (
        ("status" = 'in_progress') = ("leaseOwner" IS NOT NULL)
        AND ("leaseOwner" IS NULL) = ("leaseToken" IS NULL)
        AND ("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)
    ),
    ADD CONSTRAINT "NotificationDelivery_terminal" CHECK (
        ("status" IN ('accepted', 'failed', 'skipped')) = ("completedAt" IS NOT NULL)
        AND ("status" NOT IN ('accepted', 'failed', 'skipped') OR "resultCode" IS NOT NULL)
        AND (("status" = 'accepted') = ("acceptedAt" IS NOT NULL))
    );
