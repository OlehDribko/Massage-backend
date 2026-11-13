-- Gift card requests (docs/gift-card-requests.md). Additive: two new tables
-- and enums. The outbox and notification CHECK constraints are widened (not
-- removed) to also accept the event gift_card_request.created; every existing
-- row satisfies the new form, and older API versions never write it.

-- CreateEnum
CREATE TYPE "GiftCardRequestStatus" AS ENUM ('new', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "GiftCardContactChannel" AS ENUM ('email', 'phone', 'whatsapp');

-- CreateTable
CREATE TABLE "GiftCardRequest" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "clientProfileId" UUID NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientEmail" TEXT NOT NULL,
    "clientPhone" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "description" TEXT,
    "preferredContactChannel" "GiftCardContactChannel" NOT NULL,
    "status" "GiftCardRequestStatus" NOT NULL DEFAULT 'new',
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GiftCardRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardRequestStatusChange" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "fromStatus" "GiftCardRequestStatus",
    "toStatus" "GiftCardRequestStatus" NOT NULL,
    "changedByProfileId" UUID NOT NULL,
    "changedByRole" "UserRole" NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GiftCardRequestStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardRequest_number_key" ON "GiftCardRequest"("number");

-- CreateIndex
CREATE INDEX "GiftCardRequest_createdAt_idx" ON "GiftCardRequest"("createdAt");

-- CreateIndex
CREATE INDEX "GiftCardRequest_status_createdAt_idx" ON "GiftCardRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCardRequest_clientProfileId_createdAt_idx" ON "GiftCardRequest"("clientProfileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardRequest_clientProfileId_idempotencyKey_key" ON "GiftCardRequest"("clientProfileId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "GiftCardRequestStatusChange_requestId_changedAt_idx" ON "GiftCardRequestStatusChange"("requestId", "changedAt");

-- AddForeignKey
ALTER TABLE "GiftCardRequest" ADD CONSTRAINT "GiftCardRequest_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardRequestStatusChange" ADD CONSTRAINT "GiftCardRequestStatusChange_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "GiftCardRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardRequestStatusChange" ADD CONSTRAINT "GiftCardRequestStatusChange_changedByProfileId_fkey" FOREIGN KEY ("changedByProfileId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Positive whole cents within INTEGER (no business minimum or maximum);
-- EUR only; description 1–1000 characters or NULL (empty is stored as NULL).
ALTER TABLE "GiftCardRequest"
    ADD CONSTRAINT "GiftCardRequest_amount_positive" CHECK ("amountCents" > 0),
    ADD CONSTRAINT "GiftCardRequest_currency_eur" CHECK ("currency" = 'EUR'),
    ADD CONSTRAINT "GiftCardRequest_description_length" CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 1000),
    ADD CONSTRAINT "GiftCardRequest_contacts_present" CHECK (
        char_length("clientName") >= 1 AND char_length("clientEmail") >= 3 AND char_length("clientPhone") >= 2
    ),
    ADD CONSTRAINT "GiftCardRequest_idempotency_key_format" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{8,128}$');

-- The submission is the only entry without a previous status; a change
-- always changes the status.
ALTER TABLE "GiftCardRequestStatusChange"
    ADD CONSTRAINT "GiftCardRequestStatusChange_transition" CHECK (
        ("fromStatus" IS NULL AND "toStatus" = 'new') OR ("fromStatus" IS NOT NULL AND "fromStatus" <> "toStatus")
    );

-- Widen the outbox and delivery contracts to the gift card event.
ALTER TABLE "OutboxEvent"
    DROP CONSTRAINT "OutboxEvent_type_known",
    DROP CONSTRAINT "OutboxEvent_aggregate_type",
    ADD CONSTRAINT "OutboxEvent_type_known" CHECK (
        "type" IN ('booking.created', 'booking.rescheduled', 'booking.cancelled', 'gift_card_request.created')
    ),
    ADD CONSTRAINT "OutboxEvent_aggregate_type" CHECK (
        ("aggregateType" = 'booking' AND "type" LIKE 'booking.%')
        OR ("aggregateType" = 'gift_card_request' AND "type" LIKE 'gift\_card\_request.%')
    );

ALTER TABLE "NotificationDelivery"
    DROP CONSTRAINT "NotificationDelivery_event_type",
    ADD CONSTRAINT "NotificationDelivery_event_type" CHECK (
        "eventType" IN ('booking.created', 'booking.rescheduled', 'booking.cancelled', 'gift_card_request.created')
    );
