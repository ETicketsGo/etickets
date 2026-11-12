import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * A static tripwire for tenant isolation on signed-in, non-admin routes.
 *
 * ── WHAT IT CAN AND CANNOT PROVE ───────────────────────────────────────────────────
 * There is no row-level security, so a route keeps one organizer out of another's data only if
 * the code behind it asks `OrgAccessService` (or filters by the caller) before reading. Whether
 * a SERVICE does that cannot be decided reliably from source text - the checks take many shapes
 * (`loadOwnedEvent`, `assertEventAccess`, read-then-compare, `deleteMany({ id, organizationId })`)
 * - so behaviour is proved in `tenant-isolation.spec.ts` and the per-domain specs. This file
 * checks only the two things a controller can get wrong on its own, with no false positives:
 *
 *   1. The handler takes the caller (`@CurrentUser()`) and actually hands it on. A handler that
 *      never uses the caller cannot be making ANY decision about who the caller is, so every id
 *      it takes reaches the database for anybody signed in.
 *   2. A handler that queries Prisma itself (bypassing a service) also asks `this.access` in the
 *      same handler, or through a private method of the same controller that does.
 *
 * Staff routes (`/admin`, `@RequiresAdmin`) and `@Public()` routes are out of scope here; the
 * staff surface has `admin-surface.spec.ts` and `organizer-route-policy.spec.ts`.
 *
 * A new route that legitimately fails a rule goes in an allowlist below WITH the reason.
 */

/** Signed-in routes that need nobody's identity, and why. */
const NO_CALLER_ALLOWED: Record<string, string> = {
  // Sends a code to a phone; attaching it (the `verify` route) is what uses the account.
  'AuthController.requestAttachCode': 'sends an OTP only; the account is used on verify',
  'WebPushController.vapidKey': 'the public VAPID key, the same for everybody',
  'TheaterOperationsController.layoutTemplates': 'a static catalogue of layout shapes',
  'WalletPassController.providers': 'which wallet providers are configured; no data',
};

/** Handlers that query Prisma directly with no `this.access` call, and why that is safe. */
const DIRECT_PRISMA_ALLOWED: Record<string, string> = {
  'MfaController.enrollStart': "reads the caller's own user row (where id = user.id)",
  'MeCommunicationConsentController.get':
    "the caller's own follows and consent rows (where userId = user.id); organization names only",
  'MeCommunicationConsentController.setOrganizer':
    "checks only that the organization exists, then records the CALLER's own consent for it",
};

const VERBS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All']);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return entry.endsWith('.controller.ts') ? [full] : [];
  });
}

function decorators(node: ts.Node, sf: ts.SourceFile) {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).flatMap((d) =>
    ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression)
      ? [
          {
            name: d.expression.expression.text,
            args: d.expression.arguments.map((a) => a.getText(sf)),
          },
        ]
      : [],
  );
}

function identifierUsed(body: ts.Node, name: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) found = true;
    else ts.forEachChild(n, walk);
  };
  walk(body);
  return found;
}

/** `this.<name>(` calls in a body. */
function thisCalls(body: ts.Node): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      out.push(n.expression.name.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return out;
}

const ACCESS = /\bthis\.access\./;

interface Handler {
  route: string;
  handler: string;
  file: string;
  usesCaller: boolean;
  directPrisma: boolean;
  asksAccess: boolean;
}

function signedInHandlers(): Handler[] {
  const root = join(__dirname, '..');
  const out: Handler[] = [];
  for (const file of controllerFiles(root)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const onClass = decorators(node, sf);
        const base = (onClass.find((d) => d.name === 'Controller')?.args[0] ?? "''").replace(
          /'/g,
          '',
        );
        // Private helpers of this controller that ask `this.access` (e.g. assertMayView).
        const checkingHelpers = new Set(
          node.members
            .filter(ts.isMethodDeclaration)
            .filter((m) => !decorators(m, sf).some((d) => VERBS.has(d.name)))
            .filter((m) => m.body && ACCESS.test(m.body.getText(sf)))
            .map((m) => m.name.getText(sf)),
        );
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || !member.body) continue;
          const onMethod = decorators(member, sf);
          const verb = onMethod.find((d) => VERBS.has(d.name));
          if (!verb) continue;
          const all = [...onMethod, ...onClass];
          if (all.some((d) => d.name === 'Public' || d.name === 'RequiresAdmin')) continue;
          const path = (verb.args[0] ?? "''").replace(/'/g, '');
          const route = `${verb.name.toUpperCase()} /${[base, path].filter(Boolean).join('/')}`;
          if (route.split(' ')[1].startsWith('/admin')) continue;

          const callerParam = member.parameters.find((p) =>
            decorators(p, sf).some((d) => d.name === 'CurrentUser'),
          );
          const body = member.body;
          const text = body.getText(sf);
          out.push({
            route,
            handler: `${node.name?.text}.${member.name.getText(sf)}`,
            file: relative(root, file),
            usesCaller: !!callerParam && identifierUsed(body, callerParam.name.getText(sf)),
            directPrisma: /\bthis\.prisma\b/.test(text),
            asksAccess: ACCESS.test(text) || thisCalls(body).some((c) => checkingHelpers.has(c)),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe('tenant route guard (static)', () => {
  const handlers = signedInHandlers();

  it('finds the signed-in routes', () => {
    // A walker that matched nothing would make the checks below vacuous.
    expect(handlers.length).toBeGreaterThan(250);
    expect(handlers.some((h) => h.directPrisma)).toBe(true);
  });

  it('every signed-in route hands the caller on, or is allowlisted with a reason', () => {
    const missing = handlers
      .filter((h) => !h.usesCaller && !NO_CALLER_ALLOWED[h.handler])
      .map((h) => `${h.route} (${h.handler}, ${h.file})`);
    expect(missing).toEqual([]);
  });

  it('a handler that queries Prisma itself also asks OrgAccessService', () => {
    const unchecked = handlers
      .filter((h) => h.directPrisma && !h.asksAccess && !DIRECT_PRISMA_ALLOWED[h.handler])
      .map((h) => `${h.route} (${h.handler}, ${h.file})`);
    expect(unchecked).toEqual([]);
  });

  it('keeps the allowlists honest: every entry still exists and still needs to be there', () => {
    const byName = new Map(handlers.map((h) => [h.handler, h]));
    const stale = [
      ...Object.keys(NO_CALLER_ALLOWED).filter((k) => !byName.has(k) || byName.get(k)!.usesCaller),
      ...Object.keys(DIRECT_PRISMA_ALLOWED).filter(
        (k) => !byName.has(k) || !byName.get(k)!.directPrisma || byName.get(k)!.asksAccess,
      ),
    ];
    expect(stale).toEqual([]);
  });
});
