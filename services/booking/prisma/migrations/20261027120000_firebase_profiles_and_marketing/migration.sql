-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('client', 'admin');

-- CreateEnum
CREATE TYPE "MarketingSubscriptionStatus" AS ENUM ('pending', 'subscribed', 'unsubscribed');

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" UUID NOT NULL,
    "firebaseUid" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'client',
    "name" TEXT,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "isAnonymous" BOOLEAN NOT NULL,
    "signInProvider" TEXT NOT NULL,
    "phoneE164" TEXT,
    "identityIssuedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingSubscription" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "MarketingSubscriptionStatus" NOT NULL DEFAULT 'pending',
    "confirmationNonce" TEXT,
    "confirmationSentAt" TIMESTAMP(3),
    "subscribedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_firebaseUid_key" ON "UserProfile"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSubscription_email_key" ON "MarketingSubscription"("email");

-- Invariants Prisma cannot express; enforced for every writer, including
-- manual SQL. An anonymous session can never hold the admin role.
ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_firebaseUid_length" CHECK (char_length("firebaseUid") BETWEEN 1 AND 128),
    ADD CONSTRAINT "UserProfile_admin_not_anonymous" CHECK (NOT ("role" = 'admin' AND "isAnonymous")),
    ADD CONSTRAINT "UserProfile_name_length" CHECK ("name" IS NULL OR char_length("name") BETWEEN 1 AND 80),
    ADD CONSTRAINT "UserProfile_phone_e164" CHECK ("phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{6,14}$');

ALTER TABLE "MarketingSubscription"
    ADD CONSTRAINT "MarketingSubscription_email_lowercase" CHECK ("email" = lower("email"));

-- Carry over confirmed marketing consent from the legacy "User" table.
-- Only addresses that were verified and opted in become "subscribed"; the
-- legacy id is reused so unsubscribe links already sent keep working.
-- Unconfirmed legacy subscribers are not carried over (they subscribe again).
-- The legacy table itself is left unchanged.
INSERT INTO "MarketingSubscription" ("id", "email", "status", "subscribedAt", "createdAt", "updatedAt")
SELECT
    CASE
        WHEN "id" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN "id"::uuid
        ELSE gen_random_uuid()
    END,
    lower("email"),
    'subscribed',
    "updatedAt",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "User"
WHERE "marketingConsent" AND "emailVerified"
ON CONFLICT ("email") DO NOTHING;
