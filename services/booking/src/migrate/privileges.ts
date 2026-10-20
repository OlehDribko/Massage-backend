import type pg from "pg";

/**
 * Runtime-role privileges, managed by the migrator (owner of the tables).
 *
 * Closed by default: the runtime role gets no default privileges, so a table
 * created by a migration is inaccessible to it until grantRuntimePrivileges()
 * runs after a *successful* `migrate deploy`. A failed deploy therefore leaves
 * new tables (and _prisma_migrations) without runtime access.
 *
 * The role name is passed as a bind parameter into a transaction-local setting
 * and quoted with format('%I') inside SQL, never interpolated into SQL text.
 * Only schema `public` and objects owned by the current (migrator) role are
 * touched.
 */

const ROLE_SETTING = "booking.runtime_role";

const ROLE_CHECK = `
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime role does not exist' USING ERRCODE = 'undefined_object';
  END IF;
  IF runtime_role = current_user
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'runtime role must be a separate role without superuser or BYPASSRLS'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
`;

/**
 * Before migrations. Idempotent repair of earlier setups:
 * - removes default privileges the migrator used to grant the runtime role
 *   (old init script), so tables created by this deploy start closed;
 * - revokes runtime access to an existing _prisma_migrations.
 * Business-table grants that already exist are kept (no data is touched).
 */
const PREPARE_SQL = `
DO $$
DECLARE
  runtime_role text := current_setting('${ROLE_SETTING}');
BEGIN
  ${ROLE_CHECK}
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', runtime_role);
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON TABLE public._prisma_migrations FROM %I', runtime_role);
  END IF;
END
$$;
`;

/** After a successful deploy: DML on business tables, sequences for serials. */
const GRANT_SQL = `
DO $$
DECLARE
  runtime_role text := current_setting('${ROLE_SETTING}');
  item record;
BEGIN
  ${ROLE_CHECK}
  FOR item IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S')
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND c.relname <> '_prisma_migrations'
  LOOP
    IF item.relkind = 'S' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', item.relname, runtime_role);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', item.relname, runtime_role);
    END IF;
  END LOOP;
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON TABLE public._prisma_migrations FROM %I', runtime_role);
  END IF;
END
$$;
`;

const inTransaction = async (
  client: pg.ClientBase,
  runtimeRole: string,
  sql: string,
): Promise<void> => {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config($1, $2, true)", [ROLE_SETTING, runtimeRole]);
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

export const prepareRuntimePrivileges = (
  client: pg.ClientBase,
  runtimeRole: string,
): Promise<void> => inTransaction(client, runtimeRole, PREPARE_SQL);

export const grantRuntimePrivileges = (
  client: pg.ClientBase,
  runtimeRole: string,
): Promise<void> => inTransaction(client, runtimeRole, GRANT_SQL);
