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

export const SessionStatus = {
  SCHEDULED: 'SCHEDULED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

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

export const NotificationType = {
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  EVENT_REMINDER: 'EVENT_REMINDER',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  REFUND_COMPLETED: 'REFUND_COMPLETED',
  TICKET_CHECKED_IN: 'TICKET_CHECKED_IN',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const CheckInResult = {
  SUCCESS: 'SUCCESS',
  DUPLICATE: 'DUPLICATE',
  INVALID: 'INVALID',
  CANCELLED: 'CANCELLED',
  WRONG_SESSION: 'WRONG_SESSION',
} as const;
export type CheckInResult = (typeof CheckInResult)[keyof typeof CheckInResult];
