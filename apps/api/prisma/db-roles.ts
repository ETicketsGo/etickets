import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * Least-privilege database logins.
 *
 * Every service connects as `postgres`, the cluster SUPERUSER and the only login role (verified
 * on PROD 2026-11-12). One SQL injection or one leaked DATABASE_URL is therefore full control of
 * the database server: DROP anything, read any file the server can, create roles, turn off
 * logging. Nothing the running application does needs any of that.
 *
 *   etg_app       api + worker at runtime. Read and write rows; no DDL, no roles, no DROP,
 *                 no TRUNCATE, cannot create databases, cannot bypass row-level security.
 *   etg_readonly  audits, support queries and the fingerprint script. SELECT only, and every
 *                 transaction read-only by default.
 *   postgres      unchanged. Stays the OWNER of every table and is the ONLY credential that
 *                 runs migrations (api preDeployCommand via MIGRATION_DATABASE_URL) and
 *                 backups / restore drills (db-seed).
 *
 * New tables created by future migrations are covered automatically through ALTER DEFAULT
 * PRIVILEGES, so a migration never has to remember to grant.
 *
 * Passwords never reach the server, the logs or this process's output as plaintext: the role's
 * password is set from a SCRAM-SHA-256 verifier computed here (the same format Postgres stores
 * in pg_authid), so `log_statement` or an error message can at worst show a verifier.
 */
export const APP_ROLE = 'etg_app';
export const READONLY_ROLE = 'etg_readonly';

export interface RoleOptions {
  /** The role that owns the schema objects and runs migrations (the current `postgres`). */
  owner: string;
  database: string;
  schema?: string;
  appRole?: string;
  readonlyRole?: string;
  /** SCRAM verifiers, never plaintext. Omit to leave an existing password alone. */
  appPasswordVerifier?: string;
  readonlyPasswordVerifier?: string;
}

const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
};
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The idempotent statements, in order. Safe to run any number of times. */
export function leastPrivilegeStatements(o: RoleOptions): string[] {
  const schema = ident(o.schema ?? 'public');
  const owner = ident(o.owner);
  const db = ident(o.database);
  const app = ident(o.appRole ?? APP_ROLE);
  const ro = ident(o.readonlyRole ?? READONLY_ROLE);
  const create = (role: string, raw: string) =>
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(raw)}) ` +
    `THEN CREATE ROLE ${role} LOGIN; END IF; END $$`;
  const restrict = (role: string) =>
    `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;

  const s: string[] = [
    create(app, o.appRole ?? APP_ROLE),
    restrict(app),
    create(ro, o.readonlyRole ?? READONLY_ROLE),
    restrict(ro),
    `ALTER ROLE ${ro} SET default_transaction_read_only = on`,
    `ALTER ROLE ${ro} SET statement_timeout = '30s'`,

    `GRANT CONNECT ON DATABASE ${db} TO ${app}, ${ro}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${app}, ${ro}`,
    // No CREATE on the schema for either: DDL belongs to the migration credential alone.
    `REVOKE CREATE ON SCHEMA ${schema} FROM ${app}, ${ro}`,

    // Rows, not structure. No TRUNCATE, REFERENCES or TRIGGER.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${app}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${app}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${ro}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${ro}`,

    // The migration history is the migration credential's to write. The app may read it.
    `DO $$ BEGIN IF to_regclass(${literal((o.schema ?? 'public') + '._prisma_migrations')}) IS NOT NULL THEN ` +
      `REVOKE INSERT, UPDATE, DELETE ON TABLE ${schema}."_prisma_migrations" FROM ${app}; END IF; END $$`,

    // Tables and sequences that FUTURE migrations create get the same grants automatically.
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${ro}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT ON SEQUENCES TO ${ro}`,

    /*
      The ops dashboard (ops.service.ts database()) counts connections per client and state in
      pg_stat_activity. A non-superuser sees those columns as NULL for every session but its own,
      which would make the dashboard silently under-report. pg_read_all_stats is the built-in,
      read-only role for exactly this. It reads statistics only: no table data.
    */
    `GRANT pg_read_all_stats TO ${app}`,
  ];
  if (o.appPasswordVerifier) s.push(`ALTER ROLE ${app} PASSWORD ${literal(o.appPasswordVerifier)}`);
  if (o.readonlyPasswordVerifier)
    s.push(`ALTER ROLE ${ro} PASSWORD ${literal(o.readonlyPasswordVerifier)}`);
  return s;
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802 / RFC 7677), so the
 * plaintext never has to be sent. `ALTER ROLE ... PASSWORD '<verifier>'` stores it as-is.
 */
export function scramVerifier(password: string, iterations = 4096, salt = randomBytes(16)): string {
  if (password.length < 24) throw new Error('database passwords must be at least 24 characters');
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}

/** A statement with any password verifier masked, for logs and dry runs. */
export const printable = (sql: string): string =>
  sql.replace(/PASSWORD '[^']*'/g, "PASSWORD '<scram verifier>'");
