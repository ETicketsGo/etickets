/** Shared API contract types (transport-level shapes). */

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  organizationId?: string | null;
}

/** The current user as returned by GET /auth/me and login. Canonical alias. */
export type AuthUser = AuthenticatedUser;

/** Response of POST /auth/login (and register): token pair, optionally the user. */
export interface AuthResponse extends AuthTokens {
  user?: AuthenticatedUser;
}

/** Response of POST /auth/refresh — a rotated token pair. */
export type RefreshResponse = AuthTokens;

/** Body for registering a push subscription (browser Web Push or a device token). */
export interface PushRegistration {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

/** Non-secret device/session metadata a client may report on auth. */
export interface SessionDevice {
  userAgent?: string;
  platform?: 'ios' | 'android' | 'web';
  appVersion?: string;
}

export interface FeeBreakdown {
  currency: string;
  /** Sum of ticket face values, in minor units (paise). */
  subtotal: number;
  /** Platform booking fee, in minor units. */
  bookingFee: number;
  /** Payment processing fee, in minor units. */
  paymentFee: number;
  /** Portion of fees the customer pays, in minor units. */
  customerFeePortion: number;
  /** Portion of fees the organizer absorbs, in minor units. */
  organizerFeePortion: number;
  /** Amount the customer is charged, in minor units. */
  total: number;
}
