import type {
  ApiError,
  AuthTokens,
  ManifestEntry,
  ManifestMeta,
  QueuedCheckIn,
  ReconcileOutcome,
  RevocationDelta,
} from '@eticketsgo/shared-types';

export type { QueuedCheckIn, RevocationDelta } from '@eticketsgo/shared-types';

import { markApiReachable, markApiUnreachable } from './connectivity';

export const API_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) ||
  'http://localhost:4000/api';

const ACCESS_KEY = 'etg_access';
const REFRESH_KEY = 'etg_refresh';

/**
 * Listeners notified whenever the stored session changes.
 *
 * localStorage gives no in-tab change signal: the `storage` event fires only in OTHER tabs.
 * Without this, a component that read the token once on mount never learns about a later
 * sign-in — which is exactly how the customer header kept showing "Sign in / Sign up" after
 * a successful login. Next.js keeps the layout mounted across client-side navigation, so
 * the header never remounted and never re-read the token.
 */
const tokenListeners = new Set<() => void>();
const notifyTokenChange = (): void => {
  for (const listener of tokenListeners) listener();
};

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
    notifyTokenChange();
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    notifyTokenChange();
  },
  /**
   * Subscribe to session changes. Covers both directions:
   *  - this tab, via the explicit notify in set()/clear()
   *  - other tabs, via the `storage` event, so signing out on one tab updates the rest
   * Returns an unsubscribe function, shaped for React's useSyncExternalStore.
   */
  subscribe(listener: () => void): () => void {
    tokenListeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      // key === null means the whole store was cleared.
      if (event.key === null || event.key === ACCESS_KEY || event.key === REFRESH_KEY) listener();
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      tokenListeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  },
};

/** Snapshot for useSyncExternalStore — a stable primitive, so React can compare it cheaply. */
export function getAuthSnapshot(): boolean {
  return typeof window !== 'undefined' && !!localStorage.getItem(ACCESS_KEY);
}

/** Server render has no localStorage; always start signed-out and let hydration correct it. */
export function getServerAuthSnapshot(): boolean {
  return false;
}

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly correlationId?: string,
    /** HTTP status of the failed response (used e.g. for retry classification). */
    readonly status?: number,
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

  // Reachability signal (ADR-034): a network-level fetch failure means our API origin is
  // unreachable; any HTTP response — including 4xx/5xx — means it IS reachable (an application
  // error is not a connectivity problem). This drives the offline indicator independently of the
  // sometimes-stale `navigator.onLine`.
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch (err) {
    markApiUnreachable();
    throw err;
  }
  markApiReachable();

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
      res.status,
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

/** Fetch a CSV export (authed) and trigger a browser download. */
async function downloadCsv(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: tokenStore.access ? { authorization: `Bearer ${tokenStore.access}` } : {},
  });
  if (!res.ok) throw new ApiRequestError('CSV_EXPORT_FAILED', 'Could not export CSV.');
  const blob = await res.blob();
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─────────────────────────── API surface ───────────────────────────

/**
 * Unified experience discovery. Callable for the legacy combined payload
 * (`api.discovery()`), with `.sections(city?)` for the composed strategy feed.
 */
const discovery = Object.assign(() => request<Discovery>('/public/discovery', { auth: false }), {
  sections: (city?: string) =>
    request<{ sections: DiscoverySection[] }>(`/public/discovery/sections${qs({ city })}`, {
      auth: false,
    }).then((r) => r.sections),
  /**
   * The same feed, keeping what the filter actually did.
   *
   * `sections()` above throws that away, and a caller who only has the array cannot tell a
   * quiet city from a quiet platform. New callers should use this one.
   */
  sectionFeed: (city?: string) =>
    request<SectionFeed>(`/public/discovery/sections${qs({ city })}`, { auth: false }),
});

export const api = {
  request,

  /** Where the caller is, and where we can sell them something. Both are public. */
  location: {
    cities: () => request<SellableCity[]>('/public/location/cities', { auth: false }),
    resolve: (hint?: { latitude?: number; longitude?: number; region?: string }) =>
      request<ResolvedLocation>(
        `/public/location/resolve${qs({
          lat: hint?.latitude,
          lng: hint?.longitude,
          region: hint?.region,
        })}`,
        { auth: false },
      ),
  },

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
    /**
     * Exchange the refresh token for a new pair, explicitly.
     *
     * `request` already refreshes on a 401, but that only helps once the access token is
     * REJECTED. A role granted mid-session — creating an organization promotes a customer to
     * ORGANIZER_OWNER — is not a 401: the old token is still valid, it just describes a
     * person who no longer exists. Without this, the new organizer keeps being told they
     * cannot access the organizer console until their token happens to expire.
     *
     * The server re-reads roles from the database when it rotates, so the new pair carries
     * the new role.
     */
    refresh: (refreshToken: string) =>
      request<AuthTokens>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        auth: false,
      }),
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

  /** Unified experience discovery (movies + events + categories) + sections feed. */
  discovery,

  /**
   * Recommended "you might also like" events. With `eventId` the result is the
   * blended similar/organizer/venue mix relative to that event; pass `strategy`
   * to run a single named strategy (e.g. 'trending', 'content-based', 'ai').
   */
  recommendations: (params?: { eventId?: string; limit?: number; strategy?: string }) =>
    request<{ items: PublicEventCard[] }>(`/public/recommendations${qs(params ?? {})}`, {
      auth: false,
    }).then((r) => r.items),

  /** Published-event categories with counts (for a richer category experience). */
  publicCategories: () =>
    request<{ category: string; count: number }[]>('/public/categories', { auth: false }),

  /** Resolved platform feature flags (drives capability-gated UI). */
  capabilities: () => request<Record<string, boolean>>('/capabilities', { auth: false }),

  reviews: {
    forEvent: (eventId: string) =>
      request<ReviewSummary>(`/public/reviews/${eventId}`, { auth: false }),
    mine: (eventId: string) => request<MyReview | null>(`/reviews/mine${qs({ eventId })}`),
    create: (body: { eventId: string; rating: number; comment?: string }) =>
      request<MyReview>('/reviews', { method: 'POST', body: JSON.stringify(body) }),
  },

  support: {
    /**
     * Submit a support/feedback item. Public — logged-out visitors can contact
     * or report. The bearer token is sent when present so the API can attach the
     * signed-in user; `auth` is left default so refresh-on-401 still applies.
     */
    submit: (body: FeedbackSubmission) =>
      request<{ id: string; status: FeedbackStatusValue }>('/support', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
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
    pay: (id: string) => request<PayResult>(`/bookings/${id}/pay`, { method: 'POST' }),
  },

  payments: {
    mockPay: (bookingId: string, outcome: 'succeeded' | 'failed') =>
      request<{ status: string; bookingId: string }>(`/payments/${bookingId}/mock-pay`, {
        method: 'POST',
        body: JSON.stringify({ outcome }),
        auth: false,
      }),
    // India (Razorpay): verify the Checkout signature after the modal returns. Never proof
    // of payment (the webhook confirms) — surfaces a 'processing'/'confirmed' status.
    razorpayVerify: (
      bookingId: string,
      body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
    ) =>
      request<{ status: 'processing' | 'confirmed'; bookingId: string }>(
        `/bookings/${bookingId}/payments/razorpay/verify`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
  },

  tickets: {
    wallet: () => request<WalletTicket[]>('/tickets'),
    get: (id: string) => request<WalletTicket>(`/tickets/${id}`),
  },

  // Wallet-pass sandbox (Apple/Google) — projections of an existing valid ticket.
  walletPasses: {
    providers: () => request<{ providers: WalletProviderStatusRow[] }>('/wallet/providers'),
    generate: (ticketId: string, provider: 'apple' | 'google') =>
      request<WalletPassResponse>('/wallet/passes', {
        method: 'POST',
        body: JSON.stringify({ ticketId, provider }),
      }),
  },

  // Attendee identity layer (ADR-031): assign / invite / transfer / claim.
  attendees: {
    assign: (ticketId: string, body: AssignAttendeeBody) =>
      request<AttendeeTicket>(`/tickets/${ticketId}/attendee`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    invite: (ticketId: string, body: InviteAttendeeBody) =>
      request<InviteResult>(`/tickets/${ticketId}/invite`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    transfer: (ticketId: string, body: InviteAttendeeBody) =>
      request<InviteResult>(`/tickets/${ticketId}/transfer`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    unassign: (ticketId: string) =>
      request<AttendeeTicket>(`/tickets/${ticketId}/unassign`, { method: 'POST' }),
    summary: (bookingId: string) => request<AttendeeSummary>(`/bookings/${bookingId}/attendees`),
    accept: (token: string) =>
      request<AttendeeTicket>(`/attendee-invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      }),
    decline: (token: string) =>
      request<{ ticketId: string; status: string }>(
        `/attendee-invites/${encodeURIComponent(token)}/decline`,
        { method: 'POST' },
      ),
    resend: (inviteId: string) =>
      request<{ id: string; email: string; token: string }>(
        `/attendee-invites/${inviteId}/resend`,
        { method: 'POST' },
      ),
  },

  // Secure Experience Sharing (ADR-032). Generic over resource types.
  sharing: {
    create: (ticketId: string, body: CreateShareBody) =>
      request<ShareCreated>(`/tickets/${ticketId}/share`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    activity: (ticketId: string) => request<ShareActivity>(`/tickets/${ticketId}/shares`),
    revoke: (shareId: string) =>
      request<{ id: string; status: string }>(`/shares/${shareId}/revoke`, { method: 'POST' }),
    extend: (shareId: string, expiry: ShareExpiryValue) =>
      request<{ id: string; expiresAt: string }>(`/shares/${shareId}/extend`, {
        method: 'POST',
        body: JSON.stringify({ expiry }),
      }),
    permission: (shareId: string, permission: SharePermissionValue) =>
      request<{ id: string; permission: string }>(`/shares/${shareId}/permission`, {
        method: 'POST',
        body: JSON.stringify({ permission }),
      }),
    // Public — resolve a share link (no auth required).
    resolve: (token: string) =>
      request<ResolvedShare>(`/public/share/${encodeURIComponent(token)}`, {
        method: 'POST',
        auth: false,
      }),
  },

  organizations: {
    create: (body: { name: string; contactEmail?: string }) =>
      request<Organization>('/organizations', { method: 'POST', body: JSON.stringify(body) }),
    listMine: () => request<Organization[]>('/organizations'),
    get: (id: string) => request<Organization>(`/organizations/${id}`),
    updateProfile: (id: string, body: OrganizationProfileInput) =>
      request<Organization>(`/organizations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    legalIdentity: (id: string) =>
      request<OrganizationLegalIdentity>(`/organizations/${id}/legal-identity`),
    updateLegalIdentity: (id: string, body: OrganizationLegalIdentityInput) =>
      request<Organization>(`/organizations/${id}/legal-identity`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    receipts: (id: string, params: PageParams & { from?: string; to?: string } = {}) =>
      request<ReceiptListPage>(`/organizations/${id}/receipts${qs(params)}`),
    refunds: (id: string, params: PageParams & { status?: string } = {}) =>
      request<Paged<OrganizationRefundRow>>(`/organizations/${id}/refunds${qs(params)}`),
    members: (id: string) => request<OrgMember[]>(`/organizations/${id}/members`),
    invite: (id: string, body: { email: string; role: string }) =>
      request<OrgMember>(`/organizations/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  // Browser Web Push (v1.4): VAPID key + subscription register/unregister.
  push: {
    vapidKey: () => request<{ publicKey: string | null }>('/push/vapid-public-key'),
    subscribe: (body: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      userAgent?: string;
    }) =>
      request<{ subscribed: boolean }>('/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    unsubscribe: (endpoint: string) =>
      request<{ removed: number }>('/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint }),
      }),
  },

  notifications: {
    /**
     * `audience` picks the stream: the organizer console asks for ORGANIZER, the customer
     * site for CUSTOMER. One person can hold both roles, and their payout notices and their
     * own ticket purchases belong on different screens. Omitted returns everything.
     */
    inbox: (
      params: {
        limit?: number;
        before?: string;
        audience?: 'CUSTOMER' | 'ORGANIZER' | 'ADMIN';
      } = {},
    ) => request<NotificationInbox>(`/notifications${qs(params)}`),
    unreadCount: () => request<{ unreadCount: number }>('/notifications/unread-count'),
    markRead: (id: string) =>
      request<{ updated: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),
    markAllRead: () => request<{ updated: number }>('/notifications/read-all', { method: 'POST' }),
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
    /**
     * Whether this cinema can open, and precisely what is stopping it.
     *
     * The server decides. The client renders the verdict and never re-derives a rule — a
     * second implementation here is how a page ends up saying READY while the API refuses.
     */
    pilotReadiness: (id: string) => request<PilotReadinessReport>(`/cinemas/${id}/pilot-readiness`),
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
    /**
     * The seat layout for one show.
     *
     * A cinema comes back whole. A sectioned venue comes back as an overview until a
     * `section` is named, at which point that one block's seats arrive. Check `view` before
     * reading `rows` — the type will not let you do otherwise.
     */
    seats: (sessionId: string, section?: string) =>
      request<SeatLayoutResponse>(`/public/shows/${sessionId}/seats${qs({ section })}`, {
        auth: false,
      }),
  },

  shows: {
    getSeatMap: (screenId: string) => request<SeatMap | null>(`/screens/${screenId}/seatmap`),
    generateSeatMap: (screenId: string, body: GenerateSeatMapBody) =>
      request<SeatMap>(`/screens/${screenId}/seatmap`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listForMovie: (movieId: string) => request<ShowRow[]>(`/movies/${movieId}/shows`),
    /** A cinema's schedule for one LOCAL day — the organizer's landing view. */
    cinemaSchedule: (cinemaId: string, date: string, timezone: string) =>
      request<ShowRow[]>(`/cinemas/${cinemaId}/schedule${qs({ date, timezone })}`),
    /**
     * An inclusive LOCAL date range, for week planning. Bounded server-side at 14 days.
     *
     * One request rather than seven: a week is a single question, and seven round trips
     * would render the view in seven jerks.
     */
    cinemaScheduleRange: (cinemaId: string, from: string, to: string, timezone: string) =>
      request<ShowRow[]>(`/cinemas/${cinemaId}/schedule${qs({ from, to, timezone })}`),
    /**
     * Preview or create many shows. `dryRun` defaults to true SERVER-side; the client
     * always sends it explicitly so a preview can never be mistaken for a publish.
     */
    bulkSchedule: (movieId: string, body: BulkScheduleBody) =>
      request<BulkScheduleResult>(`/movies/${movieId}/shows/bulk`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    copySchedule: (movieId: string, body: CopyScheduleBody) =>
      request<CopyScheduleResult>(`/movies/${movieId}/shows/copy`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** What one show charges per seat category, and which categories are frozen by a sale. */
    pricing: (sessionId: string) => request<ShowPricing>(`/shows/${sessionId}/pricing`),
    /**
     * Reprice a future show. Every category goes in one request because the server applies
     * them in one transaction — sending them one at a time is how a screen ends up half at
     * the old price.
     */
    updatePricing: (sessionId: string, prices: { ticketTypeId: string; priceMinor: number }[]) =>
      request<ShowPricing>(`/shows/${sessionId}/pricing`, {
        method: 'PATCH',
        body: JSON.stringify({ prices }),
      }),
    pause: (sessionId: string, reason?: string) =>
      request<ShowSalesResult>(`/shows/${sessionId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    reopen: (sessionId: string, reason?: string) =>
      request<ShowSalesResult>(`/shows/${sessionId}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    cancel: (sessionId: string, reason: string) =>
      request<CancelShowResult>(`/shows/${sessionId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    reschedule: (sessionId: string, startsAt: string, padMinutes = 20) =>
      request<{ sessionId: string; startsAt: string; endsAt: string }>(
        `/shows/${sessionId}/reschedule`,
        { method: 'POST', body: JSON.stringify({ startsAt, padMinutes }) },
      ),
    schedule: (movieId: string, body: ScheduleShowBody) =>
      request<{ eventId: string; sessionId: string }>(`/movies/${movieId}/shows`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  /**
   * Theater operations — live shows, seat overrides and layout versions.
   *
   * Separate from `shows` because these are the things a duty manager does to a room and to
   * tonight's performance, which is a different job from planning next week.
   */
  theaterOps: {
    occupancy: (sessionId: string) => request<OccupancySnapshot>(`/shows/${sessionId}/occupancy`),
    cinemaOccupancy: (cinemaId: string, from: string, to: string) =>
      request<OccupancySnapshot[]>(`/cinemas/${cinemaId}/occupancy${qs({ from, to })}`),
    liveSeatMap: (sessionId: string) => request<LiveSeatMap>(`/shows/${sessionId}/live-seat-map`),

    blockSeats: (sessionId: string, body: BlockSeatsBody) =>
      request<SeatOverrideResult>(`/shows/${sessionId}/seats/block`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    releaseSeats: (sessionId: string, body: ReleaseSeatsBody) =>
      request<SeatOverrideResult>(`/shows/${sessionId}/seats/release`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    companions: (sessionId: string, seatId: string) =>
      request<{ candidates: { seatId: string; label: string }[] }>(
        `/shows/${sessionId}/seats/${seatId}/companions`,
      ),

    overrideReport: (cinemaId: string, from: string, to: string) =>
      request<SeatOverrideReport>(`/cinemas/${cinemaId}/reports/seat-overrides${qs({ from, to })}`),

    layouts: (screenId: string) =>
      request<SeatLayoutSummary[]>(`/screens/${screenId}/seat-layouts`),
    cloneLayout: (layoutId: string, name?: string) =>
      request<{ id: string; version: number; status: string }>(`/seat-layouts/${layoutId}/clone`, {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      }),
    updateDraft: (layoutId: string, body: UpdateSeatLayoutBody) =>
      request<{ id: string; status: string }>(`/seat-layouts/${layoutId}/draft`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /**
     * Fill a draft from a venue template.
     *
     * Replaces everything in the draft — the whole point is to start from a shape rather
     * than build one, so a half-applied template would be worse than none.
     */
    applyVenueTemplate: (
      layoutId: string,
      body: {
        template: VenueTemplateKey;
        rows?: number;
        seatsPerRow?: number;
        basePriceMinor: number;
      },
    ) =>
      request<{
        id: string;
        status: string;
        layoutKind: 'GRID' | 'SECTIONED';
        sections: number;
        seats: number;
      }>(`/seat-layouts/${layoutId}/from-template`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    publishLayout: (layoutId: string, effectiveFrom?: string) =>
      request<SeatLayoutSummary>(`/seat-layouts/${layoutId}/publish`, {
        method: 'POST',
        body: JSON.stringify(effectiveFrom ? { effectiveFrom } : {}),
      }),
    archiveLayout: (layoutId: string) =>
      request<{ id: string; status: string }>(`/seat-layouts/${layoutId}/archive`, {
        method: 'POST',
      }),
    deleteDraft: (layoutId: string) =>
      request<{ id: string; deleted: boolean }>(`/seat-layouts/${layoutId}`, { method: 'DELETE' }),
    compareLayouts: (from: string, to: string) =>
      request<LayoutComparison>(`/seat-layouts/compare${qs({ from, to })}`),
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
    updateTicketType: (id: string, body: UpdateTicketTypeBody) =>
      request<TicketType>(`/events/ticket-types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteTicketType: (id: string) =>
      request<{ ok: boolean }>(`/events/ticket-types/${id}`, { method: 'DELETE' }),
    submit: (id: string) => request<OrgEventDetail>(`/events/${id}/submit`, { method: 'POST' }),
    duplicate: (id: string) => request<OrgEventRow>(`/events/${id}/duplicate`, { method: 'POST' }),
    promotion: (id: string) => request<EventPromotion>(`/events/${id}/promotion`),
    pause: (id: string) => request<OrgEventDetail>(`/events/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => request<OrgEventDetail>(`/events/${id}/resume`, { method: 'POST' }),
    orders: (id: string, params: PageParams & { status?: string; q?: string }) =>
      request<Paged<OrderRow>>(`/events/${id}/orders${qs(params)}`),
    attendees: (
      id: string,
      params: PageParams & { status?: string; q?: string; sessionId?: string },
    ) => request<Paged<AttendeeRow>>(`/events/${id}/attendees${qs(params)}`),
  },

  coupons: {
    list: (organizationId: string, params?: PageParams) =>
      request<Paged<Coupon>>(`/coupons${qs({ organizationId, ...(params ?? {}) })}`),
    create: (body: CreateCouponBody) =>
      request<Coupon>('/coupons', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: UpdateCouponBody) =>
      request<Coupon>(`/coupons/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/coupons/${id}`, { method: 'DELETE' }),
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

  // Offline gate check-in (ADR-035) — endpoints 404 while the feature flag is off.
  offlineCheckin: {
    listDevices: (organizationId: string, eventId?: string) =>
      request<CheckInDeviceRow[]>(`/checkin/devices${qs({ organizationId, eventId })}`),
    registerDevice: (body: {
      organizationId: string;
      eventId?: string;
      eventSessionId?: string;
      name: string;
      platform?: string;
    }) =>
      request<CheckInDeviceRow>('/checkin/devices', { method: 'POST', body: JSON.stringify(body) }),
    approveDevice: (id: string) =>
      request<CheckInDeviceRow>(`/checkin/devices/${id}/approve`, { method: 'POST' }),
    suspendDevice: (id: string, reason?: string) =>
      request<CheckInDeviceRow>(`/checkin/devices/${id}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    revokeDevice: (id: string, reason?: string) =>
      request<CheckInDeviceRow>(`/checkin/devices/${id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    reportLostDevice: (id: string, reason: string) =>
      request<CheckInDeviceRow>(`/checkin/devices/${id}/report-lost`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    manifest: (eventSessionId: string) =>
      request<SignedManifest>(`/checkin/manifest${qs({ eventSessionId })}`),
    deltas: (eventSessionId: string, sinceMs: number) =>
      request<RevocationDelta>(`/checkin/deltas${qs({ eventSessionId, sinceMs })}`),
    reconcile: (deviceId: string, checkIns: QueuedCheckIn[]) =>
      request<ReconcileResultItem[]>('/checkin/reconcile', {
        method: 'POST',
        body: JSON.stringify({ deviceId, checkIns }),
      }),
    offlineReadiness: (organizationId: string, eventSessionId?: string) =>
      request<OfflineReadinessReport>(
        `/checkin/offline-readiness${qs({ organizationId, eventSessionId })}`,
      ),
    activation: (organizationId: string, eventSessionId?: string) =>
      request<OfflineReadinessReport>(
        `/checkin/activation${qs({ organizationId, eventSessionId })}`,
      ),
    recordDrill: (body: RecordDrillInput) =>
      request<OfflineDrillRunRow>('/checkin/drills', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listDrills: (organizationId: string) =>
      request<OfflineDrillRunRow[]>(`/checkin/drills${qs({ organizationId })}`),
    recordActivation: (body: RecordActivationInput) =>
      request<OfflineActivationRow>('/checkin/activation/record', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revokeActivation: (id: string, reason: string) =>
      request<OfflineActivationRow>(`/checkin/activation/${id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    listActivations: (organizationId: string) =>
      request<OfflineActivationRow[]>(`/checkin/activation/decisions${qs({ organizationId })}`),
    reconciliation: (filters: ReconciliationQuery) =>
      request<Paged<ReconciliationRow>>(`/checkin/reconciliation${qs({ ...filters })}`),
    resolveReconciliation: (id: string, action: ReconcileResolutionAction, reason: string) =>
      request<ReconciliationRow>(`/checkin/reconciliation/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action, reason }),
      }),
    commandCenter: (organizationId: string, eventSessionId: string) =>
      request<CommandCenterSnapshot>(
        `/checkin/command-center${qs({ organizationId, eventSessionId })}`,
      ),
    commandCenterActivity: (organizationId: string, page?: number) =>
      request<Paged<ActivityRow>>(
        `/checkin/command-center/activity${qs({ organizationId, page })}`,
      ),
    acknowledgeAlert: (body: {
      organizationId: string;
      eventSessionId: string;
      alertKey: string;
      severity: AlertSeverity;
      reason: string;
    }) =>
      request<{ id: string }>('/checkin/command-center/alerts/ack', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    preflight: (body: PreflightRequest) =>
      request<PreflightReport>('/checkin/preflight', {
        method: 'POST',
        body: JSON.stringify(body),
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

  /**
   * Price a cart before committing to it. Holds nothing, writes nothing, redeems nothing —
   * so it is safe to call on every change to the selection or the code.
   */
  bookingQuote: {
    price: (body: {
      eventSessionId: string;
      items: { ticketTypeId: string; quantity: number; seatIds?: string[] }[];
      couponCode?: string;
    }) =>
      request<{
        fees: BookingResult['fees'];
        coupon: { code: string | null; applied: boolean };
      }>('/bookings/quote', { method: 'POST', body: JSON.stringify(body), auth: false }),
    /** Codes the organizer chose to advertise. Private codes are never listed. */
    offers: (eventSessionId: string) =>
      request<{ code: string; label: string }[]>(`/bookings/offers/${eventSessionId}`, {
        auth: false,
      }),
  },

  bookingCoupon: {
    /** Apply a code, or clear it by passing null. Returns the re-priced fees. */
    set: (bookingId: string, code: string | null) =>
      request<{ applied: boolean; code: string | null; fees: BookingResult['fees'] }>(
        `/bookings/${bookingId}/coupon`,
        { method: 'POST', body: JSON.stringify({ code }) },
      ),
  },

  receipts: {
    forBooking: (bookingId: string) => request<ReceiptSummary[]>(`/receipts/booking/${bookingId}`),
    get: (id: string) => request<ReceiptDocument>(`/receipts/${id}`),
    /**
     * Open the printable document in a new tab.
     *
     * ── WHY THIS IS NOT AN href ────────────────────────────────────────────────────
     * It was, and it returned 401. Authentication here is a bearer token held in
     * localStorage, so a plain link opens a tab that sends no Authorization header — the
     * browser has no idea the token exists. Reported from QA as "getting the error when
     * trying to view the receipt", and it would have failed for every customer.
     *
     * Fetching with the token and handing the browser a blob keeps the document behind the
     * same auth as everything else, with no second credential path to get wrong: no cookie
     * to scope, no signed URL that works for anyone who copies it out of a chat. Print and
     * save-as-PDF still work, because it is the same HTML in a real tab.
     */
    openHtml: async (id: string): Promise<void> => {
      const res = await fetch(`${API_URL}/receipts/${id}/html`, {
        headers: tokenStore.access ? { authorization: `Bearer ${tokenStore.access}` } : {},
      });
      if (!res.ok) throw new Error(`Could not load the document (${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      // Released on the next tick: revoking immediately can beat the new tab to the load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
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
    commerce: (eventId: string) => request<CommerceReport>(`/reports/events/${eventId}/commerce`),
    downloadEventCsv: (eventId: string) =>
      downloadCsv(`/reports/events/${eventId}?format=csv`, `event-report-${eventId}.csv`),
    downloadCommerceCsv: (eventId: string) =>
      downloadCsv(
        `/reports/events/${eventId}/commerce?format=csv`,
        `commerce-report-${eventId}.csv`,
      ),
  },

  // Experience Commerce (v1.3): organizer add-on / bundle catalog + public reads.
  commerce: {
    listAddOns: (eventId: string) => request<OrgAddOn[]>(`/events/${eventId}/addons`),
    createAddOn: (eventId: string, body: AddOnInput) =>
      request<OrgAddOn>(`/events/${eventId}/addons`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateAddOn: (id: string, body: Partial<AddOnInput>) =>
      request<OrgAddOn>(`/addons/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteAddOn: (id: string) =>
      request<{ deleted: boolean }>(`/addons/${id}`, { method: 'DELETE' }),
    listBundles: (eventId: string) => request<OrgBundle[]>(`/events/${eventId}/bundles`),
    createBundle: (eventId: string, body: BundleInput) =>
      request<OrgBundle>(`/events/${eventId}/bundles`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateBundle: (id: string, body: Partial<BundleInput>) =>
      request<OrgBundle>(`/bundles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteBundle: (id: string) =>
      request<{ deleted: boolean }>(`/bundles/${id}`, { method: 'DELETE' }),
    publicAddOns: (eventId: string) =>
      request<PublicAddOn[]>(`/public/events/${eventId}/addons`, { auth: false }),
    publicBundles: (eventId: string) =>
      request<PublicBundle[]>(`/public/events/${eventId}/bundles`, { auth: false }),
  },

  analytics: {
    /** Whole-org organizer dashboard in one aggregate round (replaces per-event fan-out). */
    organizer: (organizationId: string) =>
      request<OrganizerAnalytics>(`/analytics/organizer${qs({ organizationId })}`),
    venue: (venueId: string) => request<VenueAnalytics>(`/analytics/venue/${venueId}`),
    customer: () => request<CustomerAnalytics>('/analytics/customer'),
  },

  // AI & Growth (v2.0): organizer assistant, summaries, growth recs, content drafts.
  ai: {
    eventSummary: (eventId: string) => request<AiEventSummary>(`/ai/events/${eventId}/summary`),
    recommendations: (eventId: string) =>
      request<{ recommendations: GrowthRecommendation[] }>(`/ai/events/${eventId}/recommendations`),
    ask: (organizationId: string, question: string) =>
      request<AiAnswer>('/ai/organizer/ask', {
        method: 'POST',
        body: JSON.stringify({ organizationId, question }),
      }),
    contentDraft: (body: AiContentDraftInput) =>
      request<AiContentDraft>('/ai/content/draft', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  // ─── Organizer Stripe Connect (payout setup) ───
  organizerPayments: {
    status: (organizerId: string) =>
      request<OrganizerPaymentStatus>(`/organizers/${organizerId}/payments/status`),
    createAccount: (organizerId: string, body?: { country?: string; email?: string }) =>
      request<OrganizerPaymentStatus>(`/organizers/${organizerId}/payments/stripe/account`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    onboardingLink: (organizerId: string) =>
      request<{ url: string; expiresAt?: number }>(
        `/organizers/${organizerId}/payments/stripe/onboarding-link`,
        { method: 'POST' },
      ),
    dashboardLink: (organizerId: string) =>
      request<{ url: string }>(`/organizers/${organizerId}/payments/stripe/dashboard-link`, {
        method: 'POST',
      }),
    // India (Razorpay Route) payout account.
    razorpayStatus: (organizerId: string) =>
      request<RazorpayAccountStatus>(`/organizers/${organizerId}/payments/razorpay/status`),
    razorpayLink: (organizerId: string, linkedAccountId: string) =>
      request<RazorpayAccountStatus>(`/organizers/${organizerId}/payments/razorpay/account`, {
        method: 'POST',
        body: JSON.stringify({ linkedAccountId }),
      }),
  },

  admin: {
    dashboard: () => request<AdminDashboard>('/admin/dashboard'),

    /** Back-office staff and what each of them may do. Needs ADMIN_MANAGE. */
    staff: {
      catalogue: () =>
        request<{
          permissions: string[];
          presets: { key: string; label: string; description: string; grants: string[] }[];
        }>('/admin/staff/catalogue'),
      list: () => request<AdminStaffMember[]>('/admin/staff'),
      setPermissions: (userId: string, permissions: string[], note?: string) =>
        request<{ userId: string; permissions: string[] }>(`/admin/staff/${userId}/permissions`, {
          method: 'PUT',
          body: JSON.stringify({ permissions, note }),
        }),
      /** Turn an existing account into a back-office one, with its duties in one step. */
      grantAdminRole: (userId: string, permissions: string[]) =>
        request<{ userId: string; permissions: string[] }>(`/admin/staff/${userId}/admin-role`, {
          method: 'PUT',
          body: JSON.stringify({ permissions }),
        }),
      revoke: (userId: string) =>
        request<{ userId: string; removed: boolean }>(`/admin/staff/${userId}/admin-role`, {
          method: 'DELETE',
        }),
    },
    platformAnalytics: () => request<PlatformAnalytics>('/admin/analytics/platform'),
    aiStatus: () => request<AiStatus>('/admin/ai/status'),
    aiUsage: () => request<AiUsageSummary>('/admin/ai/usage'),
    aiRisk: () => request<AiRiskReport>('/admin/ai/risk'),
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
    /** Create a band. `currency` is required — a band only means anything within one. */
    createFeeRule: (input: Omit<FeeRule, 'id'>) =>
      request<FeeRule>('/admin/fee-rules', { method: 'POST', body: JSON.stringify(input) }),
    /**
     * Update one fee rule. `currency` is not editable — the amounts are minor units, so
     * switching currency would reinterpret ₹5 as $5. Omit a field to leave it unchanged;
     * pass `maxMinor: null` to make a band open-ended ("and above").
     */
    updateFeeRule: (
      id: string,
      patch: Partial<Pick<FeeRule, 'label' | 'minMinor' | 'maxMinor' | 'feeMinor' | 'active'>>,
    ) =>
      request<FeeRule>(`/admin/fee-rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    // ─── Marketplace settlements (admin/finance) ───
    settlements: {
      list: (
        params?: PageParams & { status?: string; organizationId?: string; eventId?: string },
      ) => request<Paged<SettlementRow>>(`/admin/settlements${qs(params ?? {})}`),
      get: (id: string) => request<SettlementDetail>(`/admin/settlements/${id}`),
      approve: (id: string) =>
        request<SettlementRow>(`/admin/settlements/${id}/approve`, { method: 'POST' }),
      release: (id: string, note?: string) =>
        request<SettlementRow>(`/admin/settlements/${id}/release`, {
          method: 'POST',
          body: JSON.stringify({ note }),
        }),
      block: (id: string, reason: string) =>
        request<SettlementRow>(`/admin/settlements/${id}/block`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
    },

    // ─── Runtime payment configuration (admin) ───
    paymentConfig: {
      overview: (env?: PaymentEnvValue) =>
        request<PaymentConfigOverview>(`/admin/payments/config${qs({ env })}`),
      updateProvider: (id: string, patch: PaymentConfigPatch, env?: PaymentEnvValue) =>
        request<PaymentProviderConfigRow>(`/admin/payments/config/${id}${qs({ env })}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      testConnection: (id: string, env?: PaymentEnvValue) =>
        request<TestConnectionResult>(
          `/admin/payments/config/${id}/test-connection${qs({ env })}`,
          {
            method: 'POST',
          },
        ),
      createRoute: (input: PaymentRouteInput, env?: PaymentEnvValue) =>
        request<PaymentRouteRow>(`/admin/payments/routes${qs({ env })}`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      updateRoute: (id: string, input: Partial<PaymentRouteInput>, env?: PaymentEnvValue) =>
        request<PaymentRouteRow>(`/admin/payments/routes/${id}${qs({ env })}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      deleteRoute: (id: string, env?: PaymentEnvValue) =>
        request<{ deleted: boolean }>(`/admin/payments/routes/${id}${qs({ env })}`, {
          method: 'DELETE',
        }),
      health: () => request<ProviderHealthReport>('/admin/payments/health'),
      liveReadiness: (provider?: string) =>
        request<LiveReadinessReport>(`/admin/payments/live-readiness${qs({ provider })}`),
      reconciliation: (from?: string, to?: string) =>
        request<ReconciliationReport>(`/admin/payments/reconciliation${qs({ from, to })}`),
      settlement: (from?: string, to?: string) =>
        request<SettlementLine[]>(`/admin/payments/settlement${qs({ from, to })}`),
    },

    // ─── Merchant onboarding (admin) ───
    onboarding: {
      list: (env?: PaymentEnvValue, status?: OnboardingStatusValue) =>
        request<MerchantOnboardingRow[]>(`/admin/payments/onboarding${qs({ env, status })}`),
      detail: (id: string) => request<OnboardingDetail>(`/admin/payments/onboarding/${id}`),
      create: (body: CreateOnboardingBody) =>
        request<MerchantOnboardingRow>('/admin/payments/onboarding', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      update: (id: string, patch: OnboardingPatchBody) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      acceptTerms: (id: string) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}/accept-terms`, {
          method: 'POST',
        }),
      setWebhookStatus: (id: string, status: string) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}/webhook-status`, {
          method: 'POST',
          body: JSON.stringify({ status }),
        }),
      setVerification: (id: string, status: string) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}/verification`, {
          method: 'POST',
          body: JSON.stringify({ status }),
        }),
      testConnection: (id: string) =>
        request<TestConnectionResult>(`/admin/payments/onboarding/${id}/test-connection`, {
          method: 'POST',
        }),
      certify: (id: string) =>
        request<MerchantCertificationRow>(`/admin/payments/onboarding/${id}/certify`, {
          method: 'POST',
        }),
      certifications: (id: string) =>
        request<MerchantCertificationRow[]>(`/admin/payments/onboarding/${id}/certifications`),
      transition: (id: string, to: OnboardingStatusValue) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}/transition`, {
          method: 'POST',
          body: JSON.stringify({ to }),
        }),
      activate: (id: string) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}/activate`, {
          method: 'POST',
        }),
      suspend: (id: string, reason: string) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}/suspend`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      reject: (id: string, reason: string) =>
        request<MerchantOnboardingRow>(`/admin/payments/onboarding/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
    },

    // ─── Environment promotion (admin) ───
    promotion: {
      report: (from: PaymentEnvValue, to: PaymentEnvValue, provider: string) =>
        request<PromotionReportResult>(
          `/admin/payments/promotion/report${qs({ from, to, provider })}`,
        ),
      list: (to?: PaymentEnvValue, status?: PromotionStatusValue) =>
        request<PromotionRequestRow[]>(`/admin/payments/promotion${qs({ to, status })}`),
      create: (fromEnv: PaymentEnvValue, toEnv: PaymentEnvValue, provider: string) =>
        request<PromotionRequestRow>('/admin/payments/promotion', {
          method: 'POST',
          body: JSON.stringify({ fromEnv, toEnv, provider }),
        }),
      approve: (id: string, note?: string) =>
        request<PromotionRequestRow>(`/admin/payments/promotion/${id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ note }),
        }),
      reject: (id: string, reason: string) =>
        request<PromotionRequestRow>(`/admin/payments/promotion/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      apply: (id: string) =>
        request<PromotionRequestRow>(`/admin/payments/promotion/${id}/apply`, { method: 'POST' }),
    },

    // ─── Finance reconciliation (admin) ───
    finance: {
      detect: (from?: string, to?: string) =>
        request<{ detected: number; created: number }>(
          `/admin/payments/finance/detect${qs({ from, to })}`,
          { method: 'POST' },
        ),
      discrepancies: (status?: string, type?: string) =>
        request<DiscrepancyRow[]>(`/admin/payments/finance/discrepancies${qs({ status, type })}`),
      aging: () => request<AgingBucket[]>('/admin/payments/finance/aging'),
      assign: (id: string, userId: string) =>
        request<DiscrepancyRow>(`/admin/payments/finance/discrepancies/${id}/assign`, {
          method: 'POST',
          body: JSON.stringify({ userId }),
        }),
      resolve: (id: string, notes: string) =>
        request<DiscrepancyRow>(`/admin/payments/finance/discrepancies/${id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ notes }),
        }),
      ignore: (id: string, notes: string) =>
        request<DiscrepancyRow>(`/admin/payments/finance/discrepancies/${id}/ignore`, {
          method: 'POST',
          body: JSON.stringify({ notes }),
        }),
      csvUrl: () => `${API_URL}/admin/payments/finance/discrepancies.csv`,
    },
    support: (params?: PageParams & { kind?: string; status?: string; q?: string }) =>
      request<Paged<FeedbackRow>>(`/admin/support${qs(params ?? {})}`),
    updateSupport: (id: string, status: FeedbackStatusValue) =>
      request<{ id: string; status: FeedbackStatusValue }>(`/admin/support/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),

    // ─── Internal operations console (admin-only) ───
    opsHealth: () => request<OpsHealth>('/admin/ops/health'),
    opsQueues: () => request<OpsQueues>('/admin/ops/queues'),
    opsFailedJobs: (limit?: number) =>
      request<{ jobs: OpsFailedJob[] }>(`/admin/ops/queues/failed${qs({ limit })}`),
    opsRetryFailed: () =>
      request<{ retried: number; total: number }>('/admin/ops/queues/retry-failed', {
        method: 'POST',
      }),
    opsRetryJob: (id: string) =>
      request<{ id: string; retried: boolean }>(`/admin/ops/queues/jobs/${id}/retry`, {
        method: 'POST',
      }),
    maintenance: () => request<MaintenanceState>('/admin/ops/maintenance'),
    setMaintenance: (body: { enabled: boolean; message?: string }) =>
      request<MaintenanceState>('/admin/ops/maintenance', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    opsFlags: () => request<OpsFlags>('/admin/ops/flags'),

    // ─── Business-operations reports (admin-only, read-only) ───
    reports: {
      dailyRevenue: (params?: ReportRange) =>
        request<DailyRevenueReport>(`/admin/reports/daily-revenue${qs(params ?? {})}`),
      organizerRevenue: (params?: ReportRange & { limit?: number }) =>
        request<OrganizerRevenueReport>(`/admin/reports/organizer-revenue${qs(params ?? {})}`),
      settlement: () => request<SettlementReport>('/admin/reports/settlement'),
      refunds: (params?: ReportRange) =>
        request<RefundReport>(`/admin/reports/refunds${qs(params ?? {})}`),
      platformFees: (params?: ReportRange) =>
        request<PlatformFeesReport>(`/admin/reports/platform-fees${qs(params ?? {})}`),
      tax: (params?: ReportRange) => request<TaxReport>(`/admin/reports/tax${qs(params ?? {})}`),
      topExperiences: (params?: ReportRange & { limit?: number }) =>
        request<TopExperiencesReport>(`/admin/reports/top-experiences${qs(params ?? {})}`),
      growth: (params?: ReportRange) =>
        request<GrowthReport>(`/admin/reports/growth${qs(params ?? {})}`),
      paymentHealth: (params?: ReportRange) =>
        request<PaymentHealthReport>(`/admin/reports/payment-health${qs(params ?? {})}`),

      /** Absolute URL for a report's CSV export (bearer auth still required). */
      csvUrl: (report: ReportCsvName, params?: ReportRange & { limit?: number }) =>
        `${API_URL}/admin/reports/${report}${qs({ ...(params ?? {}), format: 'csv' })}`,

      /**
       * Fetch a report's CSV with the bearer token and trigger a browser download.
       * Used instead of a naked link so the admin-gated endpoint stays authorized.
       */
      downloadCsv: async (report: ReportCsvName, params?: ReportRange & { limit?: number }) => {
        const res = await fetch(
          `${API_URL}/admin/reports/${report}${qs({ ...(params ?? {}), format: 'csv' })}`,
          { headers: tokenStore.access ? { authorization: `Bearer ${tokenStore.access}` } : {} },
        );
        if (!res.ok) throw new ApiRequestError('CSV_EXPORT_FAILED', 'Could not export CSV.');
        const blob = await res.blob();
        if (typeof window === 'undefined') return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${report}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
    },
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
  addOns?: { addOnId: string; quantity: number }[];
  bundles?: { bundleId: string; quantity: number }[];
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
    /** Zero unless the seller's market has a configured tax rule. */
    taxMinor: number;
    taxLines: ReceiptTaxLine[];
  };
  payment: { id: string; status: string };
}
export interface BookingDetail {
  id: string;
  reference: string | null;
  status: string;
  holdExpiresAt: string;
  totalMinor: number;
  subtotalMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  discountMinor: number;
  /** Zero unless the seller's market has a configured tax rule. */
  taxMinor: number;
  taxLines?: ReceiptTaxLine[];
  currency: string;
  buyerName: string;
  buyerEmail: string;
  event: {
    title: string;
    slug: string;
    /** The organizer's terms. False means no refund is offered for this event. */
    refundsEnabled?: boolean;
    refundCutoffHours?: number;
  };
  eventSession: { startsAt: string };
  items: {
    kind?: string;
    quantity: number;
    unitPriceMinor: number;
    label?: string | null;
    ticketType?: { name: string } | null;
    addOn?: { name: string; type: string } | null;
    bundle?: { name: string; type: string } | null;
  }[];
  tickets: {
    id: string;
    status: string;
    /** e.g. "F13". Null for general admission, which has no seat to name. */
    seatLabel?: string | null;
    ticketTypeName?: string | null;
  }[];
  payment: { status: string } | null;
  /**
   * The VENUE's timezone. A showtime is the time at the cinema, not in the reader's
   * browser — rendering it locally is how a ticket and its confirmation disagreed.
   */
  timeZone?: string | null;
  /**
   * Seats bought, for a reserved-seating show. Held seats before payment, ticketed seats
   * after — so the label list reads the same either side of the transaction. Empty for
   * general-admission events, which have no seats to name.
   */
  seatLabels?: string[];
}
export interface BookingSummary {
  id: string;
  reference: string | null;
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
  // Booking-grouping + seat/screen context. Additive — older API responses (and
  // older cached payloads) omit these, so every consumer must treat them as
  // optional and fall back gracefully.
  bookingId?: string;
  bookingRef?: string;
  experienceType?: string;
  seatLabel?: string | null;
  venueName?: string | null;
  screenName?: string | null;
  cinemaName?: string | null;
  // Attendee identity (ADR-031).
  assignmentStatus?: AttendeeAssignmentValue;
  attendeeName?: string | null;
  ownedByViewer?: boolean;
  assignedToViewer?: boolean;
}

export type AttendeeAssignmentValue =
  'UNASSIGNED' | 'ASSIGNED' | 'INVITED' | 'ACCEPTED' | 'DECLINED';

export interface AssignAttendeeBody {
  name: string;
  email: string;
  phone?: string;
  country?: string;
  company?: string;
  designation?: string;
  studentId?: string;
  memberId?: string;
  customFields?: Record<string, string>;
}
export interface InviteAttendeeBody {
  email: string;
  phone?: string;
  name?: string;
}
export interface AttendeeTicket {
  id: string;
  serial: string;
  status: string;
  assignmentStatus: AttendeeAssignmentValue;
  attendeeName: string | null;
  attendeeEmail: string | null;
  seatLabel: string | null;
}
export interface InviteResult {
  id: string;
  ticketId: string;
  email: string;
  kind: 'INVITE' | 'TRANSFER';
  status: string;
  /** Raw claim token — owner may copy/share the /invite/<token> link. */
  token: string;
}
// ── Secure Experience Sharing (ADR-032) ──
export type SharePermissionValue = 'VIEW' | 'GUEST' | 'TRANSFER';
export type ShareExpiryValue = '1h' | '6h' | '24h' | 'event_end' | 'never';
export type ShareResourceType =
  'TICKET' | 'MEMBERSHIP' | 'PARKING_PASS' | 'FOOD_VOUCHER' | 'VIP_PASS';

export interface CreateShareBody {
  permission: SharePermissionValue;
  expiry: ShareExpiryValue;
  maxOpens?: number;
  email?: string;
  label?: string;
}
export interface ShareCreated {
  id: string;
  token: string;
  shareUrl: string;
  qrDataUrl: string;
  permission: SharePermissionValue;
  expiresAt: string;
  maxOpens: number | null;
}
export interface ShareActivityRow {
  id: string;
  permission: SharePermissionValue;
  status: string;
  email: string | null;
  label: string | null;
  openCount: number;
  maxOpens: number | null;
  expiresAt: string;
  lastOpenedAt: string | null;
  createdAt: string;
}
export interface ShareActivity {
  ticketId: string;
  shares: ShareActivityRow[];
}
export interface SharedResourceView {
  resourceType: ShareResourceType;
  title: string;
  subtitle: string | null;
  status: string;
  reference: string | null;
  ticketType: string | null;
  attendeeName: string | null;
  seatLabel: string | null;
  venueName: string | null;
  screenName: string | null;
  cinemaName: string | null;
  startsAt: string | null;
  endsAt: string | null;
}
export interface ResolvedShare {
  permission: SharePermissionValue;
  resource: SharedResourceView;
  qrDataUrl: string | null;
  canCheckIn: boolean;
  canTransfer: boolean;
  canDownload: boolean;
  expiresAt: string;
  remainingOpens: number | null;
}

export interface AttendeeSummary {
  bookingId: string;
  reference: string | null;
  counts: {
    total: number;
    unassigned: number;
    assigned: number;
    invited: number;
    accepted: number;
    declined: number;
    checkedIn: number;
  };
  tickets: {
    id: string;
    serial: string;
    seatLabel: string | null;
    ticketType: string;
    status: string;
    assignmentStatus: AttendeeAssignmentValue;
    attendeeName: string | null;
    attendeeEmail: string | null;
    pendingInvite: { id: string; email: string; kind: string; expiresAt: string } | null;
  }[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  contactEmail: string | null;
  createdAt: string;
  // Public organizer profile (v1.2 WS6).
  description?: string | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  website?: string | null;
  contactPhone?: string | null;
  twitterUrl?: string | null;
  instagramUrl?: string | null;
  facebookUrl?: string | null;
  verified?: boolean;
  _count?: { members: number; events: number; venues?: number };
}
export interface OrganizationProfileInput {
  description?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  website?: string;
  contactEmail?: string;
  contactPhone?: string;
  twitterUrl?: string;
  instagramUrl?: string;
  facebookUrl?: string;
}
export interface OrgMember {
  id: string;
  role: string;
  status: string;
  user: { id: string; email: string; fullName: string };
}
export interface NotificationItem {
  id: string;
  type: string;
  subject: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}
export interface NotificationInbox {
  items: NotificationItem[];
  unreadCount: number;
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

export type CouponType = 'PERCENT' | 'FIXED';
export interface Coupon {
  id: string;
  organizationId: string | null;
  code: string;
  type: CouponType;
  value: number;
  maxRedemptions: number | null;
  redemptions: number;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Whether buyers are shown this code at checkout. */
  isPublic?: boolean;
  publicLabel?: string | null;
}
export interface CreateCouponBody {
  organizationId: string;
  code: string;
  type: CouponType;
  value: number;
  maxRedemptions?: number;
  /** Show this code to every buyer at checkout. Off unless deliberately set. */
  isPublic?: boolean;
  publicLabel?: string;
  startsAt?: string;
  endsAt?: string;
}
export interface UpdateCouponBody {
  value?: number;
  maxRedemptions?: number | null;
  isPublic?: boolean;
  publicLabel?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
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
  status?: string;
  /** Recorded on the audit entry when the operational state changes. */
  statusReason?: string;
}

export interface Screen extends ScreenBody {
  id: string;
  cinemaId: string;
  /** ACTIVE | MAINTENANCE | INACTIVE. Absent on older API responses. */
  status?: string;
  /** Returned when a status change is made, so the UI can warn before committing. */
  futureShowsRequiringAttention?: number;
  /** False until a seat layout is published. A screen without one cannot host a show. */
  hasSeatMap?: boolean;
}

export interface CinemaBody {
  name: string;
  brand?: string;
  city: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  venueId?: string;
  /**
   * IANA zone for this cinema's local clock. Optional on create — the server defaults it to
   * the launch market — but always present on a cinema that has been read back.
   */
  timezone?: string;
}

export interface Cinema extends CinemaBody {
  id: string;
  status: string;
  screens?: Screen[];
  /**
   * AUTHORITATIVE for every local date and time this client renders for the venue.
   *
   * Never substitute a literal, the browser's zone, or a launch-market default: a Hyderabad
   * cinema operated from London must show Hyderabad days, and a Sydney one must show Sydney
   * days. Required here (not optional) precisely so a page cannot forget to pass it.
   */
  timezone: string;
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

export interface Discovery {
  nowShowing: PublicMovieCard[];
  trendingEvents: PublicEventCard[];
  thisWeekend: PublicEventCard[];
  categories: string[];
}

/** The section kinds the composed discovery feed can return. */
export type DiscoverySectionKind = 'events' | 'movies' | 'organizers' | 'venues';

/** A spotlit organizer card in an `organizers` section. */
export interface OrganizerSpotlight {
  id: string;
  name: string;
  verified: boolean;
  eventCount: number;
}

/** A spotlit venue card in a `venues` section. */
export interface VenueSpotlight {
  id: string;
  name: string;
  city: string;
  country: string;
  eventCount: number;
}

/**
 * One composed discovery section. `items` shape follows `kind`:
 * events → PublicEventCard, movies → PublicMovieCard,
 * organizers → OrganizerSpotlight, venues → VenueSpotlight.
 */
export interface DiscoverySection {
  key: string;
  title: string;
  kind: DiscoverySectionKind;
  items: unknown[];
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD';

/**
 * What sort of seat this is.
 *
 * GAP never reaches a customer — an aisle is not inventory and the API drops it — but the
 * value exists because the ORGANIZER's read uses the same vocabulary to describe the room.
 */
export type SeatKind = 'SEAT' | 'WHEELCHAIR' | 'COMPANION' | 'GAP';

export interface SeatLayoutSeat {
  id: string;
  label: string;
  colIndex: number;
  categoryId: string;
  /**
   * Present so a wheelchair space can be found by the person who needs one.
   *
   * It was missing, and a bay rendered as an ordinary seat: unfindable by the customer who
   * needs it, and quietly taken by one who does not.
   */
  kind: SeatKind;
  status: SeatStatus;
}

/** The venue shapes an organizer can start a layout from. */
export type VenueTemplateKey =
  'CINEMA' | 'PROSCENIUM' | 'AMPHITHEATRE' | 'ARENA' | 'STADIUM' | 'IN_THE_ROUND';

/** A point in the venue map's abstract 0–1000 square, y increasing downward. */
export type VenuePoint = [number, number];

/** What the audience faces, and where it sits on the map. */
export interface VenueFocalPoint {
  kind: 'SCREEN' | 'STAGE_END' | 'STAGE_THRUST' | 'STAGE_CENTRE' | 'FIELD';
  /** "SCREEN", "STAGE", "PITCH" — what to write on it. */
  label: string;
  shape: VenuePoint[] | null;
}

interface SeatLayoutBase {
  sessionId: string;
  /** `id` is the seat category id; `ticketTypeId` is the session's price tier for it. */
  categories: {
    id: string;
    ticketTypeId: string | null;
    name: string;
    colorHex: string | null;
    priceMinor: number;
  }[];
  focal: VenueFocalPoint;
  layoutKind: 'GRID' | 'SECTIONED';
}

/** One block on the venue overview: an outline, what is left in it, and what it costs. */
export interface VenueSectionSummary {
  id: string;
  name: string;
  shape: VenuePoint[] | null;
  labelX: number | null;
  labelY: number | null;
  tier: string | null;
  rotationDeg: number;
  availableCount: number;
  totalCount: number;
  priceMinorFrom: number | null;
  priceMinorTo: number | null;
}

/**
 * The map of a large venue, with no seats in it.
 *
 * Sent for a SECTIONED layout when no section was asked for. A stadium is fourteen thousand
 * seats and several megabytes of JSON; this is a few dozen polygons.
 */
export interface VenueOverview extends SeatLayoutBase {
  view: 'overview';
  layoutKind: 'SECTIONED';
  sections: VenueSectionSummary[];
}

/** Seats to pick from: a whole cinema, or one block of a large venue. */
export interface SeatLayout extends SeatLayoutBase {
  view: 'seats';
  sections: {
    id: string;
    name: string;
    shape: VenuePoint[] | null;
    tier: string | null;
    rotationDeg: number;
    rows: { label: string; seats: SeatLayoutSeat[] }[];
  }[];
}

/**
 * Either shape, discriminated by `view`.
 *
 * A union rather than one type with optional rows, so a client that reaches for seats on an
 * overview fails to compile — instead of rendering an empty grid and telling the customer
 * the block is sold out.
 */
export type SeatLayoutResponse = VenueOverview | SeatLayout;

export interface SeatMap {
  id: string;
  screenId: string;
  name: string | null;
  categories: { id: string; name: string; colorHex: string | null; basePriceMinor: number }[];
  sections: {
    id: string;
    name: string;
    rows: {
      id: string;
      label: string;
      seats: { id: string; label: string; colIndex: number; seatCategoryId: string }[];
    }[];
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
  screenId: string | null;
  screenName: string | null;
  cinemaId: string | null;
  cinemaName: string | null;
  movieId: string | null;
  movieTitle: string | null;
  /** SCHEDULED | PAUSED | CANCELLED | COMPLETED. Never inferred client-side. */
  status: string;
  /** Effective booking window across the show's ticket types. Null = unbounded. */
  salesStartAt: string | null;
  salesEndAt: string | null;
  seatsSold: number;
  seatsTotal: number;
}

/**
 * A show's own prices.
 *
 * Prices belong to the SHOW, not the seat layout: the layout says where people sit, the
 * ticket type says what that seat costs tonight. `basePriceMinor` is the layout default the
 * show was created from and is shown only so an operator can see when tonight differs.
 */
export interface ShowPricing {
  sessionId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  screenName: string | null;
  cinemaId: string | null;
  timezone: string | null;
  movieTitle: string | null;
  categories: {
    ticketTypeId: string;
    seatCategoryId: string | null;
    name: string;
    colorHex: string | null;
    currency: string;
    priceMinor: number;
    basePriceMinor: number | null;
    seatCount: number;
    soldCount: number;
    heldCount: number;
    /** A sold seat fixes this category's price for this show. Nothing else does. */
    locked: boolean;
  }[];
}

export interface BulkScheduleBody {
  screenId: string;
  dates?: string[];
  from?: string;
  to?: string;
  times: string[];
  padMinutes?: number;
  timezone?: string;
  pricing?: { seatCategoryId: string; priceMinor: number }[];
  dryRun: boolean;
}

/** One proposal the server refused, with enough detail to fix it. */
export interface ScheduleRejection {
  startsAt: string;
  endsAt: string;
  reason:
    | 'ENDS_BEFORE_IT_STARTS'
    | 'IN_THE_PAST'
    | 'DUPLICATE_IN_REQUEST'
    | 'OVERLAPS_EXISTING_SHOW'
    | 'OVERLAPS_PROPOSED_SHOW'
    | string;
  detail?: string | number;
  gapMinutes?: number;
}

export interface BulkScheduleResult {
  dryRun: boolean;
  turnaroundMinutes: number;
  proposed: number;
  created: { sessionId: string; startsAt: string; endsAt: string }[];
  rejected: ScheduleRejection[];
}

export interface CopyScheduleBody {
  sourceScreenId: string;
  sourceDate: string;
  targetScreenId?: string;
  targetDate: string;
  timezone?: string;
  dryRun: boolean;
}

export interface CopyScheduleResult extends BulkScheduleResult {
  sourceDate: string;
  targetDate: string;
  targetScreenId: string;
  /** Local times recovered from the source day, so a preview explains itself. */
  times: string[];
}

export interface ShowSalesResult {
  sessionId: string;
  status: string;
  changed: boolean;
}

export interface CancelShowResult extends ShowSalesResult {
  /**
   * Bookings the existing refund workflow must handle. Cancelling does NOT refund:
   * the UI must not imply customers have their money back.
   */
  bookingsRequiringRefund: string[];
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
export interface EventPromotion {
  eventId: string;
  title: string;
  slug: string;
  published: boolean;
  publicUrl: string;
  qrDataUrl: string;
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
export interface UpdateTicketTypeBody {
  name?: string;
  priceMinor?: number;
  quantityTotal?: number;
  maxPerOrder?: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface OrderRow {
  id: string;
  reference: string | null;
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

// ── Offline gate check-in (ADR-035) ──
export interface CheckInDeviceRow {
  id: string;
  organizationId: string;
  eventId: string | null;
  eventSessionId: string | null;
  name: string;
  platform: string | null;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  manifestVersion: number;
  expiresAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}
export interface SignedManifest {
  meta: ManifestMeta;
  entries: ManifestEntry[];
  signature: string;
}
export interface ReconcileResultItem {
  ticketId: string;
  outcome: ReconcileOutcome;
}
export interface OfflineReadinessReport {
  verdict: 'GO' | 'CONDITIONAL_GO' | 'NO_GO';
  checks: { key: string; label: string; passed: boolean; blocking?: boolean }[];
  note: string;
}

export type OfflineDrillKey =
  'TWO_DEVICE_CONFLICT' | 'DEVICE_LOSS' | 'RECONCILIATION' | 'NETWORK_LOSS';
export type OfflineDrillOutcome = 'PASS' | 'FAIL';
export interface OfflineDrillRunRow {
  id: string;
  organizationId: string;
  eventId: string | null;
  eventSessionId: string | null;
  drillKey: OfflineDrillKey;
  outcome: OfflineDrillOutcome;
  summary: string;
  evidence: unknown;
  ranByUserId: string | null;
  createdAt: string;
}
export interface RecordDrillInput {
  organizationId: string;
  eventId?: string;
  eventSessionId?: string;
  drillKey: OfflineDrillKey;
  outcome: OfflineDrillOutcome;
  summary: string;
  evidence?: unknown;
}

export type OfflineActivationState = 'ACTIVE' | 'REVOKED' | 'SUPERSEDED';
export interface OfflineActivationRow {
  id: string;
  organizationId: string;
  eventId: string;
  eventSessionId: string;
  deviceIds: string[];
  state: OfflineActivationState;
  reason: string;
  evidenceSnapshot: unknown;
  approvedByUserId: string;
  approvedAt: string;
  revokedByUserId: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
}
export interface RecordActivationInput {
  organizationId: string;
  eventSessionId: string;
  deviceIds: string[];
  reason: string;
}

export type ReconcileOutcomeName =
  | 'ACCEPTED'
  | 'DUPLICATE_SAME_DEVICE'
  | 'DUPLICATE_OTHER_DEVICE'
  | 'REVOKED_AFTER_DOWNLOAD'
  | 'REFUNDED_AFTER_DOWNLOAD'
  | 'TRANSFERRED_AFTER_DOWNLOAD'
  | 'WRONG_SESSION'
  | 'ALREADY_CHECKED_IN_ONLINE'
  | 'SUPERVISOR_REVIEW_REQUIRED';
export type ReconcileReviewStateName = 'NOT_REQUIRED' | 'PENDING' | 'RESOLVED';
export type ReconcileResolutionAction = 'ACKNOWLEDGED' | 'DISMISSED';

interface ReconcileUserRef {
  id: string;
  email: string;
  fullName: string | null;
}
export interface ReconciliationRow {
  id: string;
  organizationId: string;
  eventId: string | null;
  eventSessionId: string;
  deviceId: string;
  ticketId: string;
  operatorUserId: string | null;
  localScannedAt: string;
  reconciledAt: string;
  outcome: ReconcileOutcomeName;
  wasOverride: boolean;
  reviewState: ReconcileReviewStateName;
  resolutionAction: ReconcileResolutionAction | null;
  resolutionReason: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  operator: ReconcileUserRef | null;
  resolvedBy: ReconcileUserRef | null;
}
export interface ReconciliationQuery {
  organizationId: string;
  eventId?: string;
  eventSessionId?: string;
  deviceId?: string;
  outcome?: string;
  reviewState?: string;
  ticketId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export type WalletPassProviderName = 'apple' | 'google';
export type WalletPassStatus = 'unavailable' | 'sandbox' | 'configured';
export interface WalletProviderStatusRow {
  provider: WalletPassProviderName;
  status: WalletPassStatus;
  mode: 'sandbox' | 'production';
}
export type WalletPassResponse =
  | { available: false; provider: WalletPassProviderName; status: 'unavailable'; reason: string }
  | {
      available: true;
      eligible: false;
      provider: WalletPassProviderName;
      status: string;
      reason: string;
    }
  | {
      available: true;
      eligible: true;
      provider: WalletPassProviderName;
      status: WalletPassStatus;
      mode: 'sandbox' | 'production';
      descriptor: Record<string, unknown>;
      note: string;
    };

export type AlertSeverity = 'critical' | 'warning' | 'info';
export interface CommandCenterAlertRow {
  key: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  eventSessionId: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  acknowledgeReason: string | null;
}
export interface CommandCenterSnapshot {
  generatedAt: string;
  activation: {
    verdict: 'GO' | 'CONDITIONAL_GO' | 'NO_GO';
    checks: { key: string; label: string; passed: boolean; blocking?: boolean }[];
    note: string;
  };
  downgrade: { hasDecision: boolean; downgradeActive: boolean; downgradeReasons: string[] };
  devices: {
    counts: {
      total: number;
      pending: number;
      active: number;
      suspended: number;
      revoked: number;
      expired: number;
      online: number;
      offline: number;
    };
    list: {
      id: string;
      name: string;
      status: string;
      manifestVersion: number;
      lastSeenAt: string | null;
      expiresAt: string | null;
    }[];
  };
  manifest: { version: number | null; stale: boolean; expiresAt: string | null };
  attendance: { total: number; admitted: number; remaining: number; admissionRate: number };
  reconciliation: {
    totalScans: number;
    accepted: number;
    duplicates: number;
    rejected: number;
    review: number;
    pendingReviews: number;
  };
  sync: {
    latency: { sampleSize: number; avgMs: number | null; maxMs: number | null };
    oldestActiveDeviceUnseenMs: number | null;
    note: string;
  };
  alerts: CommandCenterAlertRow[];
}
export interface ActivityRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  actor: { email: string } | null;
}

export type PreflightStatus = 'pass' | 'warn' | 'fail';
export type PreflightVerdict = 'READY' | 'WARNING' | 'NOT_READY';
export interface PreflightCheckRow {
  key: string;
  label: string;
  status: PreflightStatus;
  blocking: boolean;
  explanation: string;
  guidance: string;
}
export interface PreflightRequest {
  organizationId: string;
  eventSessionId: string;
  deviceId: string;
  clientManifestVersion?: number;
  clientTimeMs?: number;
  queueDepth?: number;
  syncFailureCount?: number;
}
export interface PreflightReport {
  generatedAt: string;
  deviceId: string;
  deviceName: string;
  eventSessionId: string;
  verdict: PreflightVerdict;
  checks: PreflightCheckRow[];
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
    reference: string | null;
    seatLabel: string | null;
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

/** The seller's legal + tax identity, plus what is still missing to issue a tax invoice. */
export interface OrganizationLegalIdentity {
  legalName: string | null;
  taxRegistrationKind: string | null;
  taxRegistrationNumber: string | null;
  registeredAddressLine1: string | null;
  registeredCity: string | null;
  registeredCountry: string | null;
  financeContactEmail: string | null;
  canIssueTaxInvoice: boolean;
  /** Human-readable labels of the fields still blank. */
  missing: string[];
}

export interface OrganizationLegalIdentityInput {
  legalName?: string;
  taxRegistrationKind?: string;
  taxRegistrationNumber?: string;
  registeredAddressLine1?: string;
  registeredAddressLine2?: string;
  registeredCity?: string;
  registeredRegion?: string;
  registeredPostalCode?: string;
  registeredCountry?: string;
  financeContactName?: string;
  financeContactEmail?: string;
  financeContactPhone?: string;
}

export type ReceiptKind = 'RECEIPT' | 'TAX_INVOICE' | 'CREDIT_NOTE';

export interface ReceiptSummary {
  id: string;
  number: string;
  kind: ReceiptKind;
  issuedAt: string;
  currency: string;
  totalMinor: number;
  taxMinor: number;
}

export interface ReceiptListRow extends ReceiptSummary {
  subtotalMinor: number;
  feeMinor: number;
  booking: { id: string; reference: string | null; buyerName: string };
}

export interface ReceiptListPage {
  items: ReceiptListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReceiptTaxLine {
  label: string;
  rateBasisPoints: number;
  baseMinor: number;
  amountMinor: number;
}

/** The frozen document snapshot, exactly as it was issued. */
export interface ReceiptDocument {
  version: number;
  kind: ReceiptKind;
  number: string;
  issuedAt: string;
  currency: string;
  seller: {
    name: string;
    legalName: string | null;
    taxRegistrationKind: string | null;
    taxRegistrationNumber: string | null;
    address: Record<string, string | null>;
    contactEmail: string | null;
  };
  buyer: { name: string | null; email: string | null };
  order: {
    bookingId: string;
    reference: string | null;
    eventTitle: string | null;
    sessionStartsAt: string | null;
    venue: string | null;
  };
  lines: {
    description: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }[];
  taxLines: ReceiptTaxLine[];
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    feeMinor: number;
    taxMinor: number;
    totalMinor: number;
  };
  notes: string[];
  reverses: { number: string; issuedAt: string } | null;
  reason: string | null;
}

/**
 * A refund as the organizer console lists it.
 *
 * `Omit<RefundRow, 'booking'>` rather than a plain extend: the organizer endpoint returns a
 * richer booking (reference, name, currency, event) than the admin queue's minimal
 * projection, and widening a field while extending is not something TypeScript allows.
 */
export interface OrganizationRefundRow extends Omit<RefundRow, 'booking'> {
  organizationId: string;
  processedByUserId: string | null;
  booking?: {
    id: string;
    reference: string | null;
    buyerName: string;
    buyerEmail: string;
    currency: string;
    totalMinor: number;
    event?: { title: string } | null;
  };
  creditNote?: { id: string; number: string } | null;
}

export interface AdminStaffMember {
  id: string;
  email: string;
  fullName: string;
  status: string;
  /** Holds every permission by role, not by grants — the list is filled in for display. */
  isSuperAdmin: boolean;
  permissions: string[];
}

/** Cities the platform can actually sell in right now, derived from live inventory. */
export interface SellableCity {
  city: string;
  country: string;
  eventCount: number;
}

/** How a location guess was arrived at. See the API's LocationService for what each means. */
export type LocationSource = 'coordinates' | 'network' | 'device-region' | 'none';

export interface ResolvedLocation {
  country: string | null;
  city: string | null;
  source: LocationSource;
  /** True only for a coordinate fix. Anything else is a suggestion to confirm, not apply. */
  confident: boolean;
  cities: SellableCity[];
}

export interface SectionFeed {
  sections: DiscoverySection[];
  /** What was really used — not what was asked for. */
  appliedCity: string | null;
  /** The requested city had nothing, so this feed covers everywhere. Say so in the UI. */
  fellBackToAllCities: boolean;
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

// ─── Payment start (provider-aware) ───
/** Razorpay Standard Checkout options (public — no secret). */
export interface RazorpayCheckout {
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
  callbackUrl: string;
}
export interface PayResult {
  providerRef: string;
  clientActionUrl: string;
  /** 'razorpay' when India routing applies; absent/other for the Stripe/mock path. */
  provider?: string;
  razorpay?: RazorpayCheckout;
}

/** India (Razorpay Route) payout account status (client-safe). */
export interface RazorpayAccountStatus {
  organizationId: string;
  provider: 'razorpay';
  hasAccount: boolean;
  linkedAccountId: string | null;
  onboardingStatus: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  routeEnabled: boolean;
  payoutReady: boolean;
  country: string;
  currency: string;
}

// ─── Stripe Connect marketplace (client-safe views) ───
export interface OrganizerPaymentStatus {
  organizationId: string;
  provider: string;
  hasAccount: boolean;
  accountType: string;
  onboardingStatus: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
  canSellPaidTickets: boolean;
  country: string;
  currency: string;
}

export interface SettlementRow {
  id: string;
  organizationId: string;
  eventId: string;
  currency: string;
  grossSalesMinor: number;
  refundsMinor: number;
  disputesMinor: number;
  platformFeesMinor: number;
  reserveMinor: number;
  payableMinor: number;
  transferredMinor: number;
  providerTransferId: string | null;
  connectedAccountId: string | null;
  status: string;
  releasedAt: string | null;
  createdAt: string;
  event?: { title: string; status?: string };
  organization?: { name: string };
}

export interface SettlementDetail extends SettlementRow {
  payments: Array<{ id: string; amountMinor: number; organizerNetMinor: number; status: string }>;
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

// ─── Experience Commerce (v1.3) ───
export type AddOnType =
  | 'MERCHANDISE'
  | 'PARKING'
  | 'FOOD_BEVERAGE'
  | 'VIP_UPGRADE'
  | 'MEET_GREET'
  | 'DONATION'
  | 'DIGITAL';
export type BundleType = 'VIP' | 'FAMILY' | 'COMBO' | 'EARLY_BIRD';
export type BundlePricingKind = 'FIXED' | 'PERCENT_DISCOUNT';

export interface AddOnInventory {
  quantityTotal: number | null;
  quantitySold: number;
  quantityHeld: number;
}
export interface OrgAddOn {
  id: string;
  eventId: string;
  type: AddOnType;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  maxPerOrder: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  enabled: boolean;
  inventory: AddOnInventory | null;
}
export interface AddOnInput {
  type: AddOnType;
  name: string;
  description?: string;
  priceMinor: number;
  imageUrl?: string;
  maxPerOrder?: number;
  quantityTotal?: number | null;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  enabled?: boolean;
}
export interface PublicAddOn {
  id: string;
  type: AddOnType;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  maxPerOrder: number;
  remaining: number | null;
  soldOut: boolean;
}

export interface BundleComponentInput {
  ticketTypeId?: string;
  addOnId?: string;
  quantity: number;
}
export interface OrgBundle {
  id: string;
  type: BundleType;
  name: string;
  description: string | null;
  currency: string;
  pricingKind: BundlePricingKind;
  priceMinor: number | null;
  discountPercent: number | null;
  maxPerOrder: number;
  enabled: boolean;
  priceFromMinor: number;
  listTotalMinor: number;
  savingsMinor: number;
  components: {
    refId: string;
    isTicket: boolean;
    label: string;
    quantity: number;
    listUnitPriceMinor: number;
  }[];
}
export interface BundleInput {
  type: BundleType;
  name: string;
  description?: string;
  pricingKind: BundlePricingKind;
  priceMinor?: number | null;
  discountPercent?: number | null;
  maxPerOrder?: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  enabled?: boolean;
  items: BundleComponentInput[];
}
export type PublicBundle = OrgBundle;

export interface CommerceReport {
  event: { id: string; title: string };
  addOnRevenueMinor: number;
  bundleRevenueMinor: number;
  donationTotalMinor: number;
  parkingRevenueMinor: number;
  merchandiseRevenueMinor: number;
  foodBeverageRevenueMinor: number;
  byType: { type: string; quantity: number; grossMinor: number }[];
  topAddOns: { name: string; type: string; quantity: number; grossMinor: number }[];
  bundles: { name: string; type: string; quantity: number; grossMinor: number }[];
}

// ─── AI & Growth (v2.0) ───
export interface EventSummarySection {
  key: string;
  label: string;
  text: string;
  level: 'positive' | 'info' | 'warning';
}
export interface AiEventSummary {
  aiEnabled: boolean;
  generated: boolean;
  summary: {
    headline: string;
    sections: EventSummarySection[];
    narrative: string;
    insights: { key: string; level: string; title: string; detail: string }[];
  };
  narrative: string;
}
export interface GrowthRecommendation {
  key: string;
  title: string;
  metric: string;
  reason: string;
  action: string;
  evidence: 'strong' | 'moderate' | 'weak';
}
export interface AiAnswer {
  aiEnabled: boolean;
  generated: boolean;
  answer: string;
  sources: string[];
}
export type AiContentKind = 'description' | 'caption' | 'email' | 'faq' | 'reminder' | 'social';
export interface AiContentDraftInput {
  kind: AiContentKind;
  title: string;
  city?: string;
  venue?: string;
  dateText?: string;
  highlights?: string;
}
export interface AiContentDraft {
  aiEnabled: boolean;
  generated: boolean;
  label: string;
  drafts: string[];
}
export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string | null;
  timeoutMs: number;
  maxRetries: number;
  prompts: { key: string; version: string }[];
}
export interface AiUsageSummary {
  windowDays: number;
  totalRequests: number;
  byStatus: Record<string, number>;
  errorCount: number;
  fallbackRate: number;
  avgLatencyMs: number;
  estimatedCostMinor: number;
  safetyRedactions: number;
  byFeature: { feature: string; count: number }[];
}
export interface RiskSignal {
  key: string;
  severity: 'low' | 'medium' | 'high';
  title: string;
  evidence: string;
  recommendation: string;
}
export interface AiRiskReport {
  windowLabel: string;
  windowDays: number;
  signals: RiskSignal[];
}

export interface AnalyticsRevenue {
  grossMinor: number;
  bookingFeesMinor: number;
  paymentFeesMinor: number;
  organizerFeesMinor: number;
  discountMinor: number;
  netMinor: number;
  confirmedBookings: number;
}
export interface OrganizerAnalytics {
  organizationId: string;
  attendance: { issued: number; checkedIn: number; checkInRate: number };
  conversion: { total: number; confirmed: number; rate: number };
  repeatVisitors: { totalCustomers: number; repeatCustomers: number; rate: number };
  topTicketType: { name: string; quantity: number } | null;
  capacity: { sold: number; capacity: number; utilization: number };
  /** Present only for OWNER/MANAGER + platform admins. */
  revenue?: AnalyticsRevenue;
  refunds?: { count: number; amountMinor: number; refundRate: number };
  coupons?: { redemptions: number; discountMinor: number };
  topEvents?: { eventId: string; title: string; grossMinor: number; bookings: number }[];
}
export interface VenueAnalytics {
  venue: { id: string; name: string; city: string };
  utilization: { events: number; sessions: number };
  occupancy: {
    soldSeats: number;
    totalSeats: number;
    soldGeneralAdmission: number;
    totalGeneralAdmission: number;
    sold: number;
    capacity: number;
    occupancyRate: number;
  };
  revenue: AnalyticsRevenue;
}
export interface CustomerAnalytics {
  bookings: { upcoming: number; past: number; total: number };
  favoriteOrganizers: { id: string; name: string; bookings: number }[];
  favoriteVenues: { id: string; name: string; city: string; bookings: number }[];
  collectionsNote: string;
}
export interface PlatformAnalytics {
  gmvMinor: number;
  platformRevenueMinor: number;
  bookings: number;
  moviesCount: number;
  eventsCount: number;
  retention: { totalCustomers: number; repeatCustomers: number; rate: number };
  funnel: { created: number; confirmed: number; checkedIn: number };
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
  reference: string | null;
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

// ─── Runtime payment configuration (admin) ───

export type PaymentEnvValue = 'LOCAL' | 'DEV' | 'QA' | 'UAT' | 'STAGING' | 'PRODUCTION';
export type PaymentProviderModeValue = 'DUMMY' | 'TEST' | 'LIVE';

export interface MerchantAccountRow {
  id: string;
  label: string;
  country: string | null;
  currency: string | null;
  merchantIdRef: string | null;
  active: boolean;
}
export interface PaymentProviderConfigRow {
  id: string;
  env: PaymentEnvValue;
  provider: string;
  enabled: boolean;
  mode: PaymentProviderModeValue;
  publicKey: string | null;
  secretKeyRef: string | null;
  webhookSecretRef: string | null;
  apiBaseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  priority: number;
  merchantAccounts: MerchantAccountRow[];
}
export interface PaymentRouteRow {
  id: string;
  env: PaymentEnvValue;
  country: string;
  currency: string;
  method: string;
  provider: string;
  failoverProvider: string | null;
  priority: number;
  active: boolean;
}
export interface PaymentConfigIssue {
  severity: 'ERROR' | 'WARN';
  provider?: string;
  message: string;
}
export interface PaymentConfigOverview {
  env: PaymentEnvValue;
  activeEnv: PaymentEnvValue;
  providers: PaymentProviderConfigRow[];
  routes: PaymentRouteRow[];
  validation: { ok: boolean; issues: PaymentConfigIssue[] };
}
export interface PaymentConfigPatch {
  enabled?: boolean;
  mode?: PaymentProviderModeValue;
  publicKey?: string | null;
  secretKeyRef?: string | null;
  webhookSecretRef?: string | null;
  apiBaseUrl?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  priority?: number;
}
export interface PaymentRouteInput {
  country: string;
  currency: string;
  method: string;
  provider: string;
  failoverProvider?: string | null;
  priority?: number;
  active?: boolean;
}
export interface TestConnectionResult {
  healthy: boolean;
  mode?: string;
  message?: string;
}
export interface ProviderHealthRow {
  provider: string;
  healthy: boolean;
  mode?: string;
  message?: string;
}
export interface ProviderHealthReport {
  activeEnv: PaymentEnvValue;
  providers: ProviderHealthRow[];
}
export interface ReconciliationReport {
  window: { from: string; to: string };
  checked: number;
  matched: number;
  mismatched: number;
  unverifiable: number;
  mismatches: {
    bookingId: string;
    provider: string;
    providerRef: string;
    ourStatus: string;
    providerStatus: string;
    ourAmountMinor: number;
    providerAmountMinor: number;
  }[];
}
export interface SettlementLine {
  provider: string;
  currency: string;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
  count: number;
}
export interface ReadinessCheck {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
}
export interface ProviderReadiness {
  provider: string;
  ok: boolean;
  checks: ReadinessCheck[];
}
export interface LiveReadinessReport {
  env: PaymentEnvValue;
  ok: boolean;
  global: ReadinessCheck[];
  providers: ProviderReadiness[];
}

// ─── Finance reconciliation (admin) ───

export type DiscrepancyStatusValue = 'OPEN' | 'ASSIGNED' | 'RESOLVED' | 'IGNORED';
export interface DiscrepancyRow {
  id: string;
  env: PaymentEnvValue;
  type: string;
  provider: string;
  entityRef: string;
  amountMinor: number | null;
  currency: string | null;
  detail: string | null;
  status: DiscrepancyStatusValue;
  assignedToUserId: string | null;
  resolutionNotes: string | null;
  createdAt: string;
}
export interface AgingBucket {
  bucket: string;
  count: number;
}

// ─── Merchant onboarding (admin) ───

export type OnboardingStatusValue =
  | 'DRAFT'
  | 'PENDING_CONFIGURATION'
  | 'PENDING_VERIFICATION'
  | 'TESTING'
  | 'READY_FOR_LIVE'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'REJECTED';

export interface MerchantOnboardingRow {
  id: string;
  env: PaymentEnvValue;
  organizationId: string | null;
  country: string;
  legalBusinessName: string;
  displayName: string;
  merchantType: string;
  settlementCurrency: string;
  provider: string;
  mode: PaymentProviderModeValue;
  accountIdentifier: string | null;
  secretKeyRef: string | null;
  webhookSecretRef: string | null;
  publicKey: string | null;
  settlementSchedule: string;
  payoutDestinationRef: string | null;
  webhookEndpointStatus: string;
  verificationStatus: string;
  termsAcceptedAt: string | null;
  status: OnboardingStatusValue;
  merchantAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OnboardingChecklistItem {
  key: string;
  label: string;
  done: boolean;
  blocking: boolean;
}
export interface OnboardingDetail {
  record: MerchantOnboardingRow;
  checklist: OnboardingChecklistItem[];
  activationReady: boolean;
}
export interface CertificationStepRow {
  step: number;
  key: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail?: string;
  ref?: string;
}
export interface MerchantCertificationRow {
  id: string;
  env: PaymentEnvValue;
  provider: string;
  result: 'PASS' | 'PARTIAL' | 'FAIL';
  steps: CertificationStepRow[];
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  operator: string | null;
  createdAt: string;
}
export interface CreateOnboardingBody {
  env: PaymentEnvValue;
  organizationId?: string;
  country: string;
  legalBusinessName: string;
  displayName: string;
  merchantType?: string;
  settlementCurrency: string;
  provider: string;
  mode?: 'TEST' | 'LIVE';
}
export type OnboardingPatchBody = Partial<
  Pick<
    MerchantOnboardingRow,
    | 'country'
    | 'legalBusinessName'
    | 'displayName'
    | 'merchantType'
    | 'settlementCurrency'
    | 'provider'
    | 'accountIdentifier'
    | 'secretKeyRef'
    | 'webhookSecretRef'
    | 'publicKey'
    | 'settlementSchedule'
    | 'payoutDestinationRef'
  >
>;

// ─── Environment promotion (admin) ───

export type PromotionStatusValue = 'PENDING_APPROVAL' | 'APPROVED' | 'APPLIED' | 'REJECTED';
export interface PromotionCheck {
  key: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail?: string;
}
export interface PromotionReportResult {
  fromEnv: PaymentEnvValue;
  toEnv: PaymentEnvValue;
  provider: string;
  ok: boolean;
  checks: PromotionCheck[];
}
export interface PromotionRequestRow {
  id: string;
  provider: string;
  fromEnv: PaymentEnvValue;
  toEnv: PaymentEnvValue;
  status: PromotionStatusValue;
  requiredApprovals: number;
  report: PromotionReportResult;
  approvals: { userId: string; at: string; note?: string }[];
  rejectedReason: string | null;
  appliedAt: string | null;
  createdAt: string;
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

// ─── Support / Customer Success ───

export type FeedbackKindValue =
  'CONTACT' | 'BUG' | 'FEATURE' | 'GENERAL' | 'CSAT' | 'ORGANIZER_CSAT';
export type FeedbackStatusValue = 'OPEN' | 'TRIAGED' | 'CLOSED';

/** Payload for `api.support.submit`. */
export interface FeedbackSubmission {
  kind: FeedbackKindValue;
  email?: string;
  subject?: string;
  message: string;
  rating?: number;
  metadata?: Record<string, unknown>;
}

/** A support submission row as returned by the admin inbox. */
export interface FeedbackRow {
  id: string;
  kind: FeedbackKindValue;
  status: FeedbackStatusValue;
  email: string | null;
  subject: string | null;
  message: string;
  rating: number | null;
  metadata: Record<string, unknown> | null;
  userId: string | null;
  user: { email: string; fullName: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizerProfile {
  id: string;
  name: string;
  verified: boolean;
  memberSince: string;
  eventCount: number;
  description?: string | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  twitterUrl?: string | null;
  instagramUrl?: string | null;
  facebookUrl?: string | null;
  events: PublicEventCard[];
}

// ─── Internal operations console ───

export type OpsCheckStatus = 'up' | 'down';
export interface OpsDependencyCheck {
  status: OpsCheckStatus;
  latencyMs: number;
  error?: string;
}
export interface OpsQueueCheck {
  status: 'ok' | 'degraded' | 'down';
  latencyMs: number;
  failed?: number;
  error?: string;
}
export interface OpsHealth {
  status: 'ok' | 'degraded';
  database: OpsDependencyCheck;
  redis: OpsDependencyCheck;
  queue: OpsQueueCheck;
  storage: { status: 'not_configured' };
  uptime: number;
  nodeEnv: string;
}

export interface OpsQueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}
export interface OpsRepeatableJob {
  name: string;
  every: string | null;
  pattern: string | null;
  next: string | null;
}
export interface OpsQueues {
  name: string;
  counts: OpsQueueCounts;
  repeatable: OpsRepeatableJob[];
}
export interface OpsFailedJob {
  id: string | null;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: string | null;
}

export interface MaintenanceState {
  enabled: boolean;
  message?: string;
}

export interface OpsFlag {
  key: string;
  enabled: boolean;
}
export interface OpsFlags {
  flags: OpsFlag[];
  note: string;
}

// ─── Business-operations reports ───

/** Optional inclusive date range; both default server-side to the last 30 days. */
export type ReportRange = {
  from?: string;
  to?: string;
};
/** Reports that support a `?format=csv` export. */
export type ReportCsvName = 'daily-revenue' | 'organizer-revenue' | 'refunds' | 'settlement';

export interface DailyRevenuePoint {
  day: string;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
  bookings: number;
}
export interface DailyRevenueReport {
  from: string;
  to: string;
  totals: {
    grossMinor: number;
    platformFeesMinor: number;
    refundsMinor: number;
    netMinor: number;
    bookings: number;
  };
  series: DailyRevenuePoint[];
}
export interface OrganizerRevenueRow {
  organizationId: string;
  organizationName: string;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
  bookings: number;
}
export interface OrganizerRevenueReport {
  from: string;
  to: string;
  organizers: OrganizerRevenueRow[];
}
export interface SettlementOrgRow {
  organizationId: string;
  organizationName: string;
  outstandingMinor: number;
  paidMinor: number;
  outstandingCount: number;
  paidCount: number;
}
export interface SettlementReport {
  totals: { outstandingMinor: number; paidMinor: number; payoutCount: number };
  byOrg: SettlementOrgRow[];
  payouts: Payout[];
}
export interface RefundReport {
  from: string;
  to: string;
  totals: { count: number; amountMinor: number };
  byStatus: { status: string; count: number; amountMinor: number }[];
  byDay: { day: string; count: number; amountMinor: number }[];
}
export interface PlatformFeesReport {
  from: string;
  to: string;
  totals: { platformFeesMinor: number };
  series: { day: string; feesMinor: number }[];
}
export interface TaxReport {
  from: string;
  to: string;
  taxModelled: false;
  taxCollectedMinor: number;
  note: string;
  taxableBaseMinor: number;
  grossMinor: number;
  platformFeesMinor: number;
}
export interface TopExperienceRow {
  eventId: string;
  title: string;
  experienceType: string;
  movieTitle: string | null;
  bookings: number;
  grossMinor: number;
}
export interface TopExperiencesReport {
  from: string;
  to: string;
  experiences: TopExperienceRow[];
}
export interface GrowthReport {
  from: string;
  to: string;
  retention: { totalCustomers: number; repeatCustomers: number; rate: number };
  newUsers: { day: string; count: number }[];
  newBookings: { day: string; count: number }[];
  newOrganizers: { day: string; count: number }[];
}

export interface PaymentHealthReport {
  from: string;
  to: string;
  overallSuccessRate: number | null;
  providers: {
    provider: string;
    succeeded: number;
    failed: number;
    pending: number;
    successRate: number | null;
  }[];
}

// ── Theater operations ────────────────────────────────────────────────────────────

/**
 * Why a seat was withdrawn from sale.
 *
 * Mirrors the server enum exactly. Defining a different set here is how a UI ends up
 * offering an option the API will always refuse.
 */
export type SeatOverrideKind =
  'MANUAL_BLOCK' | 'MAINTENANCE' | 'HOUSE' | 'VIP' | 'COMPANION' | 'EMERGENCY';

export type HousePurpose = 'COMPLIMENTARY' | 'PRESS' | 'SPONSOR' | 'MANAGEMENT' | 'TECHNICAL';

export interface OccupancySnapshot {
  sessionId: string;
  movieTitle: string | null;
  screenId: string | null;
  screenName: string | null;
  cinemaId: string | null;
  cinemaName: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  seatsTotal: number;
  capacity: number;
  sold: number;
  held: number;
  available: number;
  blocked: number;
  blockedByKind: { kind: SeatOverrideKind; label: string; count: number }[];
  house: number;
  /** Server-computed. Never recomputed client-side — see LIVE-OPERATIONS.md. */
  occupancyPercent: number | null;
  revenueMinor: number;
  pendingPaymentMinor: number;
  currency: string;
  salesPacePerHour: number | null;
  observedAt: string;
}

export interface LiveSeat {
  seatId: string;
  label: string;
  row: string;
  colIndex: number;
  /** SEAT | GAP | WHEELCHAIR | COMPANION — a property of the layout version. */
  kind: string;
  categoryId: string;
  status: string;
  overrideKind: SeatOverrideKind | null;
  overrideReason: string | null;
  overrideBy: string | null;
  overrideAt: string | null;
  overrideExpiresAt: string | null;
  heldNow: boolean;
}

export interface LiveSeatMap {
  sessionId: string;
  movieTitle: string | null;
  screenName: string | null;
  cinemaName: string | null;
  startsAt: string;
  status: string;
  seatMapId: string | null;
  categories: { id: string; name: string; colorHex: string | null; basePriceMinor: number }[];
  observedAt: string;
  sections: { name: string; rows: { label: string; seats: LiveSeat[] }[] }[];
}

export interface BlockSeatsBody {
  seatIds: string[];
  kind: SeatOverrideKind;
  reason: string;
  expiresAt?: string;
  housePurpose?: HousePurpose;
}

export interface ReleaseSeatsBody {
  seatIds: string[];
  reason: string;
  /** Required to release an EMERGENCY block. */
  force?: boolean;
}

export interface SeatOverrideResult {
  sessionId: string;
  applied: number;
  refused: number;
  seats: { seatId: string; seatLabel: string; applied: boolean; reason?: string; code?: string }[];
  warnings: string[];
}

export interface SeatOverrideReport {
  cinemaId: string;
  from: string;
  to: string;
  totalActions: number;
  seatsBlocked: number;
  seatsReleased: number;
  byKind: { kind: SeatOverrideKind; label: string; count: number }[];
  byReason: { reason: string; count: number }[];
  byOperator: { actor: string; count: number }[];
  timeline: {
    at: string;
    action: string;
    actor: string;
    sessionId: string | null;
    showStartsAt: string | null;
    movieTitle: string | null;
    screenId: string | null;
    screenName: string | null;
    kind: SeatOverrideKind | null;
    housePurpose: string | null;
    reason: string | null;
    seatCount: number;
    seats: string[];
    expiresAt: string | null;
  }[];
  /** True when the window hit the server cap — the UI must say so. */
  truncated: boolean;
}

export type SeatLayoutStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface SeatLayoutSummary {
  id: string;
  screenId: string;
  name: string | null;
  version: number;
  status: SeatLayoutStatus;
  effectiveFrom: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  clonedFromId: string | null;
  seatCount: number;
  capacity: number;
  futureShows: number;
  historicalShows: number;
  createdAt: string;
}

export interface UpdateSeatLayoutBody {
  name?: string;
  sections: {
    name: string;
    categoryName: string;
    colorHex?: string;
    basePriceMinor: number;
    rowLabels: string[];
    seatsPerRow: number;
    seatKinds?: Record<string, 'SEAT' | 'GAP' | 'WHEELCHAIR' | 'COMPANION'>;
  }[];
}

export interface LayoutComparison {
  addedSeats: { seat: string; to?: { categoryName: string; kind: string } }[];
  removedSeats: { seat: string; from?: { categoryName: string; kind: string } }[];
  changedSeats: {
    seat: string;
    from?: { categoryName: string; kind: string };
    to?: { categoryName: string; kind: string };
  }[];
  unchangedCount: number;
  capacityDelta: number;
  from: SeatLayoutSummary;
  to: SeatLayoutSummary;
}

// ── Pilot readiness ───────────────────────────────────────────────────────────────

export type PilotReadinessLevel = 'READY' | 'WARNING' | 'BLOCKED';

export interface PilotReadinessCheck {
  section: string;
  /** Stable identifier. Map this to an icon or a link; never match on the message. */
  code: string;
  level: PilotReadinessLevel;
  /** One sentence an operator can act on, written by the server. */
  message: string;
  /** Where to go to fix it, relative to the organizer app. Null when there is nowhere useful. */
  fixPath: string | null;
}

export interface PilotReadinessReport {
  cinemaId: string;
  cinemaName: string;
  timezone: string;
  overall: PilotReadinessLevel;
  blockers: number;
  warnings: number;
  sections: { section: string; level: PilotReadinessLevel; checks: PilotReadinessCheck[] }[];
  evaluatedAt: string;
}
