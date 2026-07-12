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
