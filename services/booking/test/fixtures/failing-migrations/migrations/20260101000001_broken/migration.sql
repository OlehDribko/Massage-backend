-- Intentionally broken: references a table that does not exist.
ALTER TABLE "DoesNotExist" ADD COLUMN "x" INTEGER;
