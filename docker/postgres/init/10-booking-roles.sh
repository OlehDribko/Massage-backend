#!/usr/bin/env bash
# Local-only database roles for the booking service.
#
# Executed by the official postgres image ONLY when the data directory is
# empty (first start of a new volume). Changing this file has no effect on an
# existing volume.
#
# Roles:
#   $POSTGRES_USER    – admin/superuser, used only for this initialisation
#   booking_migrator  – owns the tables it creates; runs `prisma migrate deploy`
#   booking_app       – runtime role: DML on business tables (granted by the
#                       migration task), no CREATE/ALTER/DROP/TRUNCATE
#
# The current tables live in the public schema (temporary, until the planned
# move to a dedicated `booking` schema). No schemas of future services here.
set -euo pipefail

: "${BOOKING_MIGRATOR_PASSWORD:?BOOKING_MIGRATOR_PASSWORD is required}"
: "${BOOKING_APP_PASSWORD:?BOOKING_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v db_name="$POSTGRES_DB" \
  -v migrator_password="$BOOKING_MIGRATOR_PASSWORD" \
  -v app_password="$BOOKING_APP_PASSWORD" <<'SQL'
CREATE ROLE booking_migrator LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE booking_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Only these roles (and the admin) may connect; no TEMPORARY for anyone else.
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO booking_migrator, booking_app;

-- Nobody but the migrator may create objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO booking_migrator;
GRANT USAGE ON SCHEMA public TO booking_app;

-- No default privileges for the runtime role (closed by default). The
-- migration task (services/booking/src/migrate) grants DML on business tables
-- only after a successful `prisma migrate deploy`, never on _prisma_migrations.
SQL
