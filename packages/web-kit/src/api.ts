import type { ApiError, AuthTokens } from '@eticketsgo/shared-types';

export const API_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) ||
  'http://localhost:4000/api';

const ACCESS_KEY = 'etg_access';
const REFRESH_KEY = 'etg_refresh';

export const tokenStore = {
  get access() {
    return typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY);
  },
  set(tokens: AuthTokens) {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Human-friendly message from any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          tokenStore.clear();
          return false;
        }
        tokenStore.set((await res.json()) as AuthTokens);
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

interface Options extends RequestInit {
  auth?: boolean;
  _retried?: boolean;
}

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('content-type', 'application/json');
  if (options.auth !== false && tokenStore.access) {
    headers.set('authorization', `Bearer ${tokenStore.access}`);
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  // Attempt a single transparent refresh on auth failure.
  if (res.status === 401 && options.auth !== false && !options._retried && tokenStore.refresh) {
    if (await tryRefresh()) {
      return request<T>(path, { ...options, _retried: true });
    }
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data as ApiError;
    throw new ApiRequestError(
      err?.code ?? 'ERROR',
      err?.message ?? 'Request failed.',
      err?.details,
      err?.correlationId,
    );
  }
  return data as T;
}

function qs(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)] as [string, string]);
  const s = new URLSearchParams(entries).toString();
  return s ? `?${s}` : '';
}

// ─────────────────────────── API surface ───────────────────────────

export const api = {
  request,

  auth: {
    register: (body: { email: string; password: string; fullName: string }) =>
      request<AuthTokens>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }),
    login: (body: { email: string; password: string }) =>
      request<AuthTokens>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }),
    logout: (refreshToken: string) =>
      request<{ success: boolean }>('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        auth: false,
      }),
    me: () => request<AuthUser>('/auth/me'),
  },

  users: {
    profile: () => request<UserProfile>('/users/me'),
    updateProfile: (fullName: string) =>
      request<AuthUser>('/users/me', { method: 'PATCH', body: JSON.stringify({ fullName }) }),
    adminList: (params: PageParams & { q?: string }) =>
      request<Paged<AdminUser>>(`/users${qs(params)}`),
  },

  publicEvents: {
    list: (params: Record<string, string | number | undefined>) =>
      request<Paged<PublicEventCard>>(`/public/events${qs(params)}`, { auth: false }),
    get: (slug: string) => request<PublicEvent>(`/public/events/${slug}`, { auth: false }),
    organizer: (id: string) =>
      request<OrganizerProfile>(`/public/organizers/${id}`, { auth: false }),
  },

  reviews: {
    forEvent: (eventId: string) =>
      request<ReviewSummary>(`/public/reviews/${eventId}`, { auth: false }),
    mine: (eventId: string) => request<MyReview | null>(`/reviews/mine${qs({ eventId })}`),
    create: (body: { eventId: string; rating: number; comment?: string }) =>
      request<MyReview>('/reviews', { method: 'POST', body: JSON.stringify(body) }),
  },

  bookings: {
    create: (body: BookingRequest, idempotencyKey?: string) =>
      request<BookingResult>('/bookings', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
      }),
    list: () => request<Paged<BookingSummary>>('/bookings?pageSize=50'),
    get: (id: string) => request<BookingDetail>(`/bookings/${id}`),
    pay: (id: string) =>
      request<{ providerRef: string; clientActionUrl: string }>(`/bookings/${id}/pay`, {
        method: 'POST',
      }),
  },

  payments: {
    mockPay: (bookingId: string, outcome: 'succeeded' | 'failed') =>
      request<{ status: string; bookingId: string }>(`/payments/${bookingId}/mock-pay`, {
        method: 'POST',
        body: JSON.stringify({ outcome }),
        auth: false,
      }),
  },

  tickets: {
    wallet: () => request<WalletTicket[]>('/tickets'),
    get: (id: string) => request<WalletTicket>(`/tickets/${id}`),
  },

  organizations: {
    create: (body: { name: string; contactEmail?: string }) =>
      request<Organization>('/organizations', { method: 'POST', body: JSON.stringify(body) }),
    listMine: () => request<Organization[]>('/organizations'),
    get: (id: string) => request<Organization>(`/organizations/${id}`),
    members: (id: string) => request<OrgMember[]>(`/organizations/${id}/members`),
    invite: (id: string, body: { email: string; role: string }) =>
      request<OrgMember>(`/organizations/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  venues: {
    create: (body: {
      organizationId: string;
      name: string;
      city: string;
      country?: string;
      address?: string;
      capacity?: number;
    }) => request<Venue>('/venues', { method: 'POST', body: JSON.stringify(body) }),
    list: (organizationId: string) => request<Venue[]>(`/venues${qs({ organizationId })}`),
  },

  movies: {
    list: (organizationId: string) => request<Movie[]>(`/movies${qs({ organizationId })}`),
    get: (id: string) => request<Movie>(`/movies/${id}`),
    create: (body: MovieBody & { organizationId: string }) =>
      request<Movie>('/movies', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<MovieBody>) =>
      request<Movie>(`/movies/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    setStatus: (id: string, status: MovieStatusValue) =>
      request<Movie>(`/movies/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
  },

  cinemas: {
    list: (organizationId: string) => request<Cinema[]>(`/cinemas${qs({ organizationId })}`),
    get: (id: string) => request<Cinema>(`/cinemas/${id}`),
    create: (body: CinemaBody & { organizationId: string }) =>
      request<Cinema>('/cinemas', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<CinemaBody>) =>
      request<Cinema>(`/cinemas/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    screens: (cinemaId: string) => request<Screen[]>(`/cinemas/${cinemaId}/screens`),
    addScreen: (cinemaId: string, body: ScreenBody) =>
      request<Screen>(`/cinemas/${cinemaId}/screens`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateScreen: (screenId: string, body: Partial<ScreenBody>) =>
      request<Screen>(`/screens/${screenId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    removeScreen: (screenId: string) =>
      request<{ success: boolean }>(`/screens/${screenId}`, { method: 'DELETE' }),
  },

  publicMovies: {
    list: (params?: { city?: string; genre?: string; q?: string }) =>
      request<PublicMovieCard[]>(`/public/movies${qs(params ?? {})}`, { auth: false }),
    get: (slug: string) => request<PublicMovie>(`/public/movies/${slug}`, { auth: false }),
  },

  publicShows: {
    /** Seat layout + per-seat availability for one show (session). */
    seats: (sessionId: string) =>
      request<SeatLayout>(`/public/shows/${sessionId}/seats`, { auth: false }),
  },

  shows: {
    getSeatMap: (screenId: string) => request<SeatMap | null>(`/screens/${screenId}/seatmap`),
    generateSeatMap: (screenId: string, body: GenerateSeatMapBody) =>
      request<SeatMap>(`/screens/${screenId}/seatmap`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listForMovie: (movieId: string) => request<ShowRow[]>(`/movies/${movieId}/shows`),
    schedule: (movieId: string, body: ScheduleShowBody) =>
      request<{ eventId: string; sessionId: string }>(`/movies/${movieId}/shows`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  events: {
    list: (organizationId: string) => request<OrgEventRow[]>(`/events${qs({ organizationId })}`),
    get: (id: string) => request<OrgEventDetail>(`/events/${id}`),
    create: (body: CreateEventBody) =>
      request<OrgEventDetail>('/events', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<CreateEventBody>) =>
      request<OrgEventDetail>(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    addSession: (id: string, body: { startsAt: string; endsAt: string }) =>
      request<EventSession>(`/events/${id}/sessions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    addTicketType: (body: CreateTicketTypeBody) =>
      request<TicketType>('/events/ticket-types', { method: 'POST', body: JSON.stringify(body) }),
    submit: (id: string) => request<OrgEventDetail>(`/events/${id}/submit`, { method: 'POST' }),
    pause: (id: string) => request<OrgEventDetail>(`/events/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => request<OrgEventDetail>(`/events/${id}/resume`, { method: 'POST' }),
    orders: (id: string, params: PageParams & { status?: string; q?: string }) =>
      request<Paged<OrderRow>>(`/events/${id}/orders${qs(params)}`),
    attendees: (
      id: string,
      params: PageParams & { status?: string; q?: string; sessionId?: string },
    ) => request<Paged<AttendeeRow>>(`/events/${id}/attendees${qs(params)}`),
  },

  checkins: {
    scan: (body: { token: string; expectedSessionId?: string; deviceInfo?: string }) =>
      request<CheckInOutcome>('/checkins', { method: 'POST', body: JSON.stringify(body) }),
    reverse: (ticketId: string) =>
      request<{ result: string; ticketId: string }>('/checkins/reverse', {
        method: 'POST',
        body: JSON.stringify({ ticketId }),
      }),
  },

  refunds: {
    request: (body: { bookingId: string; reason: string; ticketIds?: string[] }) =>
      request<RefundRow>('/refunds', { method: 'POST', body: JSON.stringify(body) }),
    forBooking: (bookingId: string) => request<RefundRow[]>(`/refunds/booking/${bookingId}`),
    process: (id: string, decision: 'APPROVE' | 'REJECT') =>
      request<RefundRow>(`/refunds/${id}/process`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
  },

  payouts: {
    forOrg: (organizationId: string) => request<Payout[]>(`/payouts${qs({ organizationId })}`),
    generate: (organizationId: string, eventId?: string) =>
      request<Payout>('/payouts/generate', {
        method: 'POST',
        body: JSON.stringify({ organizationId, eventId }),
      }),
  },

  reports: {
    event: (eventId: string) => request<EventReport>(`/reports/events/${eventId}`),
  },

  admin: {
    dashboard: () => request<AdminDashboard>('/admin/dashboard'),
    movies: (params?: PageParams & { status?: string; q?: string }) =>
      request<Paged<AdminMovieRow>>(`/admin/movies${qs(params ?? {})}`),
    audit: (params: PageParams & { action?: string }) =>
      request<Paged<AuditRow>>(`/admin/audit${qs(params)}`),
    organizers: (params: PageParams & { status?: string }) =>
      request<Paged<Organization>>(`/admin/organizers${qs(params)}`),
    reviewOrganizer: (id: string, decision: 'APPROVE' | 'REJECT', note?: string) =>
      request<Organization>(`/admin/organizers/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, note }),
      }),
    events: (params: PageParams & { status?: string }) =>
      request<Paged<AdminEventRow>>(`/admin/events${qs(params)}`),
    reviewEvent: (id: string, decision: 'APPROVE' | 'REJECT', note?: string) =>
      request<OrgEventDetail>(`/admin/events/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, note }),
      }),
    setEventStatus: (id: string, status: string) =>
      request<OrgEventDetail>(`/admin/events/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    bookings: (params: PageParams & { status?: string; q?: string }) =>
      request<Paged<AdminBookingRow>>(`/admin/bookings${qs(params)}`),
    payments: (params: PageParams & { status?: string }) =>
      request<Paged<AdminPaymentRow>>(`/admin/payments${qs(params)}`),
    refunds: (params: PageParams & { status?: string }) =>
      request<Paged<RefundRow>>(`/admin/refunds${qs(params)}`),
    payouts: () => request<Payout[]>('/admin/payouts'),
    markPayoutPaid: (id: string) => request<Payout>(`/admin/payouts/${id}/pay`, { method: 'POST' }),
    feeRules: () => request<FeeRule[]>('/admin/fee-rules'),
  },
};

// ─────────────────────────── Types ───────────────────────────

export type PageParams = {
  page?: number;
  pageSize?: number;
};
export interface Paged<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
}
export interface UserProfile extends AuthUser {
  status: string;
  createdAt: string;
  memberships: { organizationId: string; role: string; status: string }[];
}
export interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  status: string;
  createdAt: string;
}

export interface PublicEventCard {
  id: string;
  title: string;
  slug: string;
  category: string;
  venue: { name: string; city: string; country: string };
  organizer: string;
  nextSessionAt: string | null;
  fromPriceMinor: number | null;
  currency: string;
}
export interface PublicEvent {
  id: string;
  title: string;
  slug: string;
  category: string;
  description: string | null;
  refundPolicy: string | null;
  feeMode: string;
  venue: { name: string; city: string; country: string; address: string | null };
  organizer: { id: string; name: string };
  sessions: {
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    ticketTypes: {
      id: string;
      name: string;
      priceMinor: number;
      currency: string;
      maxPerOrder: number;
      available: number;
    }[];
  }[];
}

export interface BookingRequest {
  eventSessionId: string;
  items: { ticketTypeId: string; quantity: number; seatIds?: string[] }[];
  buyerName: string;
  buyerEmail: string;
  couponCode?: string;
}
export interface BookingResult {
  id: string;
  status: string;
  currency: string;
  holdExpiresAt: string;
  fees: {
    subtotalMinor: number;
    bookingFeeMinor: number;
    paymentFeeMinor: number;
    customerFeeMinor: number;
    totalMinor: number;
    discountMinor: number;
  };
  payment: { id: string; status: string };
}
export interface BookingDetail {
  id: string;
  status: string;
  holdExpiresAt: string;
  totalMinor: number;
  subtotalMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  discountMinor: number;
  currency: string;
  buyerName: string;
  buyerEmail: string;
  event: { title: string; slug: string };
  eventSession: { startsAt: string };
  items: { quantity: number; unitPriceMinor: number; ticketType: { name: string } }[];
  tickets: { id: string; status: string }[];
  payment: { status: string } | null;
}
export interface BookingSummary {
  id: string;
  status: string;
  event: { title: string; slug: string };
  eventSession: { startsAt: string };
  _count: { tickets: number };
}
export interface WalletTicket {
  id: string;
  serial: string;
  status: string;
  holderName: string | null;
  ticketType: string;
  event: { title: string; slug: string };
  startsAt: string;
  qrDataUrl: string;
  qrToken?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  contactEmail: string | null;
  createdAt: string;
  _count?: { members: number; events: number; venues?: number };
}
export interface OrgMember {
  id: string;
  role: string;
  status: string;
  user: { id: string; email: string; fullName: string };
}
export interface Venue {
  id: string;
  name: string;
  city: string;
  country: string;
  address: string | null;
  capacity: number | null;
  areas?: { id: string; name: string }[];
}

export type MovieStatusValue = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface MovieBody {
  title: string;
  synopsis?: string;
  runtimeMinutes: number;
  certificate?: string;
  language: string;
  genres: string[];
  releaseDate?: string;
  posterUrl?: string;
  trailerUrl?: string;
  cast: string[];
  director?: string;
}

export interface Movie extends MovieBody {
  id: string;
  slug: string;
  status: MovieStatusValue;
  createdAt: string;
}

export interface ScreenBody {
  name: string;
  screenType: string;
  capacity: number;
}

export interface Screen extends ScreenBody {
  id: string;
  cinemaId: string;
}

export interface CinemaBody {
  name: string;
  brand?: string;
  city: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  venueId?: string;
}

export interface Cinema extends CinemaBody {
  id: string;
  status: string;
  screens?: Screen[];
}

export interface AdminMovieRow {
  id: string;
  title: string;
  slug: string;
  language: string;
  certificate: string | null;
  status: MovieStatusValue;
  organizationName: string;
  createdAt: string;
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD';

export interface SeatLayoutSeat {
  id: string;
  label: string;
  colIndex: number;
  categoryId: string;
  status: SeatStatus;
}

export interface SeatLayout {
  sessionId: string;
  /** `id` is the seat category id; `ticketTypeId` is the session's price tier for it. */
  categories: {
    id: string;
    ticketTypeId: string;
    name: string;
    colorHex: string | null;
    priceMinor: number;
  }[];
  sections: {
    name: string;
    rows: { label: string; seats: SeatLayoutSeat[] }[];
  }[];
}

export interface SeatMap {
  id: string;
  screenId: string;
  name: string | null;
  categories: { id: string; name: string; colorHex: string | null; basePriceMinor: number }[];
  sections: {
    id: string;
    name: string;
    rows: { id: string; label: string; seats: { id: string; label: string; colIndex: number; seatCategoryId: string }[] }[];
  }[];
}

export interface GenerateSeatMapBody {
  name?: string;
  sections: {
    name: string;
    categoryName: string;
    colorHex?: string;
    basePriceMinor: number;
    rowLabels: string[];
    seatsPerRow: number;
  }[];
}

export interface ScheduleShowBody {
  screenId: string;
  startsAt: string;
  endsAt: string;
  pricing?: { seatCategoryId: string; priceMinor: number }[];
}

export interface ShowRow {
  sessionId: string;
  startsAt: string;
  endsAt: string;
  screenName: string | null;
  cinemaName: string | null;
  seatsSold: number;
  seatsTotal: number;
}

export interface PublicMovieCard {
  id: string;
  title: string;
  slug: string;
  posterUrl: string | null;
  certificate: string | null;
  language: string;
  genres: string[];
  runtimeMinutes: number;
}

export interface PublicMovie extends PublicMovieCard {
  synopsis: string | null;
  trailerUrl: string | null;
  cast: string[];
  director: string | null;
  releaseDate: string | null;
  /** Bookable show listings for this film (movie experiences). */
  shows: {
    eventId: string;
    slug: string;
    cinemaName: string | null;
    sessions: { id: string; startsAt: string; screenName: string | null }[];
  }[];
}

export interface OrgEventRow {
  id: string;
  title: string;
  slug: string;
  category: string;
  status: string;
  createdAt: string;
  venue: { name: string; city: string };
  _count: { sessions: number; bookings: number };
}
export interface EventSession {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  ticketTypes?: TicketType[];
}
export interface TicketType {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  quantityTotal: number;
  maxPerOrder: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  status: string;
  inventory?: { quantityTotal: number; quantitySold: number; quantityHeld: number } | null;
}
export interface OrgEventDetail {
  id: string;
  title: string;
  slug: string;
  category: string;
  description: string | null;
  status: string;
  feeMode: string;
  refundPolicy: string | null;
  publishedAt: string | null;
  reviewNote: string | null;
  venue: Venue;
  organizationId: string;
  sessions: EventSession[];
}
export interface CreateEventBody {
  organizationId: string;
  venueId: string;
  title: string;
  category: string;
  description?: string;
  refundPolicy?: string;
  feeMode: string;
}
export interface CreateTicketTypeBody {
  eventSessionId: string;
  name: string;
  priceMinor: number;
  currency?: string;
  quantityTotal: number;
  maxPerOrder?: number;
  salesStartAt?: string;
  salesEndAt?: string;
}

export interface OrderRow {
  id: string;
  status: string;
  buyerName: string;
  buyerEmail: string;
  totalMinor: number;
  createdAt: string;
  ticketCount: number;
  paymentStatus: string | null;
}
export interface AttendeeRow {
  id: string;
  serial: string;
  status: string;
  holderName: string | null;
  holderEmail: string | null;
  ticketType: string;
  sessionStartsAt: string;
  checkedInAt: string | null;
}

export interface CheckInOutcome {
  result: 'SUCCESS' | 'DUPLICATE' | 'INVALID' | 'CANCELLED' | 'WRONG_SESSION';
  message: string;
  ticket?: {
    id: string;
    serial: string;
    holderName: string | null;
    ticketType: string;
    status: string;
  };
}

export interface RefundRow {
  id: string;
  bookingId: string;
  amountMinor: number;
  status: string;
  reason: string;
  ticketIds: string[];
  createdAt: string;
  booking?: { buyerEmail: string; eventId: string };
}

export interface Payout {
  id: string;
  organizationId: string;
  eventId: string | null;
  grossMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  refundMinor: number;
  netMinor: number;
  currency: string;
  status: string;
  scheduledAt: string | null;
  paidAt: string | null;
  createdAt: string;
  organization?: { name: string };
}

export interface EventReport {
  event: { id: string; title: string; status: string };
  grossTicketSalesMinor: number;
  bookingFeesMinor: number;
  paymentFeesMinor: number;
  refundsMinor: number;
  netOrganizerRevenueMinor: number;
  ticketsSold: number;
  ticketsRemaining: number;
  checkInCount: number;
  salesByTicketType: { ticketType: string; quantity: number; grossMinor: number }[];
  salesByDay: { day: string; bookings: number; grossMinor: number }[];
}

export interface AdminDashboard {
  gmvMinor: number;
  platformRevenueMinor: number;
  totalBookings: number;
  refundVolumeMinor: number;
  activeOrganizers: number;
  publishedEvents: number;
  paymentFailures: number;
  upcomingPayouts: number;
  confirmedBookings: number;
  pendingOrganizers?: number;
  pendingEvents?: number;
}
export interface AdminEventRow {
  id: string;
  title: string;
  status: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  organization: { name: string };
  venue: { name: string; city: string };
}
export interface AdminBookingRow {
  id: string;
  status: string;
  buyerEmail: string;
  totalMinor: number;
  createdAt: string;
  event: { title: string };
  paymentStatus: string | null;
}
export interface AdminPaymentRow {
  id: string;
  status: string;
  amountMinor: number;
  provider: string;
  providerRef: string | null;
  createdAt: string;
  bookingId: string;
  buyerEmail: string;
}
export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  correlationId: string | null;
  createdAt: string;
  actor: { email: string; fullName: string } | null;
}
export interface FeeRule {
  id: string;
  label: string;
  minMinor: number;
  maxMinor: number | null;
  feeMinor: number;
  currency: string;
  active: boolean;
}

export interface ReviewItem {
  id: string;
  rating: number;
  comment: string | null;
  author: string;
  createdAt: string;
}
export interface ReviewSummary {
  average: number;
  count: number;
  distribution: Record<string, number>;
  items: ReviewItem[];
}
export interface MyReview {
  id: string;
  rating: number;
  comment: string | null;
}

export interface OrganizerProfile {
  id: string;
  name: string;
  verified: boolean;
  memberSince: string;
  eventCount: number;
  events: PublicEventCard[];
}
