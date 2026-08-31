/**
 * Canonical enums shared across API and frontends.
 * These mirror the Prisma enums exactly. Prisma is the DB source of truth;
 * this module is the source of truth for code that must not import Prisma
 * (e.g. Next.js apps and validation schemas).
 */

export const Role = {
  CUSTOMER: 'CUSTOMER',
  ORGANIZER_OWNER: 'ORGANIZER_OWNER',
  ORGANIZER_MANAGER: 'ORGANIZER_MANAGER',
  CHECKIN_STAFF: 'CHECKIN_STAFF',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/**
 * The kind of experience an {@link Event} row represents. Existing events are
 * `EVENT`; new experience types are added here without changing the Event table.
 * See ADR-009 (Experience Platform).
 */
export const ExperienceType = {
  EVENT: 'EVENT',
  MOVIE: 'MOVIE',
  MUSEUM: 'MUSEUM',
  THEME_PARK: 'THEME_PARK',
  ATTRACTION: 'ATTRACTION',
  TOUR: 'TOUR',
} as const;
export type ExperienceType = (typeof ExperienceType)[keyof typeof ExperienceType];

/**
 * The inventory model an experience uses. Each {@link ExperienceType} maps to a
 * strategy kind via the ExperienceTypeRegistry; the booking engine never hard-codes
 * a strategy. See ADR-010 (Inventory Strategy).
 */
export const InventoryStrategyKind = {
  GENERAL_ADMISSION: 'GENERAL_ADMISSION',
  SEAT_BASED: 'SEAT_BASED',
  CAPACITY: 'CAPACITY',
  TIME_SLOT: 'TIME_SLOT',
} as const;
export type InventoryStrategyKind =
  (typeof InventoryStrategyKind)[keyof typeof InventoryStrategyKind];

/**
 * How a booking's line prices are computed. Base strategies (FLAT/TIER/SEAT)
 * resolve the unit price; rules (WEEKEND/HOLIDAY/MEMBER/EARLY_BIRD/COUPON/DYNAMIC)
 * are composable adjustments applied on top. Events use TIER, movies use SEAT —
 * both reproduce the platform's original pricing exactly. See ADR-019.
 */
export const PricingStrategyKind = {
  FLAT: 'FLAT',
  TIER: 'TIER',
  SEAT: 'SEAT',
} as const;
export type PricingStrategyKind = (typeof PricingStrategyKind)[keyof typeof PricingStrategyKind];

export const PricingRuleKind = {
  WEEKEND: 'WEEKEND',
  HOLIDAY: 'HOLIDAY',
  MEMBER: 'MEMBER',
  EARLY_BIRD: 'EARLY_BIRD',
  COUPON: 'COUPON',
  DYNAMIC: 'DYNAMIC',
} as const;
export type PricingRuleKind = (typeof PricingRuleKind)[keyof typeof PricingRuleKind];

export const MovieStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type MovieStatus = (typeof MovieStatus)[keyof typeof MovieStatus];

export const EventStatus = {
  DRAFT: 'DRAFT',
  UNDER_REVIEW: 'UNDER_REVIEW',
  PUBLISHED: 'PUBLISHED',
  PAUSED: 'PAUSED',
  SOLD_OUT: 'SOLD_OUT',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

export const BookingStatus = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  DISPUTED: 'DISPUTED',
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

export const TicketStatus = {
  ACTIVE: 'ACTIVE',
  TRANSFERRED: 'TRANSFERRED',
  CHECKED_IN: 'CHECKED_IN',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
  VOID: 'VOID',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const PaymentStatus = {
  REQUIRES_PAYMENT: 'REQUIRES_PAYMENT',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

// Experience Commerce (v1.3).
export const AddOnType = {
  MERCHANDISE: 'MERCHANDISE',
  PARKING: 'PARKING',
  FOOD_BEVERAGE: 'FOOD_BEVERAGE',
  VIP_UPGRADE: 'VIP_UPGRADE',
  MEET_GREET: 'MEET_GREET',
  DONATION: 'DONATION',
  DIGITAL: 'DIGITAL',
} as const;
export type AddOnType = (typeof AddOnType)[keyof typeof AddOnType];

export const BundleType = {
  VIP: 'VIP',
  FAMILY: 'FAMILY',
  COMBO: 'COMBO',
  EARLY_BIRD: 'EARLY_BIRD',
} as const;
export type BundleType = (typeof BundleType)[keyof typeof BundleType];

export const BundlePricingKind = {
  FIXED: 'FIXED',
  PERCENT_DISCOUNT: 'PERCENT_DISCOUNT',
} as const;
export type BundlePricingKind = (typeof BundlePricingKind)[keyof typeof BundlePricingKind];

export const BookingItemKind = {
  TICKET: 'TICKET',
  ADDON: 'ADDON',
  BUNDLE: 'BUNDLE',
} as const;
export type BookingItemKind = (typeof BookingItemKind)[keyof typeof BookingItemKind];

export const PaymentAttemptStatus = {
  CREATED: 'CREATED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;
export type PaymentAttemptStatus = (typeof PaymentAttemptStatus)[keyof typeof PaymentAttemptStatus];

export const RefundStatus = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

export const PayoutStatus = {
  PENDING: 'PENDING',
  SCHEDULED: 'SCHEDULED',
  PAID: 'PAID',
  FAILED: 'FAILED',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

// ─── Stripe Connect marketplace (US) ───

export const ConnectOnboardingStatus = {
  NOT_STARTED: 'NOT_STARTED',
  ONBOARDING: 'ONBOARDING',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ENABLED: 'ENABLED',
  RESTRICTED: 'RESTRICTED',
  DISABLED: 'DISABLED',
  REJECTED: 'REJECTED',
} as const;
export type ConnectOnboardingStatus =
  (typeof ConnectOnboardingStatus)[keyof typeof ConnectOnboardingStatus];

export const SettlementStatus = {
  PENDING: 'PENDING',
  HELD: 'HELD',
  ELIGIBLE: 'ELIGIBLE',
  APPROVED: 'APPROVED',
  TRANSFER_PROCESSING: 'TRANSFER_PROCESSING',
  TRANSFERRED: 'TRANSFERRED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
} as const;
export type SettlementStatus = (typeof SettlementStatus)[keyof typeof SettlementStatus];

export const WebhookProcessingStatus = {
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
  DEAD_LETTER: 'DEAD_LETTER',
  IGNORED: 'IGNORED',
} as const;
export type WebhookProcessingStatus =
  (typeof WebhookProcessingStatus)[keyof typeof WebhookProcessingStatus];

export const DisputeStatus = {
  NEEDS_RESPONSE: 'NEEDS_RESPONSE',
  UNDER_REVIEW: 'UNDER_REVIEW',
  WON: 'WON',
  LOST: 'LOST',
  WARNING_CLOSED: 'WARNING_CLOSED',
  CLOSED: 'CLOSED',
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

export const SessionStatus = {
  SCHEDULED: 'SCHEDULED',
  /**
   * Sales stopped by the operator; the show still happens and existing bookings stand.
   *
   * A status rather than a separate boolean, because booking creation already refuses
   * anything that is not SCHEDULED and the public showtime query already filters on it —
   * so this is enforced by code that exists. A parallel flag would have to be taught to
   * both call sites, and forgetting one means selling tickets to a show the operator
   * believes is closed.
   */
  PAUSED: 'PAUSED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

/**
 * Whether a screen can be scheduled and sold.
 *
 * Deliberately small. MAINTENANCE and INACTIVE both stop NEW scheduling; the difference is
 * intent, which matters to an operator reading a list of screens. Neither touches shows
 * that already exist: taking a screen out of service must never silently cancel a show
 * somebody has paid for. Cancelling is an explicit, audited, per-show act.
 */
export const ScreenStatus = {
  ACTIVE: 'ACTIVE',
  /** Temporarily out of service. Expected back. */
  MAINTENANCE: 'MAINTENANCE',
  /** Retired or not in use. */
  INACTIVE: 'INACTIVE',
} as const;
export type ScreenStatus = (typeof ScreenStatus)[keyof typeof ScreenStatus];

export const FeeMode = {
  CUSTOMER_PAYS: 'CUSTOMER_PAYS',
  ORGANIZER_PAYS: 'ORGANIZER_PAYS',
  SHARED: 'SHARED',
} as const;
export type FeeMode = (typeof FeeMode)[keyof typeof FeeMode];

export const OrganizationStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type OrganizationStatus = (typeof OrganizationStatus)[keyof typeof OrganizationStatus];

/**
 * Account lifecycle. Only ACTIVE may authenticate — see JwtStrategy, which checks this
 * on every authenticated request.
 *
 * DELETED is self-service account deletion: the row is kept because bookings, tickets,
 * settlements and audit entries reference it and are retained for tax and dispute
 * purposes, but every personal field on it is anonymised and the account can never sign
 * in again.
 */
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DELETED: 'DELETED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const MemberStatus = {
  INVITED: 'INVITED',
  ACTIVE: 'ACTIVE',
  REMOVED: 'REMOVED',
} as const;
export type MemberStatus = (typeof MemberStatus)[keyof typeof MemberStatus];

export const NotificationType = {
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  EVENT_REMINDER: 'EVENT_REMINDER',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  REFUND_COMPLETED: 'REFUND_COMPLETED',
  TICKET_CHECKED_IN: 'TICKET_CHECKED_IN',
  ATTENDEE_INVITED: 'ATTENDEE_INVITED',
  ATTENDEE_ACCEPTED: 'ATTENDEE_ACCEPTED',
  ATTENDEE_DECLINED: 'ATTENDEE_DECLINED',
  TICKET_TRANSFERRED: 'TICKET_TRANSFERRED',
  SHARE_CREATED: 'SHARE_CREATED',
  SHARE_VIEWED: 'SHARE_VIEWED',
  SHARE_REVOKED: 'SHARE_REVOKED',
  PAYOUT_ACCOUNT_UPDATED: 'PAYOUT_ACCOUNT_UPDATED',
  SETTLEMENT_RELEASED: 'SETTLEMENT_RELEASED',
  PAYMENT_DISPUTE_OPENED: 'PAYMENT_DISPUTE_OPENED',
  PAYMENT_DISPUTE_CLOSED: 'PAYMENT_DISPUTE_CLOSED',
  TRANSFER_FAILED: 'TRANSFER_FAILED',
  /// Account security. Addressed to the account holder about their own credentials, and
  /// never promotional — see MESSAGE_CLASS, which will not compile until this is classified.
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  // Onboarding + approval lifecycle (admin-directed, and their organizer replies).
  ORGANIZATION_REGISTERED: 'ORGANIZATION_REGISTERED',
  ORGANIZATION_APPROVED: 'ORGANIZATION_APPROVED',
  ORGANIZATION_REJECTED: 'ORGANIZATION_REJECTED',
  EVENT_SUBMITTED: 'EVENT_SUBMITTED',
  EVENT_APPROVED: 'EVENT_APPROVED',
  EVENT_REJECTED: 'EVENT_REJECTED',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/**
 * What a share link lets its holder do with a resource (ADR-032). VIEW is
 * read-only (no live QR); GUEST grants temporary, expiring access including the
 * live QR so the holder can be checked in; TRANSFER hands over ownership (reuses
 * the Sprint-4 accept flow + QR rotation). Never creates a second valid QR.
 */
export const SharePermission = {
  VIEW: 'VIEW',
  GUEST: 'GUEST',
  TRANSFER: 'TRANSFER',
} as const;
export type SharePermission = (typeof SharePermission)[keyof typeof SharePermission];

/**
 * The kind of shareable resource. Only TICKET exists today; the sharing platform
 * is generic (ShareableResource) so memberships, passes, vouchers and parking
 * plug in later (Experience Wallet) without a schema change. See ADR-032.
 */
export const ResourceType = {
  TICKET: 'TICKET',
  MEMBERSHIP: 'MEMBERSHIP',
  PARKING_PASS: 'PARKING_PASS',
  FOOD_VOUCHER: 'FOOD_VOUCHER',
  VIP_PASS: 'VIP_PASS',
} as const;
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

/**
 * The assignment lifecycle of a ticket to an attendee (the identity layer). This
 * is orthogonal to {@link TicketStatus} (gate/refund lifecycle): a ticket can be
 * ACCEPTED (assignment) and CHECKED_IN (gate) at the same time. Reused by every
 * experience type — events, movies, attractions, memberships. See ADR-031.
 */
export const AttendeeAssignmentStatus = {
  UNASSIGNED: 'UNASSIGNED',
  ASSIGNED: 'ASSIGNED',
  INVITED: 'INVITED',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
} as const;
export type AttendeeAssignmentStatus =
  (typeof AttendeeAssignmentStatus)[keyof typeof AttendeeAssignmentStatus];

/** Whether an invite hands a ticket to a new holder (INVITE) or gives it away (TRANSFER). */
export const TicketInviteKind = {
  INVITE: 'INVITE',
  TRANSFER: 'TRANSFER',
} as const;
export type TicketInviteKind = (typeof TicketInviteKind)[keyof typeof TicketInviteKind];

/** Lifecycle of a single invitation/transfer token. */
export const TicketInviteStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;
export type TicketInviteStatus = (typeof TicketInviteStatus)[keyof typeof TicketInviteStatus];

export const CheckInResult = {
  SUCCESS: 'SUCCESS',
  DUPLICATE: 'DUPLICATE',
  INVALID: 'INVALID',
  CANCELLED: 'CANCELLED',
  WRONG_SESSION: 'WRONG_SESSION',
} as const;
export type CheckInResult = (typeof CheckInResult)[keyof typeof CheckInResult];

/** Lifecycle of a registered offline check-in device (ADR-035). */
export const CheckInDeviceStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;
export type CheckInDeviceStatus = (typeof CheckInDeviceStatus)[keyof typeof CheckInDeviceStatus];

/**
 * The kind of customer-success submission. CONTACT/BUG/FEATURE/GENERAL are
 * free-form; CSAT/ORGANIZER_CSAT carry a 1..5 satisfaction rating. See ADR
 * (Customer Success).
 */
export const FeedbackKind = {
  CONTACT: 'CONTACT',
  BUG: 'BUG',
  FEATURE: 'FEATURE',
  GENERAL: 'GENERAL',
  CSAT: 'CSAT',
  ORGANIZER_CSAT: 'ORGANIZER_CSAT',
} as const;
export type FeedbackKind = (typeof FeedbackKind)[keyof typeof FeedbackKind];

/** Triage lifecycle of a {@link FeedbackKind} submission. */
export const FeedbackStatus = {
  OPEN: 'OPEN',
  TRIAGED: 'TRIAGED',
  CLOSED: 'CLOSED',
} as const;
export type FeedbackStatus = (typeof FeedbackStatus)[keyof typeof FeedbackStatus];
