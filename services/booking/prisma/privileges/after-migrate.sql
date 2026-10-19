-- Runs after every `prisma migrate deploy`, as the migrator role (the owner of
-- _prisma_migrations). Default privileges grant the runtime role DML on all
-- tables the migrator creates, including Prisma's migration history table,
-- which is created by the first deploy. The runtime role must not read or
-- change it. Idempotent; a no-op when the runtime role does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'booking_app') THEN
    REVOKE ALL ON TABLE public."_prisma_migrations" FROM booking_app;
  END IF;
END
$$;
