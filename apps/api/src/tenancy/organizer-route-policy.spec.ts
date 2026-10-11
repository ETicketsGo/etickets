import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { AdminPermission } from '@eticketsgo/shared-types';

/**
 * Every route outside `/admin` has a written answer to "what may platform staff do here?".
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The organizer API was never covered by the admin capability model: `admin-surface.spec.ts`
 * checks routes restricted to staff, and organizer routes are not. Platform staff reached them
 * through a bypass in `OrgAccessService` that nobody had listed - including the payout bank
 * account. Closing it made the default safe (staff who are not members are refused unless the
 * call site names a capability), but a default is only as good as the next person's
 * understanding of it. So every route is listed here with its policy, and the build fails when:
 *
 *   - a route is added, or removed, without this table changing with it;
 *   - a route the table calls ORGANIZER_ONLY loses its `@OrganizerOnly` door, or gains back
 *     ADMIN / SUPER_ADMIN in its `@Roles`;
 *   - code names a staff capability for an organizer operation (`{ permission, operation }`)
 *     that is not in the documented list below - i.e. somebody opens a new staff path.
 *
 * docs/security/ADMIN-PERMISSION-MATRIX.md ("Organizer API") is the same table in words.
 */

/** What platform staff who are NOT members of the organization get on a route. */
type StaffPolicy =
  /** Nothing. The tenant check refuses them (and audits it); members decide as before. */
  | 'NONE'
  /** Nothing, refused at the door by `@OrganizerOnly` before the handler runs, and audited. */
  | 'ORGANIZER_ONLY'
  /** The caller's own account, bookings or tickets. No organization is involved. */
  | 'SELF'
  /**
   * A customer's booking or ticket, which staff reach by ROLE today (bookings, tickets,
   * attendee and sharing services check `ADMIN` directly). Not organizer resources and not
   * changed here; listed so they are visible, and reported as a follow-up.
   */
  | 'CUSTOMER_RESOURCE_STAFF_BY_ROLE'
  /** A staff-only route already gated by `@RequiresAdmin` (admin-surface.spec.ts). */
  | 'ADMIN_ROUTE'
  /** A documented staff operation: this capability, audited allowed and refused. */
  | { permission: AdminPermission; operation: string };

const ORG_READ = (operation: string) => ({ permission: AdminPermission.ORGANIZER_READ, operation });

export const ORGANIZER_ROUTE_POLICY: Record<string, StaffPolicy> = {
  // ── Organizer AI ──
  'GET /ai/events/:eventId/summary': 'NONE',
  'GET /ai/events/:eventId/recommendations': 'NONE',
  'POST /ai/organizer/ask': 'NONE',
  'POST /ai/content/draft': 'SELF',
  // ── Analytics ──
  'GET /analytics/organizer': 'NONE',
  'GET /analytics/venue/:venueId': 'NONE',
  'GET /analytics/customer': 'SELF',
  // ── Attendees ──
  'POST /tickets/:id/attendee': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /tickets/:id/invite': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /tickets/:id/transfer': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /tickets/:id/unassign': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'GET /bookings/:id/attendees': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /attendee-invites/:token/accept': 'SELF',
  'POST /attendee-invites/:token/decline': 'SELF',
  'POST /attendee-invites/:id/resend': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'GET /events/:id/attendees': 'NONE',
  'GET /events/:id/attendees/export': 'NONE',
  // ── Account ──
  'POST /auth/phone/attach/request-code': 'SELF',
  'POST /auth/phone/attach/verify': 'SELF',
  'GET /auth/me': 'SELF',
  // ── Bookings (the buyer's) ──
  'POST /bookings': 'SELF',
  'GET /bookings': 'SELF',
  'GET /bookings/:id': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /bookings/:id/coupon': 'SELF',
  'POST /bookings/:id/extend-hold': 'SELF',
  'POST /bookings/:id/pay': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /bookings/:id/cancel': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /bookings/guest/:id/claim': 'SELF',
  'POST /bookings/:bookingId/payments/razorpay/verify': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  // ── Check-in at the door (ADMIN stays in @Roles; the tenant check refuses non-members) ──
  'POST /checkins': 'NONE',
  'GET /checkins/sessions': 'NONE',
  'GET /checkins/roster': 'NONE',
  'GET /checkins/bookings': 'NONE',
  'POST /checkins/visual': 'NONE',
  'POST /checkins/reverse': 'NONE',
  // ── Offline check-in ──
  'POST /checkin/devices': 'NONE',
  'POST /checkin/devices/:id/approve': 'NONE',
  'POST /checkin/devices/:id/suspend': 'NONE',
  'POST /checkin/devices/:id/revoke': 'NONE',
  'POST /checkin/devices/:id/report-lost': 'NONE',
  'GET /checkin/devices': 'NONE',
  'GET /checkin/manifest': 'NONE',
  'POST /checkin/reconcile': 'NONE',
  'GET /checkin/deltas': 'NONE',
  'POST /checkin/drills': 'NONE',
  'GET /checkin/drills': 'NONE',
  'GET /checkin/offline-readiness': 'NONE',
  'GET /checkin/activation': 'NONE',
  'POST /checkin/activation/record': 'NONE',
  'POST /checkin/activation/:id/revoke': 'NONE',
  'GET /checkin/activation/decisions': 'NONE',
  'GET /checkin/reconciliation': 'NONE',
  'POST /checkin/reconciliation/:id/resolve': 'NONE',
  'GET /checkin/command-center': 'NONE',
  'GET /checkin/command-center/activity': 'NONE',
  'POST /checkin/command-center/alerts/ack': 'NONE',
  'POST /checkin/preflight': 'NONE',
  // ── Cinemas, screens ──
  'GET /cinemas/:id/seat-classes': 'NONE',
  'PATCH /cinemas/:id/seat-classes/:seatCategoryId': 'NONE',
  'GET /cinemas/:id/pricing-compliance': 'NONE',
  'GET /cinemas/:id/pilot-readiness': 'NONE',
  'POST /cinemas': 'NONE',
  'GET /cinemas': 'NONE',
  'GET /cinemas/:id': 'NONE',
  'PATCH /cinemas/:id': 'NONE',
  'GET /cinemas/:cinemaId/screens': 'NONE',
  'POST /cinemas/:cinemaId/screens': 'NONE',
  'PATCH /screens/:id': 'NONE',
  'DELETE /screens/:id': 'NONE',
  // ── Add-ons, bundles, coupons ──
  'GET /events/:eventId/addons': 'NONE',
  'POST /events/:eventId/addons': 'NONE',
  'PATCH /addons/:id': 'NONE',
  'DELETE /addons/:id': 'NONE',
  'GET /events/:eventId/bundles': 'NONE',
  'POST /events/:eventId/bundles': 'NONE',
  'PATCH /bundles/:id': 'NONE',
  'DELETE /bundles/:id': 'NONE',
  'GET /coupons': 'NONE',
  'POST /coupons': 'NONE',
  'PATCH /coupons/:id': 'NONE',
  'DELETE /coupons/:id': 'NONE',
  // ── Events ──
  'POST /events': 'NONE',
  'GET /events': 'NONE',
  'GET /events/seating-rooms': 'NONE',
  /** The admin console's event page. */
  'GET /events/:id': ORG_READ('event.read'),
  'PATCH /events/:id': 'NONE',
  /** The admin console's Delete on an event nobody bought into: moderation. */
  'DELETE /events/:id': { permission: AdminPermission.EVENT_REVIEW, operation: 'event.delete' },
  'POST /events/:id/images': 'NONE',
  'PUT /events/:id/images/order': 'NONE',
  'PUT /events/:id/images/:imageId/focal-point': 'NONE',
  'DELETE /events/:id/images/:imageId': 'NONE',
  'POST /events/:id/sessions': 'NONE',
  'PATCH /events/sessions/:sessionId/seating': 'NONE',
  'POST /events/ticket-types': 'NONE',
  'PATCH /events/ticket-types/:id': 'NONE',
  'DELETE /events/ticket-types/:id': 'NONE',
  'GET /events/:id/orders': 'NONE',
  'GET /events/:id/sellability': 'NONE',
  'POST /events/:id/submit': 'NONE',
  'POST /events/:id/duplicate': 'NONE',
  'GET /events/:id/promotion': 'NONE',
  'POST /events/:id/pause': 'NONE',
  'POST /events/:id/resume': 'NONE',
  'GET /organizer-calendar': 'NONE',
  'GET /organizer-calendar/sale-eligibility': 'NONE',
  'GET /organizer-calendar/event-sale-eligibility': 'NONE',
  // ── Movies ──
  'POST /movies': 'NONE',
  'GET /movies': 'NONE',
  'GET /movies/:id': 'NONE',
  'PATCH /movies/:id': 'NONE',
  'POST /movies/:id/status': 'NONE',
  // ── Notifications and preferences (the caller's own) ──
  'GET /notifications/feed': 'SELF',
  'POST /notifications/read-many': 'SELF',
  'GET /me/marketing-consent': 'SELF',
  'PUT /me/marketing-consent': 'SELF',
  'GET /me/notification-preferences': 'SELF',
  'PUT /me/notification-preferences': 'SELF',
  'GET /notifications': 'SELF',
  'GET /notifications/unread-count': 'SELF',
  'POST /notifications/:id/read': 'SELF',
  'POST /notifications/read-all': 'SELF',
  'GET /push/vapid-public-key': 'SELF',
  'POST /push/subscribe': 'SELF',
  'POST /push/unsubscribe': 'SELF',
  // ── Organizations ──
  /** Registering an organization makes the caller its owner. */
  'POST /organizations': 'SELF',
  /** The caller's memberships, for staff too. */
  'GET /organizations': 'SELF',
  /** The admin console's organizer page; readiness and actions use the same gate. */
  'GET /organizations/:id': ORG_READ('organization.read'),
  'GET /organizations/:id/readiness': ORG_READ('organization.read'),
  'GET /organizations/:id/actions': ORG_READ('organization.read'),
  'POST /organizations/:id/logo': 'NONE',
  'DELETE /organizations/:id/logo': 'NONE',
  'POST /organizations/:id/cover': 'NONE',
  'DELETE /organizations/:id/cover': 'NONE',
  'PATCH /organizations/:id': 'NONE',
  /** Staff read it on GET /admin/organizers/:id/legal-identity (ORGANIZER_REVIEW). */
  'GET /organizations/:id/legal-identity': 'NONE',
  /** Staff record it on PATCH /admin/organizers/:id/legal-identity (ORGANIZER_REVIEW). */
  'PATCH /organizations/:id/legal-identity': 'ORGANIZER_ONLY',
  /** The admin console's organizer page lists the team. */
  'GET /organizations/:id/members': ORG_READ('organization.members.read'),
  'PATCH /organizations/:id/cash-payments': 'NONE',
  'GET /organizations/:id/cash-bookings': 'NONE',
  'POST /organizations/:id/members': 'NONE',
  'POST /organizations/:id/members/:memberId/resend-invite': 'NONE',
  // ── Where an organizer is paid ──
  'POST /organizers/:organizerId/payments/stripe/account': 'ORGANIZER_ONLY',
  'POST /organizers/:organizerId/payments/stripe/onboarding-link': 'ORGANIZER_ONLY',
  'GET /organizers/:organizerId/payments/status': 'ORGANIZER_ONLY',
  'POST /organizers/:organizerId/payments/stripe/dashboard-link': 'ORGANIZER_ONLY',
  'POST /organizers/:organizerId/payments/razorpay/account': 'ORGANIZER_ONLY',
  'GET /organizers/:organizerId/payments/razorpay/status': 'ORGANIZER_ONLY',
  // ── Money ──
  'POST /payments/:bookingId/collect-cash': 'ORGANIZER_ONLY',
  'GET /payouts': 'NONE',
  'GET /payouts/finance': 'NONE',
  'GET /payouts/summary': 'NONE',
  'GET /payouts/account-state': 'NONE',
  'GET /payouts/accounts': 'NONE',
  'POST /payouts/accounts': 'ORGANIZER_ONLY',
  'POST /payouts/generate': 'ORGANIZER_ONLY',
  'GET /receipts/mine': 'SELF',
  /** The buyer, or a member of the selling organization. */
  'GET /receipts/booking/:bookingId': 'NONE',
  'GET /receipts/:id': 'NONE',
  'GET /receipts/:id/html': 'NONE',
  'GET /organizations/:organizationId/receipts': 'ORGANIZER_ONLY',
  /** The buyer only. Staff are refused and the attempt audited. */
  'POST /refunds': 'SELF',
  /** The admin console's booking page lists a booking's refunds. */
  'GET /refunds/booking/:bookingId': {
    permission: AdminPermission.BOOKING_READ,
    operation: 'refund.list-for-booking',
  },
  /** The admin refund queue's Approve and Reject. Organizers: the booking's OWNER. */
  'POST /refunds/:id/process': {
    permission: AdminPermission.REFUND_APPROVE,
    operation: 'refund.decide',
  },
  'GET /organizations/:organizationId/refunds': 'ORGANIZER_ONLY',
  'GET /reports/events/:eventId': 'NONE',
  'GET /reports/events/:eventId/commerce': 'NONE',
  // ── Reviews, sharing, tickets (the caller's own) ──
  'POST /reviews': 'SELF',
  'GET /reviews/movies/:slug/mine': 'SELF',
  'GET /reviews/mine': 'SELF',
  'POST /tickets/:id/share': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'GET /tickets/:id/shares': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /shares/:id/revoke': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /shares/:id/extend': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'POST /shares/:id/permission': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  'GET /tickets': 'SELF',
  'GET /tickets/booking/:bookingId/print': 'NONE',
  'GET /tickets/:id': 'CUSTOMER_RESOURCE_STAFF_BY_ROLE',
  // ── Shows, seat maps and layouts ──
  'POST /screens/:screenId/seatmap': 'NONE',
  'GET /screens/:screenId/seatmap': 'NONE',
  'POST /movies/:movieId/shows': 'NONE',
  'POST /movies/:movieId/shows/bulk': 'NONE',
  'POST /movies/:movieId/shows/copy': 'NONE',
  'POST /shows/:sessionId/pause': 'NONE',
  'POST /shows/:sessionId/reopen': 'NONE',
  'POST /shows/:sessionId/cancel': 'NONE',
  'GET /shows/:sessionId/pricing': 'NONE',
  'PATCH /shows/:sessionId/pricing': 'NONE',
  'POST /shows/:sessionId/reschedule': 'NONE',
  'GET /cinemas/:cinemaId/schedule': 'NONE',
  'GET /movies/:movieId/shows': 'NONE',
  'GET /screens/:screenId/seat-layouts': 'NONE',
  'POST /screens/:screenId/seat-layouts': 'NONE',
  /** A static catalogue of layout shapes. */
  'GET /seat-layout-templates': 'SELF',
  'GET /seat-layouts/:layoutId/preview': 'NONE',
  'POST /seat-layouts/:layoutId/clone': 'NONE',
  'POST /seat-layouts/:layoutId/draft': 'NONE',
  'POST /seat-layouts/:layoutId/from-template': 'NONE',
  'POST /seat-layouts/:layoutId/publish': 'NONE',
  'POST /seat-layouts/:layoutId/archive': 'NONE',
  'DELETE /seat-layouts/:layoutId': 'NONE',
  'GET /seat-layouts/compare': 'NONE',
  'POST /shows/:sessionId/seats/block': 'NONE',
  'POST /shows/:sessionId/seats/release': 'NONE',
  'GET /shows/:sessionId/seats/:seatId/companions': 'NONE',
  'GET /shows/:sessionId/occupancy': 'NONE',
  'GET /shows/:sessionId/live-seat-map': 'NONE',
  'GET /cinemas/:cinemaId/occupancy': 'NONE',
  'GET /cinemas/:cinemaId/reports/seat-overrides': 'NONE',
  // ── Users (the caller's own, plus the staff directory) ──
  'GET /users/me/devices': 'SELF',
  'POST /users/me/devices': 'SELF',
  'PATCH /users/me/devices/:deviceId': 'SELF',
  'DELETE /users/me/devices/:deviceId': 'SELF',
  'GET /users/me': 'SELF',
  'PATCH /users/me': 'SELF',
  'DELETE /users/me': 'SELF',
  'GET /users': 'ADMIN_ROUTE',
  'GET /users/directory-summary': 'ADMIN_ROUTE',
  // ── Venues ──
  'POST /venues': 'NONE',
  'GET /venues': 'NONE',
  'GET /venues/spaces': 'NONE',
  'PATCH /venues/:id': 'NONE',
  'GET /venues/:id': 'NONE',
  'GET /venues/:id/spaces': 'NONE',
  'POST /venues/:id/spaces': 'NONE',
  // ── Wallet passes (the holder's) ──
  'GET /wallet/providers': 'SELF',
  'POST /wallet/passes': 'SELF',
};

/**
 * Routes outside /admin whose @Roles may still list ADMIN / SUPER_ADMIN, and why. Anything
 * else listing a staff role beside organizer roles is a route nobody decided about.
 */
const STAFF_IN_ROLES_ALLOWED = new Set([
  // Refund decisions: staff need REFUND_APPROVE, checked and audited in RefundsService.
  'RefundsController.process',
  // Check-in: the tenant check refuses staff who are not members of the ticket's organization.
  'CheckinsController.scan',
  'CheckinsController.gateSessions',
  'CheckinsController.roster',
  'CheckinsController.findBookings',
  'CheckinsController.visual',
  'CheckinsController.reverse',
  // Staff-only routes under /users, gated by @RequiresAdmin(BOOKING_READ).
  'UsersController.list',
  'UsersController.directorySummary',
]);

const VERBS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All']);
const STAFF_ROLES = new Set(['Role.ADMIN', 'Role.SUPER_ADMIN']);

function sourceFiles(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, match));
    else if (match(entry)) out.push(full);
  }
  return out;
}

interface RouteFact {
  key: string;
  handler: string;
  roles: string[];
  organizerOnly: boolean;
}

function decoratorsOf(node: ts.Node, sf: ts.SourceFile) {
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

/** Every non-admin, non-public route, the way Nest resolves its decorators. */
function organizerRoutes(): RouteFact[] {
  const out: RouteFact[] = [];
  const files = sourceFiles(join(__dirname, '..'), (n) => n.endsWith('.controller.ts'));
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const onClass = decoratorsOf(node, sf);
        const ctl = onClass.find((d) => d.name === 'Controller');
        const base = (ctl?.args[0] ?? "''").replace(/'/g, '');
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const onMethod = decoratorsOf(member, sf);
          const verb = onMethod.find((d) => VERBS.has(d.name));
          if (!verb) continue;
          if ([...onMethod, ...onClass].some((d) => d.name === 'Public')) continue;
          const path = (verb.args[0] ?? "''").replace(/'/g, '');
          const full = `/${[base, path].filter(Boolean).join('/')}`;
          if (full.startsWith('/admin')) continue;
          const roles =
            (onMethod.find((d) => d.name === 'Roles') ?? onClass.find((d) => d.name === 'Roles'))
              ?.args ?? [];
          out.push({
            key: `${verb.name.toUpperCase()} ${full}`,
            handler: `${node.name?.text}.${member.name.getText(sf)}`,
            roles,
            organizerOnly: [...onMethod, ...onClass].some((d) => d.name === 'OrganizerOnly'),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Every `{ permission: AdminPermission.X, operation: '...' }` in production code: the staff
 * capabilities named for organizer operations (`PlatformPolicy`), wherever they are written.
 */
function namedStaffOperations(): { operation: string; permission: string; file: string }[] {
  const out: { operation: string; permission: string; file: string }[] = [];
  const files = sourceFiles(
    join(__dirname, '..'),
    (n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'),
  );
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (name: string) =>
          node.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === name,
          );
        const permission = prop('permission');
        const operation = prop('operation');
        if (
          permission &&
          operation &&
          permission.initializer.getText(sf).startsWith('AdminPermission.') &&
          ts.isStringLiteral(operation.initializer)
        ) {
          out.push({
            operation: operation.initializer.text,
            permission: permission.initializer.getText(sf).replace('AdminPermission.', ''),
            file: file.split(/[\\/]/).slice(-2).join('/'),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe('every organizer route has a written staff policy', () => {
  const routes = organizerRoutes();

  it('finds the routes to check', () => {
    // A walker that silently matched nothing would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(200);
  });

  it('lists exactly the routes that exist: a new route fails until its staff policy is written', () => {
    const actual = new Set(routes.map((r) => r.key));
    const listed = new Set(Object.keys(ORGANIZER_ROUTE_POLICY));
    expect([...actual].filter((k) => !listed.has(k)).sort()).toEqual([]);
    expect([...listed].filter((k) => !actual.has(k)).sort()).toEqual([]);
  });

  it('puts the @OrganizerOnly door on exactly the ORGANIZER_ONLY routes, with no staff role', () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const policy = ORGANIZER_ROUTE_POLICY[r.key];
      if ((policy === 'ORGANIZER_ONLY') !== r.organizerOnly) wrong.push(`${r.key} door`);
      if (policy === 'ORGANIZER_ONLY' && r.roles.some((x) => STAFF_ROLES.has(x))) {
        wrong.push(`${r.key} still lists a staff role`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('lists ADMIN / SUPER_ADMIN in @Roles only where somebody decided it', () => {
    const undecided = routes
      .filter((r) => r.roles.some((x) => STAFF_ROLES.has(x)))
      .filter((r) => !STAFF_IN_ROLES_ALLOWED.has(r.handler))
      .map((r) => `${r.key} (${r.handler})`);
    expect(undecided).toEqual([]);
  });

  it('opens no staff path that is not documented: every named capability is in the table', () => {
    const documented = new Map<string, string>();
    for (const policy of Object.values(ORGANIZER_ROUTE_POLICY)) {
      if (typeof policy === 'object') documented.set(policy.operation, policy.permission);
    }
    const named = namedStaffOperations();
    // Finding none would mean the scan stopped seeing them, not that there are none.
    expect(named.length).toBeGreaterThanOrEqual(documented.size);
    const undocumented = named
      .filter((n) => documented.get(n.operation) !== n.permission)
      .map((n) => `${n.file}: ${n.operation} -> ${n.permission}`);
    expect(undocumented).toEqual([]);
    // And the other way: a documented staff operation that no code names is a stale promise.
    const inCode = new Set(named.map((n) => n.operation));
    expect([...documented.keys()].filter((op) => !inCode.has(op))).toEqual([]);
  });

  it('documents only the staff capabilities that already meant this, and invents none', () => {
    const used = new Set(
      Object.values(ORGANIZER_ROUTE_POLICY).flatMap((p) =>
        typeof p === 'object' ? [p.permission] : [],
      ),
    );
    expect([...used].sort()).toEqual(
      [
        AdminPermission.BOOKING_READ,
        AdminPermission.EVENT_REVIEW,
        AdminPermission.ORGANIZER_READ,
        AdminPermission.REFUND_APPROVE,
      ].sort(),
    );
  });
});
