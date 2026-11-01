-- Optional sale price of a catalogue service with its end (docs/booking.md,
-- "Акційна ціна"). Additive only: older API versions keep working (their
-- Prisma Client does not know the columns and never writes them; the
-- catalogue is changed by data migrations only). No sale is set here.
ALTER TABLE "Service"
    ADD COLUMN "salePriceCents" INTEGER,
    ADD COLUMN "saleEndsAt" TIMESTAMPTZ(3);

-- Both set or both empty; the sale price is a non-negative whole number of
-- cents strictly below the regular price (also re-checked when a later
-- migration lowers priceCents).
ALTER TABLE "Service"
    ADD CONSTRAINT "Service_sale_complete" CHECK (("salePriceCents" IS NULL) = ("saleEndsAt" IS NULL)),
    ADD CONSTRAINT "Service_sale_price_range" CHECK (
        "salePriceCents" IS NULL OR ("salePriceCents" >= 0 AND "salePriceCents" < "priceCents")
    );
