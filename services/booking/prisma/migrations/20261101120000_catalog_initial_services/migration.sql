-- Initial catalogue: 35 single-session services agreed by the owner
-- (2026-11-01). Data migration from prisma/templates/catalog-data-migration.sql
-- (docs/booking.md, "Каталог послуг"). The ids are fixed here and are the same
-- in every environment: the frontend keys photos and texts by them.
--
-- Prices in integer euro cents (EUR); durations in minutes as agreed (55 and
-- 85 are not rounded). All services are bookable. Only these ids are written:
-- no other service is changed, archived or deleted, no booking is touched.
-- Re-running the statement updates the same rows (no duplicates).
--
-- Explicit transaction: our migration task (`prisma migrate deploy`) would
-- otherwise run each statement in its own transaction and release the
-- calendar lock at once.
BEGIN;

-- The calendar lock of all booking writes
-- (src/modules/schedule/calendar-transaction.ts, CALENDAR_LOCK_KEY).
SELECT pg_advisory_xact_lock(7316442001);

INSERT INTO "Service" ("id", "name", "durationMinutes", "priceCents", "updatedAt") VALUES
  ('8768f0f0-3e76-4ed6-a273-5dd431a305e5', 'Massage Tuina aux huiles chaudes', 60, 8500, now()),
  ('039b509e-baff-4748-bb5e-094ed66a2198', 'Massage Tuina aux huiles chaudes', 90, 12000, now()),
  ('a0f4141c-2f1a-49b4-9ee6-09d15b0853af', 'Massage Tuina aux huiles chaudes', 120, 15500, now()),
  ('69465693-b812-4dab-a100-f1f880b7c1b7', 'Massage Tuina traditionnel sans huile', 60, 8500, now()),
  ('fe0523ef-4b29-4c4e-96fa-e8bdbd3f899e', 'Massage Tuina traditionnel sans huile', 90, 12000, now()),
  ('81f49f12-7b74-43b2-9dc5-ad1e18c92b59', 'Massage Tuina traditionnel sans huile', 120, 15500, now()),
  ('0a879540-15e2-4e5a-8b8a-ab3ce30cc25e', 'Massage premium pour femmes', 60, 7500, now()),
  ('3d21cb0f-5905-4b76-af1c-a0268602ad88', 'Massage pierres chaudes', 60, 9000, now()),
  ('7cbaae05-e433-4087-b64e-fed91195ad2e', 'Massage pierres chaudes', 90, 12800, now()),
  ('1abe839a-35e1-4322-aec3-c03b3fcd6864', 'Massage pierres chaudes', 120, 17000, now()),
  ('cf4fb0b1-7b35-455b-8367-e4b422639610', 'Massage ayurvédique', 60, 8500, now()),
  ('40c8f682-6222-4cd0-b6aa-d3bcfb2a80d3', 'Massage ayurvédique', 90, 12000, now()),
  ('2703c0d8-c30a-49d7-bd41-bc51179dd22f', 'Massage de la tête aux pieds', 60, 9000, now()),
  ('c438d102-95ae-4c7d-9dda-87cf966d3efd', 'Massage de la tête aux pieds', 90, 12800, now()),
  ('b84f23ba-773d-4ff2-b128-10a1ee22a4cf', 'Massage de la tête aux pieds', 120, 17000, now()),
  ('11a5f7a9-4e3a-4fe1-bfcb-ad85073b7ec4', 'Massage sportif', 55, 10000, now()),
  ('dea5ef63-6ab1-4338-aa05-2fab089ee070', 'Massage sportif', 90, 14300, now()),
  ('e416e435-88a8-458c-8737-3f9b5b9b5e6f', 'Massage sportif', 120, 18500, now()),
  ('570a1b88-f7e4-43e7-9e25-23455764aa74', 'Massage enfant — à partir de 6 ans', 30, 5000, now()),
  ('e0a4be32-524f-49e3-b525-1051092007d3', 'Réflexologie plantaire', 30, 5000, now()),
  ('696afe81-79e4-4114-961c-af875229a2b1', 'Massage de tout le dos', 30, 5000, now()),
  ('353c5f3d-62d3-43e1-a9f4-65181e356e6b', 'Massage de la tête, du cou et des trapèzes', 30, 5000, now()),
  ('57f78078-f65b-4723-b20b-aad89495c898', 'Endosphères — demi-corps, une séance', 45, 11000, now()),
  ('97b3295d-8d7e-4c7f-a8a8-bbe1df1af633', 'Madérothérapie', 60, 9500, now()),
  ('0eb52a15-863f-4981-8354-e1a4ab84c088', 'Madérothérapie', 90, 13500, now()),
  ('ca2c3570-e81f-4410-b447-7fc90618da8f', 'Massage de drainage lymphatique', 60, 9000, now()),
  ('713d9d2a-c90e-42e3-a224-99390862f856', 'Massage de drainage lymphatique', 90, 12800, now()),
  ('c513a89e-712f-4462-83d0-3b1a08df1f92', 'Massage de drainage lymphatique', 120, 15500, now()),
  ('9b081644-29e6-496a-9303-6e07a12966d4', 'Massage prénatal — future maman', 60, 9000, now()),
  ('3dd3ebdd-da7b-4ca2-9f13-3a46d96be6f4', 'Massage postnatal', 60, 9000, now()),
  ('2bdfa0e1-5556-46a7-869a-ef48114dc07c', 'Massage postnatal', 90, 13000, now()),
  ('e8714bef-1897-4dd9-9ee9-c0c31d58f293', 'Massage myofascial', 55, 9000, now()),
  ('f85a106b-7f20-4ef1-88f7-670cacee7747', 'Massage myofascial', 85, 13500, now()),
  ('a587db53-7b29-4b32-adc3-15d68289cfa8', 'Massage des tissus profonds', 55, 9000, now()),
  ('018a645a-7ff7-48fd-a730-894ef3b62aa5', 'Massage des tissus profonds', 85, 13500, now())
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "durationMinutes" = EXCLUDED."durationMinutes",
  "priceCents" = EXCLUDED."priceCents",
  "updatedAt" = now();

COMMIT;
