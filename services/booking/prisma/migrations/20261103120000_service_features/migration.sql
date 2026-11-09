-- Client-facing features of a catalogue service (docs/booking.md, "Каталог
-- послуг"): a short list shown next to the description, in order. The
-- description column (created in 20261030120000, unused until now) holds the
-- text itself. Additive only: older API versions keep working (their Prisma
-- Client does not know the column and never writes it; the catalogue is
-- changed by data migrations only). No texts are set here.
ALTER TABLE "Service"
    ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- At most 10 items, none NULL or empty (the description keeps its own check
-- Service_description_length: NULL or 1–2000 characters).
ALTER TABLE "Service"
    ADD CONSTRAINT "Service_features_valid" CHECK (
        cardinality("features") <= 10
        AND array_position("features", NULL) IS NULL
        AND '' <> ALL ("features")
    );
