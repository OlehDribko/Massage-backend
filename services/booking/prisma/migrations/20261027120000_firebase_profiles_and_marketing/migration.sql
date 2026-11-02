-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('client', 'admin');

-- CreateEnum
CREATE TYPE "MarketingConsentSource" AS ENUM ('signup_checkbox', 'subscription_form', 'account_request');

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
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "consentGivenAt" TIMESTAMP(3),
    "consentSource" "MarketingConsentSource",
    "consentTextVersion" TEXT,
    "unsubscribedAt" TIMESTAMP(3),
    "confirmationNonce" TEXT,
    "confirmationSentAt" TIMESTAMP(3),
    "confirmationSource" "MarketingConsentSource",
    "confirmationTextVersion" TEXT,
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

-- A subscription always carries the evidence of its consent, and a pending
-- confirmation always records what was requested.
ALTER TABLE "MarketingSubscription"
    ADD CONSTRAINT "MarketingSubscription_email_lowercase" CHECK ("email" = lower("email")),
    ADD CONSTRAINT "MarketingSubscription_consent_evidence" CHECK (
        NOT "subscribed"
        OR ("consentGivenAt" IS NOT NULL AND "consentSource" IS NOT NULL AND "consentTextVersion" IS NOT NULL)
    ),
    ADD CONSTRAINT "MarketingSubscription_confirmation_complete" CHECK (
        ("confirmationNonce" IS NULL) = ("confirmationSource" IS NULL)
        AND ("confirmationNonce" IS NULL) = ("confirmationTextVersion" IS NULL)
    );

-- Legacy consent ("User"."marketingConsent") is NOT carried over: the legacy
-- flow could set it without a confirmed opt-in (e.g. for an already verified
-- address), and "emailVerified" proves only that the address works, not
-- marketing consent. Legacy subscribers must opt in again; the legacy table
-- stays unchanged for a later decision.
