import { PrismaClient } from '@prisma/client';
import { leastPrivilegeStatements, printable, scramVerifier } from './db-roles';

/**
 * Create or refresh the least-privilege logins (see db-roles.ts). Runs as the CURRENT
 * DATABASE_URL user, which must be the owner of the schema (today: `postgres`).
 *
 *   SEED_OPERATION=db-roles                       dry run: prints the statements, changes nothing
 *   SEED_OPERATION=db-roles DB_ROLES_APPLY=true   applies them in one transaction
 *
 * Passwords come from ETG_APP_DB_PASSWORD / ETG_READONLY_DB_PASSWORD (set on db-seed for the run,
 * removed afterwards). They are converted to SCRAM verifiers here; neither the plaintext nor the
 * verifier is printed. Without them the roles are created or refreshed WITHOUT changing an
 * existing password, and a new role cannot log in until one is set, which fails safe.
 *
 * This only ADDS roles and grants. No running service changes credentials until somebody points
 * its DATABASE_URL at the new role, which is a separate, approved, reversible variable change.
 */
export async function applyDbRoles(prisma: PrismaClient, apply: boolean) {
  const [{ owner, database }] = await prisma.$queryRaw<{ owner: string; database: string }[]>`
    SELECT current_user AS owner, current_database() AS database`;
  const appPw = process.env.ETG_APP_DB_PASSWORD?.trim();
  const roPw = process.env.ETG_READONLY_DB_PASSWORD?.trim();
  const statements = leastPrivilegeStatements({
    owner,
    database,
    appPasswordVerifier: appPw ? scramVerifier(appPw) : undefined,
    readonlyPasswordVerifier: roPw ? scramVerifier(roPw) : undefined,
  });
  if (!apply) {
    console.log(`db-roles DRY RUN as ${owner} on ${database}: ${statements.length} statements`);
    for (const st of statements) console.log(`  ${printable(st)};`);
    return { applied: false, statements: statements.length };
  }
  await prisma.$transaction(statements.map((st) => prisma.$executeRawUnsafe(st)));
  const roles = await prisma.$queryRaw<
    {
      rolname: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      haspw: boolean;
    }[]
  >`SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, (rolpassword IS NOT NULL) AS haspw
      FROM pg_authid WHERE rolname IN ('etg_app', 'etg_readonly') ORDER BY rolname`;
  console.log(`DB_ROLES_JSON ${JSON.stringify({ applied: true, owner, database, roles })}`);
  return { applied: true, statements: statements.length, roles };
}

if (require.main === module) {
  const prisma = new PrismaClient();
  applyDbRoles(prisma, (process.env.DB_ROLES_APPLY ?? '').trim() === 'true')
    .catch((e) => {
      console.error(`db-roles failed: ${(e as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
