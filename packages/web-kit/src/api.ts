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

/**
 * Unified experience discovery. Callable for the legacy combined payload
 * (`api.discovery()`), with `.sections(city?)` for the composed strategy feed.
 */
const discovery = Object.assign(() => request<Discovery>('/public/discovery', { auth: false }), {
  sections: (city?: string) =>
    request<{ sections: DiscoverySection[] }>(`/public/discovery/sections${qs({ city })}`, {
      auth: false,
    }).then((r) => r.sections),
});

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

  analytics: {
    /** Whole-org organizer dashboard in one aggregate round (replaces per-event fan-out). */
    organizer: (organizationId: string) =>
      request<OrganizerAnalytics>(`/analytics/organizer${qs({ organizationId })}`),
    venue: (venueId: string) => request<VenueAnalytics>(`/analytics/venue/${venueId}`),
    customer: () => request<CustomerAnalytics>('/analytics/customer'),
  },

  admin: {
    dashboard: () => request<AdminDashboard>('/admin/dashboard'),
    platformAnalytics: () => request<PlatformAnalytics>('/admin/analytics/platform'),
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
  reference: string | null;
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
  /** Present only for OWNER/MANAGER + platform admins. */
  revenue?: AnalyticsRevenue;
  refunds?: { count: number; amountMinor: number; refundRate: number };
  coupons?: { redemptions: number; discountMinor: number };
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
}
