import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { ALL_ADMIN_PERMISSIONS } from '@eticketsgo/shared-types';

/**
 * Every admin route carries a capability.
 *
 * ── WHY THIS IS A TEST AND NOT A CODE REVIEW ITEM ──────────────────────────────────
 * The permission model is only worth having if it covers the whole surface. One admin
 * controller added later without `@RequiresAdmin` is a route any admin can call — which
 * silently restores exactly the "every admin can do everything" behaviour this replaced,
 * and does it in the one place nobody thinks to look.
 *
 * A reviewer will not reliably catch that. A failing build will. So the rule is checked
 * against the source itself rather than trusted to habit.
 */
/** Every *.controller.ts under src, walked directly so the check needs no glob library. */
function controllerFiles(dir = join(__dirname, '..')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

describe('the admin surface is fully gated', () => {
  const files = controllerFiles();

  it('finds the controllers to check', () => {
    // A glob that silently matches nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it('gives every admin controller a required capability', () => {
    /*
      Checked per DECLARATION, not per file.

      The first version asked whether the file contained a `@RequiresAdmin` anywhere, which
      is a different question: refunds.controller.ts holds both a public controller and an
      admin one, so removing the gate from the admin class left the file still matching and
      this test still green. Falsifying it is what surfaced that — the removal was only
      caught by a different assertion, which is luck rather than coverage.

      So every `@Controller('admin…')` must carry its own decorator directly above it.
    */
    const ungated: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const name = file.split(/[\/]/).slice(-1)[0];
      for (const m of src.matchAll(/@Controller\('admin[^']*'\)/g)) {
        const preceding = src.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
        if (!/@RequiresAdmin\([^)]*\)\s*$/.test(preceding.trimEnd())) {
          ungated.push(`${name} ${m[0]}`);
        }
      }
    }
    expect(ungated).toEqual([]);
  });

  it('gives every staff-only ROUTE a capability, wherever its @Roles is declared', () => {
    /*
      The check above only looks at `@Controller('admin…')`. `GET /users` lives under `/users`,
      carried a method-level `@Roles(ADMIN)` and no capability — and the guard lets through a route
      that declares none — so an admin granted nothing at all could list every customer's email.
      Neither the path nor the class is a reliable signal, so this reads the decorators the way
      Nest resolves them: the handler's own, falling back to its class's.

      Only routes restricted to platform staff ALONE are held to it. A route shared with
      organizers (`@Roles(ORGANIZER_OWNER, ADMIN)`) cannot carry `@RequiresAdmin` without locking
      the organizers out, because the guard would demand a grant they can never hold.
    */
    const STAFF_ROLES = new Set(['Role.ADMIN', 'Role.SUPER_ADMIN']);
    const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All']);
    const ungated: string[] = [];
    let staffOnlyRoutes = 0;

    for (const file of files) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const decoratorsOf = (node: ts.Node) =>
        (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).flatMap((d) =>
          ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression)
            ? [
                {
                  name: d.expression.expression.text,
                  args: d.expression.arguments.map((a) => a.getText(sf)),
                },
              ]
            : [],
        );

      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node)) {
          const onClass = decoratorsOf(node);
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member)) continue;
            const onMethod = decoratorsOf(member);
            if (!onMethod.some((d) => ROUTE_DECORATORS.has(d.name))) continue;
            const roles =
              (onMethod.find((d) => d.name === 'Roles') ?? onClass.find((d) => d.name === 'Roles'))
                ?.args ?? [];
            if (roles.length === 0 || !roles.every((r) => STAFF_ROLES.has(r))) continue;
            staffOnlyRoutes++;
            const gated = [...onMethod, ...onClass].some(
              (d) => d.name === 'RequiresAdmin' && d.args.length > 0,
            );
            if (!gated) {
              ungated.push(
                `${file.split(/[\\/]/).slice(-1)[0]} ${node.name?.text}.${member.name.getText(sf)}`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // Finding almost none would mean the parser stopped seeing decorators, not that the code
    // became safe — which would make the assertion below vacuous.
    expect(staffOnlyRoutes).toBeGreaterThan(20);
    expect(ungated).toEqual([]);
  });

  it('only ever requires capabilities that exist in the catalogue', () => {
    // A typo in a decorator would compile — `AdminPermission.REFUND_APROVE` is undefined,
    // and an undefined requirement is one nobody can satisfy or, worse, one the guard
    // filters away to an empty list and waves through.
    const known = new Set<string>(ALL_ADMIN_PERMISSIONS);
    const unknown: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/AdminPermission\.([A-Z_]+)/g)) {
        if (!known.has(m[1])) unknown.push(`${file.split(/[\\/]/).slice(-1)[0]}: ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('keeps refund approval separate from refund review', () => {
    /*
      The distinction the whole model exists for. If a single capability ever covers both,
      a refund desk that can investigate can also pay out — which is the thing the split was
      asked for to prevent.
    */
    const controller = files.find((f) => f.endsWith('refunds.controller.ts'));
    expect(controller).toBeDefined();
    // The admin queue is REVIEW: reading requests moves no money.
    expect(readFileSync(controller!, 'utf8')).toContain('AdminPermission.REFUND_REVIEW');

    /*
      Approval is checked in the SERVICE, not on the route, and that is deliberate.

      `POST /refunds/:id/process` serves two audiences: an organizer refunding their own
      customer, and platform staff. A route decorator applies to every caller, so gating the
      route locked organizers out of their own console — the e2e caught it. The service is
      where the two audiences are already told apart, so the requirement lives there.
    */
    // Derived from the controller's own path so the separator is whatever this platform
    // uses — a hardcoded '/' silently matched nothing on Windows and threw instead.
    const svcSrc = readFileSync(
      controller!.replace('refunds.controller.ts', 'refunds.service.ts'),
      'utf8',
    );
    expect(svcSrc).toContain('AdminPermission.REFUND_APPROVE');
    // And it must apply to staff specifically, not to whoever happens to call.
    expect(svcSrc).toContain('isPlatformAdmin');
  });
});
