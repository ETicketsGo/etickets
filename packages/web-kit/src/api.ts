import type {
  SpaceKind,
  EventSaleState,
  SaleReason,
  SaleStateKind,
  CinemaFormat,
  CinemaPricingPolicyStatus,
  ClimateType,
  LocalBodyType,
  MaintenanceTreatment,
  OnlineFeePolicy,
  PricingComplianceStatus,
  ApiError,
  AuthTokens,
  MfaChallengeResponse,
  GuestBookingClaim,
  GuestBookingView,
  GuestReceiptsView,
  ManifestEntry,
  ManifestMeta,
  QueuedCheckIn,
  ReconcileOutcome,
  RevocationDelta,
  EventImageVariantName,
  FocalPoint,
  VenueTemplateKey as SharedVenueTemplateKey,
  PayoutProviderEntry,
  PayoutProviderSummary,
  LayoutDocument,
  LayoutDocumentCounts,
} from '@eticketsgo/shared-types';

/*
  The guest view is declared once, in shared-types, and re-exported here.

  It was declared twice, and the two copies had already drifted: this one promised a
  reference, a hold expiry, a time zone and a venue name that the server returns as null.
  A page built against the promise renders the word null to a buyer.
*/
export type {
  QueuedCheckIn,
  RevocationDelta,
  GuestBookingView,
  GuestBookingEvent,
  GuestBookingBuyer,
  GuestBookingTotals,
  GuestBookingItem,
  GuestBookingTicket,
  /*
    Guest self-service, declared where the server declares it for the same reason as the view
    above: a second copy of "what a document row carries" is a copy that drifts, and the thing
    that drifts is an amount printed at a buyer.
  */
  GuestReceiptDocument,
  GuestReceiptsView,
  GuestBookingClaim,
  PayoutProviderEntry,
  PayoutProviderSummary,
} from '@eticketsgo/shared-types';

import { markApiReachable, markApiUnreachable } from './connectivity';
import type {
  AdminBillingAccountDetail,
  AdminBillingMetrics,
  AdminBillingPlan,
  AdminBillingPrice,
  AdminSubscriptionPage,
  BillingCheckoutSession,
  OrganizationEntitlements,
  OrganizerBilling,
  OrganizerInvoiceRow,
} from './billing-types';
import type {
  CrmActivity,
  CrmActivityReport,
  CrmAgingReport,
  CrmConversionReport,
  CrmCsvReport,
  CrmDuplicateMatch,
  CrmEmployeeReport,
  CrmFollowUp,
  CrmFunnel,
  CrmGroupRow,
  CrmImportResult,
  CrmLead,
  CrmLeadDetail,
  CrmLeadFilters,
  CrmMe,
  CrmOrganizationMatch,
  CrmOverview,
  CrmReportFilters,
  CrmTeam,
} from './crm-types';

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

/**
 * A cookie that says only "somebody is signed in here". Never a credential.
 *
 * ── WHY THE SERVER NEEDS TO KNOW AT ALL ────────────────────────────────────────────
 * Tokens live in `localStorage`, which a server render cannot see, so the shell and the home
 * page both started from `useState(false)` and corrected themselves in an effect. A signed-in
 * customer therefore got the marketing landing and the signed-out header on the FIRST PAINT of
 * every page load, for as long as hydration took - reported as "I can see the regular landing
 * page for just micro seconds".
 *
 * ── WHY A COOKIE AND WHY THIS ONE ──────────────────────────────────────────────────
 * A cookie is the only thing the client holds that a server render is given. This one carries
 * `1` and nothing else: no token, no id, no email. It is a HINT used to pick which shell to
 * draw, never to authorise anything - every request is still judged on the bearer token, and a
 * forged hint buys an attacker a different-looking header and no access whatsoever.
 *
 * Not `HttpOnly`, because the code that knows the session changed is this file, in the browser.
 * `SameSite=Lax` so it is not sent on cross-site requests, and no `Secure` on localhost because
 * a cookie that will not set in development is a cookie nobody tests.
 */
const SESSION_HINT = 'etg_session';

function writeSessionHint(signedIn: boolean): void {
  if (typeof document === 'undefined') return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = signedIn
    ? `${SESSION_HINT}=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
    : `${SESSION_HINT}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

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
    // Written beside the tokens, so the hint cannot drift from the thing it hints at.
    writeSessionHint(true);
    notifyTokenChange();
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    writeSessionHint(false);
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

/**
 * An API-served asset (an event image) as a URL a browser can load.
 *
 * The API returns a PATH, not a URL, because it cannot know which host a given client reaches
 * it on — the same event is served to the storefront, the organizer console and the app.
 */
export function apiAssetUrl(path: string | null | undefined): string | null {
  return path ? `${API_URL}${path}` : null;
}

/** The API's code for a session that a team removal ended (see JwtStrategy). */
export const ACCESS_REMOVED_CODE = 'ACCESS_REMOVED';
/**
 * The API's code for an organizer API refused because the ORGANIZATION is suspended (owner
 * decision, 2026-10-26). The organizer console shows its suspended screen on it.
 */
export const ORGANIZATION_SUSPENDED_CODE = 'ORGANIZATION_SUSPENDED';
/** A team invitation opened while signed in as a different account than the one invited. */
export const INVITATION_WRONG_ACCOUNT_CODE = 'INVITATION_WRONG_ACCOUNT';
/** The account must confirm its email address (a code sent there) before this step. */
export const EMAIL_NOT_VERIFIED_CODE = 'EMAIL_NOT_VERIFIED';

/*
  An organization was suspended while its console was open. The console registers ONE handler
  (it refetches the organization list, which then says SUSPENDED and shows the suspended screen).
  The error still reaches the caller; nothing is retried.
*/
let organizationSuspendedHandler: ((organizationId: string | null) => void) | null = null;
export function setOrganizationSuspendedHandler(
  fn: ((organizationId: string | null) => void) | null,
): void {
  organizationSuspendedHandler = fn;
}
const SIGNED_OUT_NOTICE_KEY = 'etg_signed_out_notice';

/*
  Why the last session ended, for the sign-in page to say once.

  Session storage, not memory: the console reaches its sign-in page by client navigation in
  one case and by a full reload in another, and the sentence has to survive both. Never a
  credential, only the API's own plain sentence.
*/
function rememberSignedOutNotice(message: string | undefined): void {
  if (typeof window === 'undefined' || !message) return;
  try {
    sessionStorage.setItem(SIGNED_OUT_NOTICE_KEY, message);
  } catch {
    // Storage blocked: the person still reaches the sign-in page, just without the reason.
  }
}

/** Read and forget why the last session ended. Null when it ended in the ordinary way. */
export function takeSignedOutNotice(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const message = sessionStorage.getItem(SIGNED_OUT_NOTICE_KEY);
    sessionStorage.removeItem(SIGNED_OUT_NOTICE_KEY);
    return message;
  } catch {
    return null;
  }
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
  _steppedUp?: boolean;
  _humanChecked?: boolean;
}

/*
  Step-up: the API refuses a handful of sensitive back-office actions (moving money, changing who
  has power) with MFA_STEP_UP_REQUIRED when the session's last second-factor check is too old.
  The admin console registers ONE handler that asks for a fresh code; the request is then
  repeated once. Anywhere else (customer and organizer consoles) no handler is registered and the
  error surfaces as it always did.
*/
let stepUpHandler: (() => Promise<boolean>) | null = null;
export function setStepUpHandler(fn: (() => Promise<boolean>) | null): void {
  stepUpHandler = fn;
}

/*
  MFA_ENROLLMENT=deferred: a sensitive action by staff with no authenticator comes back
  MFA_SETUP_REQUIRED (they can fix it: set one up) or MFA_NOT_CONFIGURED (the server has no MFA
  key; only an operator can fix it). The admin console registers ONE handler that explains this
  and offers the setup screen. It is told, not asked: the request is NOT repeated and the error
  still reaches the caller, so the page shows its own failure state as well.
*/
export type MfaSetupCode = 'MFA_SETUP_REQUIRED' | 'MFA_NOT_CONFIGURED';
let mfaSetupHandler: ((code: MfaSetupCode, message: string) => void) | null = null;
export function setMfaSetupHandler(fn: ((code: MfaSetupCode, message: string) => void) | null) {
  mfaSetupHandler = fn;
}

/*
  The human check (Cloudflare Turnstile). On a few public routes (sign-in, sign-up, phone codes,
  password reset, guest checkout and lookup, the support form, organizer sign-up) the API can
  answer 428 HUMAN_CHECK_REQUIRED, or 403 HUMAN_CHECK_FAILED for a token that proved nothing.
  Both carry the action and the public site key. The app registers ONE handler (see
  `HumanCheckProvider`) that draws the widget and returns a token, or null when the person
  cancels or the widget cannot load; the request is then repeated ONCE with the token in a
  header. With no handler, or with the check switched off on the API, nothing changes.
*/
export const HUMAN_CHECK_HEADER = 'x-turnstile-token';
export const HUMAN_CHECK_REQUIRED_CODE = 'HUMAN_CHECK_REQUIRED';
export const HUMAN_CHECK_FAILED_CODE = 'HUMAN_CHECK_FAILED';

export interface HumanCheckChallenge {
  /** The Turnstile action the API will check the token against. */
  action: string;
  /** Public widget key for this environment. Null when the API did not say. */
  siteKey: string | null;
}

let humanCheckHandler: ((challenge: HumanCheckChallenge) => Promise<string | null>) | null = null;
export function setHumanCheckHandler(
  fn: ((challenge: HumanCheckChallenge) => Promise<string | null>) | null,
): void {
  humanCheckHandler = fn;
}

/** The challenge in an API refusal, or null when the refusal is something else. */
export function humanCheckChallengeFrom(
  status: number,
  body: Pick<ApiError, 'code' | 'details'> | null | undefined,
): HumanCheckChallenge | null {
  const asked =
    (status === 428 && body?.code === HUMAN_CHECK_REQUIRED_CODE) ||
    (status === 403 && body?.code === HUMAN_CHECK_FAILED_CODE);
  if (!asked) return null;
  const details = (body?.details ?? {}) as Record<string, unknown>;
  const action = typeof details.action === 'string' ? details.action : '';
  const siteKey = typeof details.siteKey === 'string' && details.siteKey ? details.siteKey : null;
  return action ? { action, siteKey } : null;
}

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers = new Headers(options.headers);
  // A file upload sets its own multipart boundary; forcing JSON onto it makes the body unreadable.
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isForm) headers.set('content-type', 'application/json');
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

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  /*
    A team removal ended this session (the API says so with its own code). Refreshing cannot
    help - the removal revoked the refresh token too - so the session is closed here, and the
    API's sentence ("You no longer have access to ...") is kept for the sign-in page to show.
    Without it the person's open tab carried on as a customer and landed on "Set up your
    organization".
  */
  if (res.status === 401 && (data as ApiError | null)?.code === ACCESS_REMOVED_CODE) {
    if (tokenStore.access || tokenStore.refresh) {
      rememberSignedOutNotice((data as ApiError).message);
      tokenStore.clear();
    }
  } else if (
    // Attempt a single transparent refresh on auth failure.
    res.status === 401 &&
    options.auth !== false &&
    !options._retried &&
    tokenStore.refresh
  ) {
    if (await tryRefresh()) {
      return request<T>(path, { ...options, _retried: true });
    }
  }

  if (!res.ok) {
    const err = data as ApiError;
    const challenge = humanCheckChallengeFrom(res.status, err);
    if (challenge && humanCheckHandler && !options._humanChecked) {
      const token = await humanCheckHandler(challenge);
      if (token) {
        // Only once: a second refusal surfaces as an error, so a broken widget cannot loop.
        const retryHeaders = new Headers(options.headers);
        retryHeaders.set(HUMAN_CHECK_HEADER, token);
        return request<T>(path, { ...options, headers: retryHeaders, _humanChecked: true });
      }
    }
    if (
      res.status === 403 &&
      err?.code === 'MFA_STEP_UP_REQUIRED' &&
      stepUpHandler &&
      !options._steppedUp &&
      (await stepUpHandler())
    ) {
      return request<T>(path, { ...options, _steppedUp: true });
    }
    if (
      res.status === 403 &&
      (err?.code === 'MFA_SETUP_REQUIRED' || err?.code === 'MFA_NOT_CONFIGURED') &&
      mfaSetupHandler
    ) {
      mfaSetupHandler(err.code, err.message ?? '');
    }
    if (res.status === 403 && err?.code === ORGANIZATION_SUSPENDED_CODE) {
      const id = (err.details as { organizationId?: unknown } | undefined)?.organizationId;
      organizationSuspendedHandler?.(typeof id === 'string' ? id : null);
    }
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
  // The server's name when it gives one (it knows the event and the date); ours otherwise.
  const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = named ?? filename;
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
/*
  Both calls take the visitor's place. They used to take none (the combined payload) or only a
  city (the section feed), so Explore showed every country to a visitor who had not picked a
  city - the storefront's location rule broken on exactly one page. Pass `cityScope(preference)`.
*/
const discovery = Object.assign(
  (place?: { city?: string; country?: string }) =>
    request<Discovery>(`/public/discovery${qs({ ...place })}`, { auth: false }),
  {
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
    sectionFeed: (place?: { city?: string; country?: string }) =>
      request<SectionFeed>(`/public/discovery/sections${qs({ ...place })}`, { auth: false }),
  },
);

/*
  Only a back-office account is ever answered with a second-factor challenge instead of tokens.
  The admin console's sign-in handles it; every other caller of `login` / `verifyPhoneCode` is a
  customer or organizer surface, and storing "undefined" as a session there would be worse than
  a clear refusal.
*/
/**
 * GET /capabilities: feature flags, plus what this deployment can reach by text message.
 *
 * `phoneSignInCountries` is absent from an API older than it; a caller treats absent as "not
 * known" and keeps its previous behaviour rather than as "nowhere".
 */
export type PlatformCapabilities = Record<
  string,
  boolean | string | string[] | null | undefined
> & {
  phoneSignIn?: boolean;
  phoneSignInCountries?: string[];
  /** The human check's mode on this deployment, and its public widget key (null when off). */
  humanCheckMode?: 'off' | 'adaptive' | 'always';
  humanCheckSiteKey?: string | null;
};

function refuseChallenge<T extends object>(r: T | MfaChallengeResponse): T {
  if ('mfaRequired' in r && r.mfaRequired) {
    throw new ApiRequestError(
      'MFA_REQUIRED',
      'Back-office accounts sign in at the admin console.',
      undefined,
      undefined,
      401,
    );
  }
  return r as T;
}

export interface MfaStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  verified: boolean;
}

export interface MfaEnrollment {
  secret: string;
  otpauthUri: string;
  /** SVG drawn by our own API; never fetched from a third-party QR service. */
  qrSvg: string;
}

export const api = {
  request,

  /** Where the caller is, and where we can sell them something. Both are public. */
  location: {
    /**
     * Search cities with something on sale.
     *
     * A search, not a listing: the picker sends a prefix and a small limit as the customer
     * types, so this response is the same size whether the platform sells in six cities or
     * six hundred. Called with no arguments it still returns everything, which is only
     * appropriate for a caller that genuinely needs the lot.
     */
    cities: (params?: {
      q?: string;
      country?: string;
      limit?: number;
      anywhere?: boolean;
      prefer?: string;
    }) =>
      request<SellableCity[]>(
        `/public/location/cities${qs({
          q: params?.q,
          country: params?.country,
          limit: params?.limit,
          // Real places with nothing on sale yet, after the sellable ones. Search only.
          anywhere: params?.anywhere ? '1' : undefined,
          prefer: params?.prefer,
        })}`,
        { auth: false },
      ),
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
      request<AuthTokens | MfaChallengeResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }).then((r) => refuseChallenge<AuthTokens>(r)),
    /** The admin console's sign-in: tokens, or a second-factor challenge to complete. */
    signIn: (body: { email: string; password: string }) =>
      request<AuthTokens | MfaChallengeResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }),
    /** Second step of an admin sign-in: a challenge plus an authenticator or recovery code. */
    mfaVerify: (body: { challengeToken: string; code?: string; recoveryCode?: string }) =>
      request<AuthTokens>('/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }),
    mfaStatus: () => request<MfaStatus>('/auth/mfa/status'),
    mfaEnrollStart: (password: string) =>
      request<MfaEnrollment>('/auth/mfa/enroll/start', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    /** Finishes enrollment. The recovery codes in the reply are shown once and never again. */
    mfaEnrollConfirm: (code: string) =>
      request<AuthTokens & { recoveryCodes: string[] }>('/auth/mfa/enroll/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    /** Re-confirm for a sensitive action; replaces the access token, keeps the session. */
    mfaStepUp: (body: { code?: string; recoveryCode?: string }) =>
      request<{ accessToken: string }>('/auth/mfa/step-up', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    mfaRegenerateCodes: () =>
      request<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes/regenerate', {
        method: 'POST',
      }),
    mfaReplaceDevice: () =>
      request<{ success: boolean }>('/auth/mfa/replace-device', { method: 'POST' }),

    /**
     * Phone sign-in, in two steps.
     *
     * The number is sent as typed — the server normalises it, and a second normaliser here
     * would be a second place to disagree about what somebody's phone number is.
     */
    requestPhoneCode: (phone: string) =>
      request<{ sent: true; expiresInMinutes: number }>('/auth/phone/request-code', {
        method: 'POST',
        body: JSON.stringify({ phone }),
        auth: false,
      }),
    /**
     * Exchanges a code for a session, creating the account when the number is new.
     *
     * `signUp` is what the Mobile tab of the sign-up page adds: a name for a new account and,
     * for a US number, the text-message agreement. Sign-in sends neither.
     */
    verifyPhoneCode: (
      phone: string,
      code: string,
      signUp?: { fullName: string; smsConsent?: true; country?: string },
    ) =>
      request<(AuthTokens & { isNewAccount: boolean }) | MfaChallengeResponse>(
        '/auth/phone/verify',
        {
          method: 'POST',
          body: JSON.stringify({ phone, code, ...signUp }),
          auth: false,
        },
      ).then((r) => refuseChallenge<AuthTokens & { isNewAccount: boolean }>(r)),
    /**
     * The organizer console's phone sign-in: tokens, or a back-office account's second-factor
     * challenge to complete there - exactly what `signIn` answers for a password. Same route and
     * the same human check as the storefront's `verifyPhoneCode`; only the answer is not refused.
     */
    verifyPhoneCodeOrChallenge: (phone: string, code: string) =>
      request<(AuthTokens & { isNewAccount: boolean }) | MfaChallengeResponse>(
        '/auth/phone/verify',
        { method: 'POST', body: JSON.stringify({ phone, code }), auth: false },
      ),
    /**
     * A one-time code that carries THIS signed-in session to a console (see the API's
     * handoff.service.ts). The reply is a code, never a token; it lives 60 seconds and works once.
     */
    createHandoff: (audience: 'organizer') =>
      request<{ code: string; expiresInSeconds: number }>('/auth/handoff', {
        method: 'POST',
        body: JSON.stringify({ audience }),
      }),
    /** On the console: spend a handoff code for a session of its own, or an MFA challenge. */
    exchangeHandoff: (code: string, audience: 'organizer') =>
      request<AuthTokens | MfaChallengeResponse>('/auth/handoff/exchange', {
        method: 'POST',
        body: JSON.stringify({ code, audience }),
        auth: false,
      }),
    /** End every session this account has, on every device (POST /auth/logout-all). */
    logoutAll: () =>
      request<{ success: boolean; revoked: number }>('/auth/logout-all', { method: 'POST' }),
    /** A phone-only account adding an email address: send a code to it. */
    requestEmailCode: (email: string) =>
      request<{ sent: true; expiresInMinutes: number }>('/auth/email/request-code', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    /**
     * Confirm the address this account ALREADY has: a code is sent there. Asked before a team
     * invitation can be accepted, when the account has never proved its email.
     */
    requestEmailConfirmCode: () =>
      request<{ sent: true; expiresInMinutes: number; email: string }>(
        '/auth/email/confirm/request-code',
        { method: 'POST' },
      ),
    confirmEmail: (code: string) =>
      request<{ email: string; emailVerifiedAt: string }>('/auth/email/confirm/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    /** Prove the code; the address becomes the account's email. No password is involved. */
    verifyEmailCode: (email: string, code: string) =>
      request<{ email: string }>('/auth/email/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
      }),
    /**
     * Send a code to a number the SIGNED-IN customer wants to add to their account.
     *
     * `auth: true`, unlike the sign-in pair above: these two attach a number to the account the
     * token names, and the account is never taken from the body.
     */
    requestAttachPhoneCode: (phone: string) =>
      request<{ sent: true; expiresInMinutes: number }>('/auth/phone/attach/request-code', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      }),
    /** Prove the code and attach the number. Refuses a number already on another account. */
    attachPhone: (phone: string, code: string) =>
      request<{ phone: string }>('/auth/phone/attach/verify', {
        method: 'POST',
        body: JSON.stringify({ phone, code }),
      }),
    /**
     * Ask for a reset link. The reply is identical whether or not the address is known —
     * anything else would make this a way to discover who holds an account here.
     */
    forgotPassword: (email: string) =>
      request<{ message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
        auth: false,
      }),
    /** Set a new password with a reset token. Ends every session, including this one. */
    resetPassword: (token: string, password: string) =>
      request<{ success: boolean }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
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
    /** Where the person says they live, or null to clear it. Optional, never inferred. */
    updateResidence: (countryOfResidence: string | null) =>
      request<AuthUser & { countryOfResidence: string | null }>('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ countryOfResidence }),
      }),
    adminList: (params: PageParams & UserDirectoryFilters) =>
      request<Paged<AdminUser>>(`/users${qs(params)}`),
    directorySummary: () => request<UserDirectorySummary>('/users/directory-summary'),
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
  capabilities: () => request<PlatformCapabilities>('/capabilities', { auth: false }),

  reviews: {
    forEvent: (eventId: string) =>
      request<ReviewSummary>(`/public/reviews/${eventId}`, { auth: false }),
    mine: (eventId: string) => request<MyReview | null>(`/reviews/mine${qs({ eventId })}`),
    /**
     * Rate an event you have attended. For a film screening this rates the FILM: a second
     * rating through another cinema's listing updates your first rather than adding a vote.
     */
    create: (body: { eventId: string; rating: number; comment?: string }) =>
      request<MyReview>('/reviews', { method: 'POST', body: JSON.stringify(body) }),
    /** A film's rating across every cinema, one voice per viewer, with recent reviews. */
    forMovie: (slug: string) =>
      request<ReviewSummary>(`/public/reviews/movies/${slug}`, { auth: false }),
    /** Whether you can rate this film, which listing to rate it through, and your rating so far. */
    mineForMovie: (slug: string) => request<MyMovieReview>(`/reviews/movies/${slug}/mine`),
  },

  support: {
    /**
     * Submit a support/feedback item. Public — logged-out visitors can contact
     * or report. The bearer token is sent when present so the API can attach the
     * signed-in user; `auth` is left default so refresh-on-401 still applies.
     */
    submit: (body: FeedbackSubmission) =>
      request<{
        id: string;
        /** The readable reference the sender is given (ETG-SUP-2026-000142). */
        reference: string | null;
        status: FeedbackStatusValue;
      }>('/support', {
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
    /** One page, newest first. Pages are 50 rows; the list screen asks for the next on demand. */
    list: (page = 1) => request<Paged<BookingSummary>>(`/bookings?pageSize=50&page=${page}`),
    get: (id: string) => request<BookingDetail>(`/bookings/${id}`),
    /**
     * A customer's booking, read by platform staff. Needs BOOKING_READ and is audited. The
     * customer route above answers only the buyer.
     */
    getAsStaff: (id: string) => request<BookingDetail>(`/admin/bookings/${id}`),
    pay: (id: string) => request<PayResult>(`/bookings/${id}/pay`, { method: 'POST' }),
    /**
     * Cancel the signed-in buyer's own unpaid booking, releasing what it holds at once.
     *
     * Only a booking still awaiting payment: a paid one is refused, and its tickets go back
     * through a refund request instead.
     */
    cancel: (id: string) =>
      request<{ id: string; status: string; refundPending: boolean }>(`/bookings/${id}/cancel`, {
        method: 'POST',
      }),
  },

  /**
   * Buying a ticket without an account.
   *
   * ── WHY A SEPARATE SET OF CALLS ────────────────────────────────────────────────────
   * Nothing here is authenticated by a bearer token, so `auth: false` on every call: sending
   * a stale Authorization header to a guest route asks the server to answer as two different
   * people at once. What identifies the buyer instead is the anonymous session in
   * `x-anon-session`, which the browser holds for as long as it holds the booking. It is a
   * capability, not an identity: it proves "this browser created that booking" and nothing
   * more, which is exactly the claim a guest can make.
   *
   * The token is passed in by the caller rather than read from a store in here, because the
   * store is a browser thing and this client also runs where there is no localStorage.
   */
  guestBookings: {
    /**
     * Hold tickets for somebody who is not signed in.
     *
     * The body is the same one `/bookings` takes: `buyerName` and `buyerEmail` are already
     * required there, so a guest sends nothing extra. `anonSession` carries a token this
     * browser already has, so a second purchase joins the same anonymous session; the
     * response may hand back a new one, which the caller must keep or lose the booking.
     */
    create: (body: BookingRequest, anonSession?: string | null) =>
      request<GuestBookingResult>('/bookings/guest', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: anonSession ? { 'x-anon-session': anonSession } : undefined,
        auth: false,
      }),
    get: (id: string, anonSession: string) =>
      request<GuestBookingView>(`/bookings/guest/${id}`, {
        headers: { 'x-anon-session': anonSession },
        auth: false,
      }),
    pay: (id: string, anonSession: string) =>
      request<PayResult>(`/bookings/guest/${id}/pay`, {
        method: 'POST',
        headers: { 'x-anon-session': anonSession },
        auth: false,
      }),
    /**
     * Give the tickets back before the hold runs out.
     *
     * May be refused with 409, which means guest cancel is not available for this booking.
     * That is not an error to shout about: the hold expires on its own, and the caller says so.
     */
    cancel: (id: string, anonSession: string) =>
      request<{ id: string; status: string }>(`/bookings/guest/${id}/cancel`, {
        method: 'POST',
        headers: { 'x-anon-session': anonSession },
        auth: false,
      }),
    /**
     * Email a link to a booking, given its reference and the address that bought it.
     *
     * Always answers `{ sent: true }`. It never says whether the pair matched, because an
     * endpoint that did would tell anybody with a reference which email address is on it.
     */
    lookup: (body: { reference: string; email: string }) =>
      request<{ sent: true }>('/bookings/guest/lookup', {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }),
    /** Read a booking from the token in an emailed link. The link is the credential. */
    access: (token: string) =>
      request<GuestBookingView>(`/bookings/guest/access/${token}`, { auth: false }),
    /**
     * The financial documents for a guest booking, and the printable one as HTML.
     *
     * ── WHY THE EMAIL IS SENT AS WELL AS THE TOKEN ─────────────────────────────────
     * The token is in an email, and an email gets forwarded. That is acceptable for the
     * tickets, which the holder of the link is going to be shown at the door anyway, and not
     * acceptable for an invoice: it carries the buyer's name, their address and what they
     * paid. So the document asks for one more thing that only the buyer knows — the address
     * the booking was paid with — and the server answers 403 when it does not match.
     *
     * `documents` may be empty and `html` an empty string when nothing has been issued yet,
     * which is a real state rather than a failure and must be said in words.
     */
    receipt: (token: string, email: string) =>
      request<GuestReceiptsView>(`/bookings/guest/access/${token}/receipt`, {
        method: 'POST',
        body: JSON.stringify({ email }),
        auth: false,
      }),
    /**
     * Ask the organizer for the money back, from an emailed link.
     *
     * Same email check as the document, for the same reason: whoever a link was forwarded to
     * must not be able to give somebody else's tickets back. 409 means the booking cannot be
     * refunded — past the cutoff, already refunded, paid in cash — and the message says
     * which, so a caller shows it rather than a failure of its own.
     */
    refund: (token: string, body: { email: string; reason?: string }) =>
      request<GuestRefundRequest>(`/bookings/guest/access/${token}/refund`, {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }),
    /**
     * Attach a guest booking to the account that is signed in now.
     *
     * The ONE guest call that is authenticated, because it needs to know which account to
     * attach the booking to — so no `auth: false` here. What proves the caller may claim this
     * booking is either the access token from the emailed link or the anonymous session of
     * the browser that bought it; both are sent when both are to hand.
     *
     * 409 means the booking already belongs to a different account. That is an answer, not an
     * error: somebody else has claimed it, and no retry changes that.
     */
    claim: (id: string, body: { accessToken?: string }, anonSession?: string | null) =>
      request<GuestBookingClaim>(`/bookings/guest/${id}/claim`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: anonSession ? { 'x-anon-session': anonSession } : undefined,
      }),
  },

  payments: {
    /**
     * Record cash handed over at the counter, and confirm the booking.
     *
     * No amount is sent. The server confirms the full amount the booking already says is
     * owed — letting the caller name a figure would make partial payment expressible, and a
     * half-paid ticket has no defined meaning: it either admits somebody or it does not.
     */
    collectCash: (bookingId: string) =>
      request<{ status: string; bookingId: string }>(`/payments/${bookingId}/collect-cash`, {
        method: 'POST',
      }),
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
    /**
     * Every ticket on a booking, for organizer staff printing at the counter.
     *
     * Authorised by membership of the selling organization, not ownership — and recorded,
     * because the QR on the sheet is a bearer credential.
     */
    forBookingAsStaff: (bookingId: string) =>
      request<WalletTicket[]>(`/tickets/booking/${bookingId}/print`),
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

  /**
   * Organizer billing (plans, usage, platform invoices). Owners and managers; entitlements are
   * readable by any member. Checkout is refused with BILLING_NOT_ENABLED while paid plans are
   * not open - the console does not call it then.
   */
  billing: {
    get: (organizationId: string) =>
      request<OrganizerBilling>(`/organizations/${organizationId}/billing`),
    entitlements: (organizationId: string) =>
      request<OrganizationEntitlements>(`/organizations/${organizationId}/entitlements`),
    invoices: (organizationId: string) =>
      request<OrganizerInvoiceRow[]>(`/organizations/${organizationId}/billing/invoices`),
    /** A hosted provider page. The plan arrives only when the provider's verified payment does. */
    checkout: (organizationId: string, priceId: string) =>
      request<BillingCheckoutSession>(`/organizations/${organizationId}/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({ priceId }),
      }),
    /** A hosted one-time page for a credit pack. Credits arrive with the verified payment. */
    buyCredits: (organizationId: string, packCode: string) =>
      request<BillingCheckoutSession>(
        `/organizations/${organizationId}/billing/credit-packs/checkout`,
        { method: 'POST', body: JSON.stringify({ packCode }) },
      ),
    /** Stripe's Billing Portal: payment method and cancellation. Owners only. */
    portal: (organizationId: string) =>
      request<{ url: string }>(`/organizations/${organizationId}/billing/portal`, {
        method: 'POST',
      }),
    /** Cancel the paid plan at the end of its period. Owners only. */
    cancel: (organizationId: string, reason?: string) =>
      request<{ status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null }>(
        `/organizations/${organizationId}/billing/cancel`,
        { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
      ),
    /**
     * Opens a platform invoice (ETG-BIL) as printable HTML in a new tab. Fetched with the token
     * and handed over as a blob, for the same reason as receipts.openHtml: a plain link sends no
     * Authorization header.
     */
    openInvoiceHtml: async (organizationId: string, invoiceId: string): Promise<void> => {
      const res = await fetch(
        `${API_URL}/organizations/${organizationId}/billing/invoices/${invoiceId}/html`,
        { headers: tokenStore.access ? { authorization: `Bearer ${tokenStore.access}` } : {} },
      );
      if (!res.ok) throw new Error(`Could not load the invoice (${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  },

  organizations: {
    create: (body: {
      name: string;
      contactEmail?: string;
      /** Who the organization legally is. The registration form asks; approval requires. */
      legalName?: string;
      legalEntityType?: string;
      registeredCountry?: string;
    }) => request<Organization>('/organizations', { method: 'POST', body: JSON.stringify(body) }),
    listMine: () => request<Organization[]>('/organizations'),
    /** What this organizer still has to complete. The same list the admin console reads. */
    readiness: (id: string) => request<OrganizationReadiness>(`/organizations/${id}/readiness`),
    /**
     * One list of what this organizer still has to do.
     *
     * Composes readiness with the operational checks the console used to make for itself. Every
     * setup surface reads this; none of them derives completion separately.
     */
    actions: (id: string) => request<OrganizerActionSummary>(`/organizations/${id}/actions`),
    /**
     * The organization's profile picture. JPG, PNG or WebP, at most 1 MB.
     *
     * Replaces whatever is there and returns the new `logoUrl`, which every surface that
     * shows a logo already reads - the console masthead, the public organizer page and the
     * event page all render that field.
     */
    uploadLogo: (id: string, image: Blob, filename = 'logo.png') =>
      uploadOrgImage(id, 'logo', image, filename),
    removeLogo: (id: string) => removeOrgImage(id, 'logo'),
    /**
     * The cover banner across the top of the public profile. Same formats, 3 MB - it is a
     * wide image rather than a small square.
     */
    uploadCover: (id: string, image: Blob, filename = 'cover.jpg') =>
      uploadOrgImage(id, 'cover', image, filename),
    removeCover: (id: string) => removeOrgImage(id, 'cover'),
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
    refunds: (id: string, params: PageParams & { status?: string; eventId?: string } = {}) =>
      request<Paged<OrganizationRefundRow>>(`/organizations/${id}/refunds${qs(params)}`),
    /** Turn cash-at-the-venue on or off for an organization. Owner only. */
    setCashPayments: (id: string, enabled: boolean) =>
      request<{ id: string; cashPaymentsEnabled: boolean }>(`/organizations/${id}/cash-payments`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    /** The counter's worklist: cash bookings reserved but not yet paid for. */
    cashBookings: (id: string, includeCollected = false) =>
      request<CashBooking[]>(
        `/organizations/${id}/cash-bookings${qs({ includeCollected: includeCollected || undefined })}`,
      ),
    /** Cancelled cash bookings whose money is owed back (or, with `includeReturned`, was). */
    cashReturns: (id: string, opts: { eventId?: string; includeReturned?: boolean } = {}) =>
      request<CashReturnRow[]>(
        `/organizations/${id}/cash-returns${qs({ eventId: opts.eventId, includeReturned: opts.includeReturned || undefined })}`,
      ),
    /** Record, offline, that the cash was handed back. No payment provider is involved. */
    markCashReturned: (id: string, bookingId: string) =>
      request<{
        bookingId: string;
        status: 'returned' | 'already_returned';
        returnedAt: string;
        /** The credit note the return is recorded against. */
        creditNote?: { id: string; number: string } | null;
      }>(`/organizations/${id}/cash-returns/${bookingId}/returned`, { method: 'POST' }),
    /**
     * Sell at the counter: tickets for the person in front of the staff member, paid in cash
     * there and issued at once. One `idempotencyKey` per sale, so a double press sells once.
     */
    /** The dates on sale now, with their ticket types and what is left, for the counter. */
    counterShows: (id: string) =>
      request<CounterShow[]>(`/organizations/${id}/counter-sales/shows`),
    counterSale: (id: string, body: CounterSaleBody, idempotencyKey?: string) =>
      request<CounterSaleResult>(`/organizations/${id}/counter-sales`, {
        method: 'POST',
        body: JSON.stringify(body),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    members: (id: string) => request<OrgMember[]>(`/organizations/${id}/members`),
    invite: (id: string, body: { email: string; role: string }) =>
      request<InvitedMember>(`/organizations/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /**
     * Email a fresh link to somebody who has not accepted yet; the old link stops working.
     * Refused once they have joined. The answer says whether the email left - never the link.
     */
    resendInvite: (id: string, memberId: string) =>
      request<{ email: string; invitationEmail: InvitationEmailStatus }>(
        `/organizations/${id}/members/${memberId}/resend-invite`,
        { method: 'POST' },
      ),
    /** Take somebody off the team. Owner only; their access ends on their next request. */
    removeMember: (id: string, memberId: string) =>
      request<RemovedMember>(`/organizations/${id}/members/${memberId}`, { method: 'DELETE' }),
    /** Change what a team member may do. Owner only; the last owner cannot be demoted. */
    changeMemberRole: (id: string, memberId: string, role: string) =>
      request<OrgMember>(`/organizations/${id}/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
  },

  /**
   * A team invitation, as its link reaches the invitee.
   *
   * Owner decision (2026-10-26): only the invited person accepts. Describing the link is public;
   * an account the invitation CREATED is claimed with a code sent to the invited address; and
   * accepting needs the invited account's own session with its email confirmed. The link alone
   * never signs anybody in or joins anybody to a team.
   */
  invitations: {
    describe: (token: string) =>
      request<InvitationSummary>(`/public/invitations/${token}`, { auth: false }),
    /** Send a code to the invited address, to claim the account the invitation made. */
    requestAccountCode: (token: string) =>
      request<{ sent: true; expiresInMinutes: number; email: string }>(
        `/public/invitations/${token}/account/request-code`,
        { method: 'POST', auth: false },
      ),
    /** Claim it: the code, a name and a password. Joining a team is a separate step. */
    claimAccount: (token: string, body: { code: string; fullName: string; password: string }) =>
      request<{ email: string; accepted: boolean }>(`/public/invitations/${token}/account`, {
        method: 'POST',
        body: JSON.stringify(body),
        auth: false,
      }),
    /** Accept, signed in as the invited account (sends the session; no body). */
    accept: (token: string) =>
      request<AcceptedInvitation>(`/public/invitations/${token}/accept`, {
        method: 'POST',
        body: JSON.stringify({}),
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
     * own ticket purchases belong on different screens.
     *
     * ── REQUIRED, NOT OPTIONAL ────────────────────────────────────────────────────
     * The HTTP endpoint still treats it as optional, because an unknown client is better
     * served everything than nothing. A caller in THIS repository is not an unknown client:
     * it is one of three apps, each of which knows exactly whose stream it is showing, and a
     * forgotten parameter here is how an organizer's event approvals turned up on the
     * customer site. Making it required moves that from something to remember to something
     * that does not compile.
     */
    inbox: (params: { limit?: number; before?: string; audience: NotificationAudience }) =>
      request<NotificationInbox>(`/notifications${qs(params)}`),
    /** Scoped, so the bell on one site cannot count the other site's messages. */
    unreadCount: (audience: NotificationAudience) =>
      request<{ unreadCount: number }>(`/notifications/unread-count${qs({ audience })}`),
    markRead: (id: string) =>
      request<{ updated: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),
    /**
     * The notification centre grouped by what to do, with repeats of one cause folded into
     * one card. The flat `inbox` above is unchanged; the bell and the customer site read it.
     */
    feed: (audience: NotificationAudience) =>
      request<NotificationFeed>(`/notifications/feed${qs({ audience })}`),
    /** Mark every notification folded into one card read. Only the caller's own are touched. */
    markManyRead: (ids: string[]) =>
      request<{ updated: number }>(`/notifications/read-many`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    /** Scoped: clearing the customer inbox must not silence an organizer's payout notices. */
    markAllRead: (audience: NotificationAudience) =>
      request<{ updated: number }>(`/notifications/read-all${qs({ audience })}`, {
        method: 'POST',
      }),

    /**
     * What a person receives, and on what.
     *
     * The response carries `required` and `deferred` per channel, and a settings screen has
     * to honour both. `required` means policy guarantees that channel whatever the person
     * chooses -- a toggle for it would be a lie told twice, once by implying the message can
     * be stopped and again when it arrives anyway. `deferred` is the emergency SMS, which is
     * not something anybody opts into: it opens only when nothing else reached them.
     */
    preferences: () => request<NotificationPreferenceView>('/me/notification-preferences'),
    setPreference: (body: { type: string; channel: string; enabled: boolean }) =>
      request<NotificationPreferenceView>('/me/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    /**
     * Consent, per channel, for a CATEGORY of message.
     *
     * `whatsapp` is permission to sell on WhatsApp; `whatsapp:transactional` is permission to
     * use it to tell somebody about their own booking. Two different questions, and answering
     * one with the other is how a person who declined offers stops receiving their tickets.
     */
    consent: () => request<ConsentView>('/me/marketing-consent'),
    setConsent: (body: { channel: string; granted: boolean }) =>
      request<ConsentView['channels']>('/me/marketing-consent', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  },

  venues: {
    create: (body: {
      organizationId: string;
      name: string;
      city: string;
      country?: string;
      /** State / province / emirate. Decides India's place of supply — see the venue schema. */
      region?: string;
      /** IANA zone. A start time means the time AT THE VENUE, never the server's. */
      timezone?: string;
      address?: string;
      capacity?: number;
    }) => request<Venue>('/venues', { method: 'POST', body: JSON.stringify(body) }),
    list: (organizationId: string) => request<Venue[]>(`/venues${qs({ organizationId })}`),
    /** Edit a venue. Only the fields sent are changed. */
    update: (
      id: string,
      body: Partial<{
        name: string;
        city: string;
        country: string;
        region: string;
        timezone: string;
        address: string;
        capacity: number;
      }>,
    ) =>
      request<Venue & { sessionsKeptLocalTime?: number }>(`/venues/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    /**
     * The bookable spaces inside a venue - cinema screens included.
     *
     * This read could not be written before a space carried its own venue: "the spaces in
     * this venue" meant "the screens of the cinemas in this venue", so a hall that was not a
     * cinema could not exist to be listed.
     */
    spaces: (venueId: string) => request<VenueSpace[]>(`/venues/${venueId}/spaces`),

    /** Every space in the organization, for the console's one-screen VENUE -> SPACE list. */
    allSpaces: (organizationId: string) =>
      request<VenueSpace[]>(`/venues/spaces${qs({ organizationId })}`),

    /**
     * Add a space to a venue. A cinema screen is filed under the venue's cinema (made from the
     * venue the first time); every other kind of space needs no cinema.
     */
    addSpace: (
      venueId: string,
      body: { name: string; screenType?: string; capacity: number; kind?: SpaceKind },
    ) =>
      request<VenueSpace>(`/venues/${venueId}/spaces`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    /** One space, for its own page: venue, cinema, layouts and how many sessions use it. */
    space: (spaceId: string) => request<SpaceDetail>(`/venues/spaces/${spaceId}`),
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
    /**
     * Upload the film's poster from a file (JPG, PNG or WebP, at most 2 MB). The API cuts it to
     * one 2:3 WebP and points the film's `posterUrl` at it.
     */
    uploadPoster: (id: string, image: Blob, filename = 'poster.jpg') => {
      const form = new FormData();
      form.append('file', image, filename);
      return request<Movie>(`/movies/${id}/poster`, { method: 'POST', body: form });
    },
  },

  cinemas: {
    /**
     * The order this cinema is sold under, and whether its prices comply.
     *
     * EXPLANATORY. Booking and publishing enforce on their own; a client that never calls
     * this is not a client that can sell at any price.
     */
    pricingCompliance: (id: string) =>
      request<CinemaComplianceView>(`/cinemas/${id}/pricing-compliance`),
    /** Every sellable seat category and the regulatory class it is mapped to. */
    seatClasses: (id: string) => request<SeatClassMapping[]>(`/cinemas/${id}/seat-classes`),
    /**
     * State which regulatory class a seat category belongs to.
     *
     * `null` clears it. That is not an oversight: withdrawing a wrong answer must be possible,
     * and in a regulated jurisdiction the seat then stops selling until it is mapped again.
     */
    setSeatClass: (id: string, seatCategoryId: string, regulatoryClass: string | null) =>
      request<SeatClassMapping>(`/cinemas/${id}/seat-classes/${seatCategoryId}`, {
        method: 'PATCH',
        body: JSON.stringify({ regulatoryClass }),
      }),
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
    list: (params?: { city?: string; country?: string; genre?: string; q?: string }) =>
      request<PublicMovieCard[]>(`/public/movies${qs(params ?? {})}`, { auth: false }),
    get: (slug: string) => request<PublicMovie>(`/public/movies/${slug}`, { auth: false }),
    /**
     * Every bookable screening of a film, with price, format and availability per show.
     * `from` / `to` are ISO instants (`to` exclusive); `limit` is at most 200.
     */
    shows: (
      slug: string,
      params?: { city?: string; country?: string; from?: string; to?: string; limit?: number },
    ) =>
      request<PublicMovieShows>(`/public/movies/${slug}/shows${qs(params ?? {})}`, {
        auth: false,
      }),
  },

  publicShows: {
    /** Which show this is — film or event, cinema, screen, and when, in the cinema's zone. */
    summary: (sessionId: string) =>
      request<PublicShowSummary>(`/public/shows/${sessionId}`, { auth: false }),
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
    /** Move one date of an event that is not a film; both ends come from the organizer. */
    retime: (sessionId: string, startsAt: string, endsAt: string) =>
      request<{ sessionId: string; startsAt: string; endsAt: string }>(
        `/shows/${sessionId}/retime`,
        { method: 'POST', body: JSON.stringify({ startsAt, endsAt }) },
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
    /** A layout as the editor's document. Any member may read it; only a draft can be saved. */
    layoutDocument: (layoutId: string) =>
      request<LayoutEditorResponse>(`/seat-layouts/${layoutId}/editor`),
    /** Save the editor's document into a draft, replacing what it held. */
    saveLayoutDocument: (layoutId: string, document: LayoutDocument) =>
      request<{ id: string; status: 'DRAFT'; counts: LayoutDocumentCounts }>(
        `/seat-layouts/${layoutId}/editor`,
        { method: 'POST', body: JSON.stringify(document) },
      ),
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
        /** Build at about this many seats, the space's planned size. */
        targetSeats?: number;
        /** How to meet targetSeats. Left out, at least that many. */
        fit?: LayoutTemplateFitMode;
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
    /**
     * Start a NEW draft for a space from a template. Works for a space with no layout at all,
     * which applying a template to an existing draft cannot.
     */
    createLayoutFromTemplate: (
      screenId: string,
      body: {
        template: VenueTemplateKey;
        basePriceMinor: number;
        name?: string;
        rows?: number;
        seatsPerRow?: number;
        /** Build at about this many seats, the space's planned size. */
        targetSeats?: number;
        /** How to meet targetSeats. Left out, at least that many. */
        fit?: LayoutTemplateFitMode;
      },
    ) =>
      request<{
        id: string;
        name: string;
        version: number;
        status: 'DRAFT';
        layoutKind: 'GRID' | 'SECTIONED';
        sections: number;
        seats: number;
      }>(`/screens/${screenId}/seat-layouts`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** Every template as outlines (no seats), for the layout gallery's pictures and counts. */
    /** With `seats`, every template is sized to about that many seats (`fit` says how well). */
    layoutTemplates: (seats?: number) =>
      request<LayoutTemplateOutline[]>(`/seat-layout-templates${qs({ seats })}`),
    /**
     * A layout as a buyer would see it - the same shape as the public seat read, so the same
     * buyer components draw it. Nothing in it can be booked.
     */
    previewLayout: (layoutId: string, sectionId?: string) =>
      request<SeatLayoutPreview>(`/seat-layouts/${layoutId}/preview${qs({ section: sectionId })}`),
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
    /**
     * Every session of the organization touching `[from, to)` (ISO instants, at most 62 days),
     * for the organizer calendar. One request per visible range, instead of one per event.
     */
    calendar: (organizationId: string, from: string, to: string) =>
      request<OrganizerCalendarResponse>(`/organizer-calendar${qs({ organizationId, from, to })}`),
    /**
     * Whether checkout would sell each show now, by the same sale-eligibility rules checkout
     * refuses a cart by, with the organizer's reason. At most 50 ids; another organization's
     * shows are left out of the answer.
     */
    saleEligibility: (organizationId: string, sessionIds: string[]) =>
      request<{ sessions: OrganizerSessionSaleEligibility[] }>(
        `/organizer-calendar/sale-eligibility${qs({ organizationId, sessionIds: sessionIds.join(',') })}`,
      ),
    /**
     * Whether each event is selling, partly selling or not, over its upcoming shows. At most 50
     * ids per call; the console pages a longer list. Owners and managers only.
     */
    saleStates: (organizationId: string, eventIds: string[]) =>
      request<{ events: EventSaleState[] }>(
        `/organizer-calendar/event-sale-eligibility${qs({ organizationId, eventIds: eventIds.join(',') })}`,
      ),
    get: (id: string) => request<OrgEventDetail>(`/events/${id}`),
    /**
     * Create a draft event. With `idempotencyKey`, a repeat of the same request (a double
     * click, a retry after a lost response) answers with the event the first one made.
     */
    create: (body: CreateEventBody, idempotencyKey?: string) =>
      request<OrgEventDetail>('/events', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
      }),
    update: (id: string, body: Partial<CreateEventBody>) =>
      request<OrgEventDetail>(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    /** Delete an event with no bookings. Refused (409) with the reason when it has any. */
    remove: (id: string) => request<{ ok: boolean }>(`/events/${id}`, { method: 'DELETE' }),
    /**
     * Add one image after the event's existing ones (the first image is the cover). JPG, PNG or
     * WebP, at most 2 MB — resize before sending. Up to ten per event. With `idempotencyKey`
     * (one per picked file), a retried upload answers with the gallery instead of a second copy.
     */
    addImage: (id: string, image: Blob, filename = 'event-image.jpg', idempotencyKey?: string) => {
      const form = new FormData();
      form.append('file', image, filename);
      return request<EventGallery>(`/events/${id}/images`, {
        method: 'POST',
        body: form,
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
      });
    },
    removeImage: (id: string, imageId: string) =>
      request<EventGallery>(`/events/${id}/images/${imageId}`, { method: 'DELETE' }),
    /** Every image id on the event, exactly once, in the new order; the first is the cover. */
    reorderImages: (id: string, imageIds: string[]) =>
      request<EventGallery>(`/events/${id}/images/order`, {
        method: 'PUT',
        body: JSON.stringify({ imageIds }),
      }),
    /** Where crops of this image are centred (0..1 across and down); its copies are cut again. */
    setImageFocalPoint: (id: string, imageId: string, point: FocalPoint) =>
      request<EventGallery>(`/events/${id}/images/${imageId}/focal-point`, {
        method: 'PUT',
        body: JSON.stringify(point),
      }),
    /** Whether an event at this venue must be classified for tax; see TaxClassificationRequirement. */
    taxClassification: (venueId: string) =>
      request<TaxClassificationRequirement>(`/events/tax-classification${qs({ venueId })}`),
    /** Rooms with a published seat map that an event could be seated in. */
    seatingRooms: (organizationId: string) =>
      request<SeatingRoom[]>(`/events/seating-rooms${qs({ organizationId })}`),
    addSession: (
      id: string,
      // `screenId` is the whole difference between reserved seating and general admission.
      // `standingSpaceId` keeps it general admission, capped by what that standing space holds.
      body: {
        startsAt: string;
        endsAt: string;
        screenId?: string;
        seatMapId?: string;
        standingSpaceId?: string;
      },
    ) =>
      request<EventSession>(`/events/${id}/sessions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** Change, add (screenId) or remove (null) a session's room. Refused once anything sold. */
    /**
     * Change a session's space - and, when that space has several layouts, WHICH one. The
     * server refuses a multi-layout space without a `seatMapId` rather than picking for you.
     */
    /**
     * Put a general-admission session in a standing space (its capacity caps what is on sale),
     * or take it out with null. Never changes the tickets on sale; says if they are over.
     */
    setStandingSpace: (sessionId: string, standingSpaceId: string | null) =>
      request<EventSession & { onSale: number; overCapacityBy: number }>(
        `/events/sessions/${sessionId}/standing-space`,
        { method: 'PATCH', body: JSON.stringify({ standingSpaceId }) },
      ),
    updateSessionSeating: (sessionId: string, screenId: string | null, seatMapId?: string | null) =>
      request<EventSession>(`/events/sessions/${sessionId}/seating`, {
        method: 'PATCH',
        body: JSON.stringify({ screenId, ...(screenId && seatMapId ? { seatMapId } : {}) }),
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
    /**
     * Whether a customer could actually complete a purchase for this event.
     *
     * The same rules checkout enforces, asked before anybody is taken to a seat map they
     * cannot buy from. Available at any point in an event's life, not only at publish: a
     * blocker can appear on a live event when a price is edited or a room is reassigned.
     */
    sellability: (id: string) => request<EventSellability>(`/events/${id}/sellability`),
    duplicate: (id: string) => request<OrgEventRow>(`/events/${id}/duplicate`, { method: 'POST' }),
    promotion: (id: string) => request<EventPromotion>(`/events/${id}/promotion`),
    pause: (id: string) => request<OrgEventDetail>(`/events/${id}/pause`, { method: 'POST' }),
    /** Refused (403) for an event the platform team paused. May land UNDER_REVIEW, not live. */
    resume: (id: string) => request<EventResumeResult>(`/events/${id}/resume`, { method: 'POST' }),
    /**
     * Cancel the whole event: sales stop, every date still to come is cancelled, a refund
     * opens for each paid booking and every buyer is told. Owner only; cannot be undone.
     */
    cancelPreview: (id: string) => request<EventCancelPreview>(`/events/${id}/cancel-preview`),
    cancel: (id: string, reason: string) =>
      request<EventCancelResult>(`/events/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    orders: (id: string, params: PageParams & { status?: string; q?: string }) =>
      request<Paged<OrderRow>>(`/events/${id}/orders${qs(params)}`),
    /** Who booked: filtered and paged on the server, with per-status totals for the filter. */
    attendees: (id: string, params: PageParams & AttendeeFilter) =>
      request<AttendeeList>(`/events/${id}/attendees${qs(params)}`),
    /**
     * Downloads the SAME filter as a CSV, built by the server. Owners and managers only.
     * The server names the file; this name is only the fallback the browser uses.
     */
    exportAttendees: (id: string, filter: AttendeeFilter) =>
      downloadCsv(`/events/${id}/attendees/export${qs(filter)}`, `attendees-${id}.csv`),
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
    /**
     * Tickets for a session, so staff can find the one they are holding.
     *
     * Search rather than a full list: a busy screening is several hundred seats, and
     * scrolling that at a door under time pressure is how the wrong seat gets admitted.
     */
    /** Shows running now, for the gate screen to choose from. Carries no money. */
    gateSessions: (organizationId: string) =>
      request<
        {
          id: string;
          eventTitle: string;
          startsAt: string;
          venueName: string | null;
          startsAtLabel: string;
        }[]
      >(`/checkins/sessions${qs({ organizationId })}`),
    roster: (eventSessionId: string, q?: string) =>
      request<CheckInRosterRow[]>(`/checkins/roster${qs({ eventSessionId, q })}`),
    /**
     * Find a booking anywhere in the organization, for the box office.
     *
     * Needs at least three characters: listing every booking an organization ever took is an
     * export, not a search, and a counter terminal is the wrong place to page through it.
     */
    findBookings: (organizationId: string, q: string) =>
      request<CounterBookingRow[]>(`/checkins/bookings${qs({ organizationId, q })}`),
    /**
     * Admit a ticket identified by eye rather than scanned.
     *
     * Recorded as a VISUAL check-in, which is a different claim from a scan: one verifies a
     * signed token, the other verifies that somebody looked.
     */
    admitVisually: (body: { ticketId: string; expectedSessionId?: string; deviceInfo?: string }) =>
      request<CheckInOutcome>('/checkins/visual', {
        method: 'POST',
        body: JSON.stringify(body),
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
    // Both are issued to ONE registered device (H5): the device must be ACTIVE, and the list
    // it gets is signed for it and valid only for the offline revocation window.
    manifest: (eventSessionId: string, deviceId: string) =>
      request<SignedManifest>(`/checkin/manifest${qs({ eventSessionId, deviceId })}`),
    deltas: (eventSessionId: string, sinceMs: number, deviceId: string) =>
      request<RevocationDelta>(`/checkin/deltas${qs({ eventSessionId, sinceMs, deviceId })}`),
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
      request<RefundRow | FreeCancellationResult>('/refunds', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
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
      /*
        Add-ons and bundles were always accepted by the endpoint and were simply missing
        from this type, so every caller quoted tickets alone. A breakdown that leaves the
        extras out of the total is worse than none: it is a precise, confident, wrong number.
      */
      addOns?: { addOnId: string; quantity: number }[];
      bundles?: { bundleId: string; quantity: number }[];
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

  bookingHold: {
    /**
     * Ask for more time on a hold that has not expired yet.
     *
     * No body — WCAG 2.2.1 asks for a "simple action" to extend a time limit, and the
     * simplest possible request is one with nothing in it to get wrong. The response says
     * how many extensions are left so the button can stop offering what will be refused.
     */
    extend: (bookingId: string) =>
      request<{
        holdExpiresAt: string;
        holdExtensions: number;
        maxHoldExtensions: number;
        extensionsRemaining: number;
      }>(`/bookings/${bookingId}/extend-hold`, { method: 'POST' }),
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
    /**
     * The buyer's own documents, across every booking.
     *
     * Somebody who closed the confirmation page without saving their receipt previously had
     * no route back to it: documents were reachable by booking id or by organization, and a
     * customer has neither to hand.
     */
    /*
      `MyReceiptsPage`, not `Paged`.

      This said `Paged<MyReceiptRow>`, which is `{ data, meta }`. The endpoint returns
      `{ items, total, page, pageSize }`. `request<T>` casts the JSON and checks nothing, so
      the type compiled, the page read `data.data`, got undefined, and showed "No receipts
      yet" to everybody - for ever, including buyers holding receipts.
    */
    mine: (params: PageParams = {}) => request<MyReceiptsPage>(`/receipts/mine${qs(params)}`),
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
    /** The organizer's own bank accounts, masked. */
    accounts: (organizationId: string) =>
      request<PayoutAccount[]>(`/payouts/accounts${qs({ organizationId })}`),
    /** Every version of the account that was saved, newest first. Masked: no full number, ever. */
    accountHistory: (organizationId: string, currency?: string) =>
      request<PayoutAccountVersion[]>(
        `/payouts/accounts/history${qs({ organizationId, currency })}`,
      ),
    saveAccount: (body: {
      organizationId: string;
      currency: string;
      holderName: string;
      bankName: string;
      bankCode: string;
      accountNumber: string;
    }) =>
      request<PayoutAccount>('/payouts/accounts', { method: 'POST', body: JSON.stringify(body) }),
    /**
     * Where payout setup stands, decided by the server.
     *
     * The console renders this; it never re-derives a state from raw provider flags.
     */
    /**
     * What this organization is owed, has been paid and is waiting on, per currency.
     *
     * A read model: it reuses the payout ledger's own eligibility rules and the one settlement
     * calculation, so a finance screen and the payout it would raise cannot disagree.
     */
    summary: (organizationId: string, eventId?: string) =>
      request<PayoutSummary>(`/payouts/summary${qs({ organizationId, eventId })}`),
    /**
     * Every financial record this organization has, across both settlement paths, per currency.
     *
     * Distinct from `summary`, which is forward-looking: what a payout raised right now would come
     * to, from current booking state. This is historical - which records exist and what they say.
     */
    finance: (organizationId: string, eventId?: string) =>
      request<UnifiedFinanceDto>(`/payouts/finance${qs({ organizationId, eventId })}`),
    accountState: (organizationId: string) =>
      request<PayoutAccountState>(`/payouts/account-state${qs({ organizationId })}`),
    /** One payout per currency the scope has money in. */
    generate: (organizationId: string, eventId?: string) =>
      request<Payout[]>('/payouts/generate', {
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

    /**
     * Organizer billing. Reads need BILLING_READ; catalogue writes BILLING_MANAGE; offers
     * BILLING_ADJUST; single-feature grants ENTITLEMENT_GRANT. Every write needs a recent
     * second factor (the step-up handler retries once).
     */
    billing: {
      plans: () => request<AdminBillingPlan[]>('/admin/billing/plans'),
      loadProvisional: (body: { annualFreeMonths?: number } = {}) =>
        request<{ plansCreated: number; entitlementsWritten: number; pricesCreated: number }>(
          '/admin/billing/catalog/load-provisional',
          { method: 'POST', body: JSON.stringify(body) },
        ),
      updatePlan: (
        id: string,
        body: { name?: string; description?: string | null; active?: boolean; sortOrder?: number },
      ) =>
        request<AdminBillingPlan>(`/admin/billing/plans/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      setPlanEntitlements: (
        id: string,
        entitlements: { key: string; boolValue?: boolean | null; intValue?: number | null }[],
      ) =>
        request<unknown>(`/admin/billing/plans/${id}/entitlements`, {
          method: 'PUT',
          body: JSON.stringify({ entitlements }),
        }),
      createPrice: (body: {
        planId: string;
        country: string;
        currency: string;
        interval: 'MONTH' | 'YEAR';
        amountMinor: number;
        trialDays?: number | null;
      }) =>
        request<AdminBillingPrice>('/admin/billing/prices', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      updatePrice: (id: string, body: { amountMinor?: number; trialDays?: number | null }) =>
        request<AdminBillingPrice>(`/admin/billing/prices/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      deactivatePrice: (id: string) =>
        request<AdminBillingPrice>(`/admin/billing/prices/${id}/deactivate`, { method: 'POST' }),
      subscriptions: (
        params: {
          status?: string;
          planCode?: string;
          country?: string;
          search?: string;
          currentOnly?: 'true' | 'false';
          page?: number;
          pageSize?: number;
        } = {},
      ) =>
        request<AdminSubscriptionPage>(
          `/admin/billing/subscriptions${qs(params as Record<string, unknown>)}`,
        ),
      account: (organizationId: string) =>
        request<AdminBillingAccountDetail>(`/admin/billing/accounts/${organizationId}`),
      metrics: (days = 30) => request<AdminBillingMetrics>(`/admin/billing/metrics${qs({ days })}`),
      grantTrial: (
        organizationId: string,
        body: { planCode: 'PRO' | 'PREMIUM'; days: number; reason: string },
      ) =>
        request<unknown>(`/admin/billing/accounts/${organizationId}/trial`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      grantComplimentary: (
        organizationId: string,
        body: { planCode: 'PRO' | 'PREMIUM'; endsAt?: string | null; reason: string },
      ) =>
        request<unknown>(`/admin/billing/accounts/${organizationId}/complimentary`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      endGrant: (organizationId: string, reason: string) =>
        request<unknown>(`/admin/billing/accounts/${organizationId}/end-grant`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      grantCredits: (
        organizationId: string,
        body: { amount: number; reason: string; idempotencyKey: string },
      ) =>
        request<unknown>(`/admin/billing/accounts/${organizationId}/credits`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      recordDiscount: (
        organizationId: string,
        body: {
          percentOffBps?: number | null;
          amountMinor?: number | null;
          endsAt?: string | null;
          reason: string;
        },
      ) =>
        request<unknown>(`/admin/billing/accounts/${organizationId}/discounts`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      grantOverride: (
        organizationId: string,
        body: {
          key: string;
          boolValue?: boolean | null;
          intValue?: number | null;
          startsAt?: string | null;
          endsAt?: string | null;
          reason: string;
        },
      ) =>
        request<unknown>(`/admin/billing/accounts/${organizationId}/overrides`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      revokeOverride: (id: string, reason: string) =>
        request<unknown>(`/admin/billing/overrides/${id}/revoke`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
    },

    /**
     * Organizer acquisition (sales CRM). Every call needs CRM_AGENT; the team routes also
     * CRM_MANAGER. The server narrows each answer to the caller's teams.
     */
    crm: {
      me: () => request<CrmMe>('/admin/crm/me'),
      leads: (params: CrmLeadFilters = {}) =>
        request<Paged<CrmLead>>(`/admin/crm/leads${qs(params as Record<string, unknown>)}`),
      lead: (id: string) => request<CrmLeadDetail>(`/admin/crm/leads/${id}`),
      createLead: (body: Record<string, unknown>) =>
        request<CrmLead>('/admin/crm/leads', { method: 'POST', body: JSON.stringify(body) }),
      checkDuplicates: (body: Record<string, unknown>) =>
        request<{ matches: CrmDuplicateMatch[] }>('/admin/crm/leads/duplicates', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      updateLead: (id: string, body: Record<string, unknown> & { version: number }) =>
        request<{ lead: CrmLead; duplicates: CrmDuplicateMatch[] }>(`/admin/crm/leads/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      assign: (
        id: string,
        body: { version: number; assignedToUserId: string | null; note?: string },
      ) =>
        request<CrmLead>(`/admin/crm/leads/${id}/assign`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      changeStage: (
        id: string,
        body: { version: number; stage: string; note?: string; lostReason?: string },
      ) =>
        request<CrmLead>(`/admin/crm/leads/${id}/stage`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      archive: (id: string, body: { version: number; archived: boolean }) =>
        request<CrmLead>(`/admin/crm/leads/${id}/archive`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      searchOrganizations: (q: string) =>
        request<CrmOrganizationMatch[]>(`/admin/crm/organizations${qs({ q })}`),
      linkOrganization: (id: string, body: { version: number; organizationId: string }) =>
        request<CrmLead>(`/admin/crm/leads/${id}/organization`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      unlinkOrganization: (id: string, body: { version: number }) =>
        request<CrmLead>(`/admin/crm/leads/${id}/organization/unlink`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      logActivity: (id: string, body: Record<string, unknown>) =>
        request<{ activity: CrmActivity; followUp: CrmFollowUp | null }>(
          `/admin/crm/leads/${id}/activities`,
          { method: 'POST', body: JSON.stringify(body) },
        ),
      createFollowUp: (id: string, body: Record<string, unknown>) =>
        request<CrmFollowUp>(`/admin/crm/leads/${id}/follow-ups`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      activities: (params: Record<string, unknown> = {}) =>
        request<Paged<CrmActivity>>(`/admin/crm/activities${qs(params)}`),
      followUps: (params: Record<string, unknown> = {}) =>
        request<Paged<CrmFollowUp>>(`/admin/crm/follow-ups${qs(params)}`),
      completeFollowUp: (id: string, body: { version: number; note?: string }) =>
        request<CrmFollowUp>(`/admin/crm/follow-ups/${id}/complete`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      cancelFollowUp: (id: string, body: { version: number }) =>
        request<CrmFollowUp>(`/admin/crm/follow-ups/${id}/cancel`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      reassignFollowUp: (
        id: string,
        body: { version: number; ownerUserId: string; dueAt?: string },
      ) =>
        request<CrmFollowUp>(`/admin/crm/follow-ups/${id}/reassign`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      importLeads: (body: {
        teamId: string;
        csv: string;
        commit: boolean;
        onDuplicate?: 'skip' | 'create';
      }) =>
        request<CrmImportResult>('/admin/crm/leads/import', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      downloadLeads: (params: CrmLeadFilters = {}) =>
        downloadCsv(
          `/admin/crm/leads/export${qs(params as Record<string, unknown>)}`,
          'prospects.csv',
        ),
      teams: () => request<CrmTeam[]>('/admin/crm/teams'),
      candidates: (teamId: string) =>
        request<Array<{ id: string; fullName: string; email: string; holdsManager: boolean }>>(
          `/admin/crm/teams/${teamId}/candidates`,
        ),
      setMember: (teamId: string, userId: string, role: 'AGENT' | 'MANAGER') =>
        request<{ teamId: string; userId: string; role: string }>(
          `/admin/crm/teams/${teamId}/members/${userId}`,
          { method: 'PUT', body: JSON.stringify({ role }) },
        ),
      removeMember: (teamId: string, userId: string) =>
        request<{ removed: boolean; stillAssigned: number }>(
          `/admin/crm/teams/${teamId}/members/${userId}`,
          { method: 'DELETE' },
        ),
      reports: {
        overview: (f: CrmReportFilters = {}) =>
          request<CrmOverview>(`/admin/crm/reports/overview${qs({ ...f })}`),
        funnel: (f: CrmReportFilters = {}) =>
          request<CrmFunnel>(`/admin/crm/reports/funnel${qs({ ...f })}`),
        byCountry: (f: CrmReportFilters = {}) =>
          request<{ rows: CrmGroupRow[] }>(`/admin/crm/reports/by-country${qs({ ...f })}`),
        bySource: (f: CrmReportFilters = {}) =>
          request<{ rows: CrmGroupRow[] }>(`/admin/crm/reports/by-source${qs({ ...f })}`),
        byEmployee: (f: CrmReportFilters = {}) =>
          request<CrmEmployeeReport>(`/admin/crm/reports/by-employee${qs({ ...f })}`),
        activity: (f: CrmReportFilters = {}) =>
          request<CrmActivityReport>(`/admin/crm/reports/activity${qs({ ...f })}`),
        aging: (f: CrmReportFilters = {}) =>
          request<CrmAgingReport>(`/admin/crm/reports/aging${qs({ ...f })}`),
        conversion: (f: CrmReportFilters = {}) =>
          request<CrmConversionReport>(`/admin/crm/reports/conversion${qs({ ...f })}`),
        downloadCsv: (report: CrmCsvReport, f: CrmReportFilters = {}) =>
          downloadCsv(
            `/admin/crm/reports/${report}${qs({ ...f, format: 'csv' })}`,
            `acquisition-${report}.csv`,
          ),
      },
    },

    /** Back-office staff and what each of them may do. Needs ADMIN_MANAGE. */
    staff: {
      catalogue: () =>
        request<{
          permissions: string[];
          presets: { key: string; label: string; description: string; grants: string[] }[];
        }>('/admin/staff/catalogue'),
      list: () => request<AdminStaffMember[]>('/admin/staff'),
      /** Remove another account's authenticator; its next sign-in enrolls again. */
      resetMfa: (userId: string) =>
        request<{ success: boolean }>(`/admin/staff/${userId}/mfa/reset`, { method: 'POST' }),
      /**
       * Add somebody who has no account yet. The link that lets them claim it is EMAILED to
       * them; the answer only says whether the email left, so no administrator ever holds it.
       */
      invite: (email: string, permissions: string[]) =>
        request<{ id: string; email: string; invitationEmail: InvitationEmailStatus }>(
          '/admin/staff/invite',
          { method: 'POST', body: JSON.stringify({ email, permissions }) },
        ),
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
    /**
     * Stopping an account and ending its sessions. Needs USER_SUSPEND and a fresh authenticator
     * code (the shared step-up handler asks for one). Not your own account; a super admin only
     * by a super admin.
     */
    accounts: {
      suspend: (userId: string, reason: string) =>
        request<{ userId: string; status: string; sessionsRevoked: number }>(
          `/admin/users/${userId}/suspend`,
          { method: 'POST', body: JSON.stringify({ reason }) },
        ),
      reinstate: (userId: string, reason?: string) =>
        request<{ userId: string; status: string }>(`/admin/users/${userId}/reinstate`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      revokeSessions: (userId: string, reason?: string) =>
        request<{ userId: string; sessionsRevoked: number }>(
          `/admin/users/${userId}/revoke-sessions`,
          { method: 'POST', body: JSON.stringify({ reason }) },
        ),
    },
    platformAnalytics: () => request<PlatformAnalytics>('/admin/analytics/platform'),
    aiStatus: () => request<AiStatus>('/admin/ai/status'),
    aiUsage: () => request<AiUsageSummary>('/admin/ai/usage'),
    aiRisk: () => request<AiRiskReport>('/admin/ai/risk'),
    movies: (params?: PageParams & { status?: string; q?: string }) =>
      request<Paged<AdminMovieRow>>(`/admin/movies${qs(params ?? {})}`),
    audit: (params: PageParams & AuditFilters) =>
      request<Paged<AuditRow>>(`/admin/audit${qs(params)}`),
    /** The messages sent about something, newest first, each with what became of it. */
    notifications: (params: { bookingId?: string; reference?: string; limit?: number }) =>
      request<AdminNotificationRow[]>(`/admin/notifications${qs(params)}`),
    auditSummary: (params?: AuditFilters) =>
      request<AuditSummary>(`/admin/audit/summary${qs(params ?? {})}`),
    /* Every one of these searches in the DATABASE. They used to filter the fetched page. */
    organizers: (
      params: PageParams & { status?: string; q?: string; country?: string } & AdminGroupFilter,
    ) => request<Paged<Organization>>(`/admin/organizers${qs(params)}`),
    /**
     * `overrideReason` approves despite a missing legal identity, on the record (the API needs
     * at least ten characters of it). Omitted, the identity gate holds.
     */
    reviewOrganizer: (
      id: string,
      decision: 'APPROVE' | 'REJECT',
      note?: string,
      overrideReason?: string,
    ) =>
      request<Organization>(`/admin/organizers/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          note,
          ...(overrideReason ? { overrideIdentityCheck: { reason: overrideReason } } : {}),
        }),
      }),
    /** What a reviewer needs before deciding: declared identity, the owner, look-alike names. */
    organizerReviewSignals: (id: string) =>
      request<OrganizerReviewSignals>(`/admin/organizers/${id}/review-signals`),
    /**
     * Let a trusted organizer publish events without review, or stop them.
     *
     * The API refuses to turn it ON for an organizer that is not approved or has never had
     * an event approved the ordinary way, so the error is worth showing rather than
     * pre-empting — it explains what "trusted" means better than a disabled control would.
     */
    setOrganizerAutoApprove: (id: string, enabled: boolean) =>
      request<{ id: string; autoApproveEvents: boolean }>(`/admin/organizers/${id}/auto-approve`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    /**
     * The seller identity printed on an organizer's invoices, and what is still missing.
     *
     * Read and written by the platform because during a pilot the platform is the one doing
     * the onboarding — it collects the registration on a call. Waiting for the owner to
     * self-serve would mean every invoice until then goes out as a plain receipt, and a
     * receipt cannot be reissued as a tax invoice afterwards: the document is a snapshot.
     */
    /** Cinema pricing policies. See the admin service for why history is superseded. */
    cinemaPricingPolicies: () =>
      request<CinemaPricingPolicyRow[]>('/admin/cinema-pricing-policies'),
    inspectCinemaPricing: (q: Record<string, string>) =>
      request<{ status: string; explanation: string; policy: CinemaPricingPolicyRow | null }>(
        `/admin/cinema-pricing-policies/inspect${qs(q)}`,
      ),
    createCinemaPricingPolicy: (body: Record<string, unknown>) =>
      request<CinemaPricingPolicyRow>('/admin/cinema-pricing-policies', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateCinemaPricingPolicy: (id: string, body: Record<string, unknown>) =>
      request<CinemaPricingPolicyRow>(`/admin/cinema-pricing-policies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    activateCinemaPricingPolicy: (id: string) =>
      request<CinemaPricingPolicyRow>(`/admin/cinema-pricing-policies/${id}/activate`, {
        method: 'POST',
      }),
    supersedeCinemaPricingPolicy: (id: string, body: Record<string, unknown>) =>
      request<CinemaPricingPolicyRow>(`/admin/cinema-pricing-policies/${id}/supersede`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    disableCinemaPricingPolicy: (id: string) =>
      request<CinemaPricingPolicyRow>(`/admin/cinema-pricing-policies/${id}/disable`, {
        method: 'POST',
      }),
    /** Every cinema with where it is (from its venue) and its legal type. */
    cinemas: (params: { q?: string; page?: number; pageSize?: number } = {}) =>
      request<Paged<AdminCinemaRow>>(`/admin/cinemas${qs(params)}`),
    /** Set a cinema's legal type. Every field is sent, null to clear; audited with the reason. */
    setCinemaLegalType: (id: string, body: CinemaLegalTypeBody) =>
      request<AdminCinemaRow>(`/admin/cinemas/${id}/legal-type`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    organizerLegalIdentity: (id: string) =>
      request<OrganizationLegalIdentity>(`/admin/organizers/${id}/legal-identity`),
    updateOrganizerLegalIdentity: (id: string, patch: Partial<OrganizationLegalIdentityFields>) =>
      request<Organization>(`/admin/organizers/${id}/legal-identity`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    events: (
      params: PageParams & { status?: string; q?: string; country?: string } & AdminGroupFilter,
    ) => request<Paged<AdminEventRow>>(`/admin/events${qs(params)}`),
    /**
     * Every session in a window of whole UTC days (both inclusive, at most 62), across
     * organizers, for the admin calendar. Needs EVENT_REVIEW, like the moderation queue.
     */
    eventCalendar: (params: {
      from: string;
      to: string;
      country?: string;
      organizationId?: string;
      status?: string;
    }) => request<AdminCalendarResponse>(`/admin/events/calendar${qs(params)}`),
    reviewEvent: (id: string, decision: 'APPROVE' | 'REJECT', note?: string) =>
      request<OrgEventDetail>(`/admin/events/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, note }),
      }),
    /** `reason` is recorded in the audit log beside the change. */
    setEventStatus: (id: string, status: string, reason?: string) =>
      request<OrgEventDetail>(`/admin/events/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
      }),
    /** Organizer, event and a UTC day window on when the booking was made, like the money queues. */
    bookings: (
      params: PageParams & { status?: string; q?: string } & AdminGroupFilter & AdminListFilters,
    ) => request<Paged<AdminBookingRow>>(`/admin/bookings${qs(params)}`),
    payments: (
      params: PageParams & { status?: string; q?: string } & AdminGroupFilter & AdminListFilters,
    ) => request<Paged<AdminPaymentRow>>(`/admin/payments${qs(params)}`),
    refunds: (
      params: PageParams & { status?: string; q?: string } & AdminGroupFilter & AdminListFilters,
    ) => request<Paged<RefundRow>>(`/admin/refunds${qs(params)}`),
    /**
     * One row per group for an admin queue.
     *
     * A separate call per resource because each one is authorised separately on the server; a
     * console showing a summary the operator may not see would be a console that 403s on the
     * grouping toggle. `groupBy` is validated there too, and a refusal names what IS supported.
     */
    grouped: {
      bookings: (params: AdminGroupQuery) =>
        request<AdminGroupedSummary>(`/admin/grouped/bookings${qs(params)}`),
      payments: (params: AdminGroupQuery) =>
        request<AdminGroupedSummary>(`/admin/grouped/payments${qs(params)}`),
      refunds: (params: AdminGroupQuery) =>
        request<AdminGroupedSummary>(`/admin/grouped/refunds${qs(params)}`),
      settlements: (params: AdminGroupQuery) =>
        request<AdminGroupedSummary>(`/admin/grouped/settlements${qs(params)}`),
      events: (params: AdminGroupQuery) =>
        request<AdminGroupedSummary>(`/admin/grouped/events${qs(params)}`),
      organizers: (params: AdminGroupQuery) =>
        request<AdminGroupedSummary>(`/admin/grouped/organizers${qs(params)}`),
    },
    /** One refund by id — the detail page used to search the newest hundred for it. */
    refund: (id: string) => request<RefundRow>(`/admin/refunds/${id}`),
    /** Whether a FAILED refund can be sent to the provider again, and why not. Reads only. */
    refundRetryCheck: (id: string) => request<RefundRetryCheck>(`/admin/refunds/${id}/retry-check`),
    /**
     * Send a FAILED refund to the provider again. `confirmedNoProviderRefund` is the admin saying
     * they looked the payment up in the provider dashboard and found no refund there; the API
     * asks for it only when the last provider call came back with no answer.
     */
    retryRefund: (id: string, body: { confirmedNoProviderRefund?: boolean } = {}) =>
      request<RefundRetryResult>(`/admin/refunds/${id}/retry`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    payouts: () => request<Payout[]>('/admin/payouts'),
    markPayoutPaid: (id: string, body: { reference?: string; note?: string } = {}) =>
      request<Payout>(`/admin/payouts/${id}/pay`, { method: 'POST', body: JSON.stringify(body) }),
    markPayoutFailed: (id: string, reason: string) =>
      request<Payout>(`/admin/payouts/${id}/fail`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    payoutSettings: () => request<PayoutSettings>('/admin/payout-settings'),
    payoutAccounts: () => request<PayoutAccount[]>('/admin/payouts/accounts'),
    /** What an organizer still has to complete, as the organizer's own console shows it. */
    organizerReadiness: (id: string) =>
      request<OrganizationReadiness>(`/admin/organizers/${id}/readiness`),
    /** Stop an organizer selling, or let them start again. A reason is required to suspend. */
    setOrganizerSuspension: (id: string, suspended: boolean, reason?: string) =>
      request<Organization>(`/admin/organizers/${id}/suspension`, {
        method: 'POST',
        body: JSON.stringify({ suspended, reason }),
      }),
    organizerDeletionBlockers: (id: string) =>
      request<{ blockers: string[]; deletable: boolean }>(
        `/admin/organizers/${id}/deletion-blockers`,
      ),
    /** Only an organizer that never traded. Refused with its reasons otherwise. */
    deleteOrganizer: (id: string) =>
      request<{ deleted: boolean; name: string }>(`/admin/organizers/${id}`, { method: 'DELETE' }),
    /** Audited: the reason is stored with who asked. */
    revealPayoutAccount: (id: string, reason: string) =>
      request<RevealedPayoutAccount>(`/admin/payouts/accounts/${id}/reveal`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    /**
     * Maker-checker: refused for whoever entered the details and for members of the organization.
     * `version` is the version the reviewer was looking at; a newer one is refused (409).
     */
    verifyPayoutAccount: (id: string, version: number) =>
      request<PayoutAccount>(`/admin/payouts/accounts/${id}/verified`, {
        method: 'POST',
        body: JSON.stringify({ version }),
      }),
    /** Turn the details down. The reason is stored and emailed to the owners. */
    rejectPayoutAccount: (id: string, reason: string, version: number) =>
      request<PayoutAccount>(`/admin/payouts/accounts/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason, version }),
      }),
    payoutAccountHistory: (id: string) =>
      request<AdminPayoutAccountVersion[]>(`/admin/payouts/accounts/${id}/history`),
    savePayoutSettings: (organizationId: string | null, body: PayoutSettingsInput) =>
      request<PayoutSetting>(
        organizationId ? `/admin/payout-settings/${organizationId}` : '/admin/payout-settings',
        { method: 'POST', body: JSON.stringify(body) },
      ),
    feeRules: () => request<FeeRule[]>('/admin/fee-rules'),

    /** Every tax rule, with whether each is in force right now. */
    taxRules: () => request<TaxRule[]>('/admin/tax-rules'),
    /** How many active organizers would collect tax without a tax registration. */
    taxReadiness: () => request<{ unregisteredSellers: number }>('/admin/tax-rules/readiness'),
    /** Create a rule. Arrives switched OFF unless `active` is passed. */
    createTaxRule: (input: Partial<Omit<TaxRule, 'id' | 'inForceNow'>>) =>
      request<TaxRule>('/admin/tax-rules', { method: 'POST', body: JSON.stringify(input) }),
    /**
     * Update a DRAFT rule, or switch any rule on and off.
     *
     * The rate, basis and band of a LIVE rule are rejected here — changing them in place
     * would erase what was being charged before. Use `supersedeTaxRule` for that.
     */
    updateTaxRule: (id: string, patch: Partial<Omit<TaxRule, 'id' | 'inForceNow'>>) =>
      request<TaxRule>(`/admin/tax-rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    /** Close a rule at a date and open its successor at a new rate, in one transaction. */
    supersedeTaxRule: (
      id: string,
      input: { rateBasisPoints: number; effectiveFrom: string; label?: string },
    ) =>
      request<{ closed: TaxRule; successor: TaxRule }>(`/admin/tax-rules/${id}/supersede`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    /** Delete a rule that is switched off. A live one is refused. */
    deleteTaxRule: (id: string) =>
      request<{ deleted: true }>(`/admin/tax-rules/${id}`, { method: 'DELETE' }),
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
      patch: Partial<
        Pick<
          FeeRule,
          | 'label'
          | 'minMinor'
          | 'maxMinor'
          | 'feeMinor'
          | 'feeType'
          | 'feePercentBps'
          | 'minFeeMinor'
          | 'maxFeeMinor'
          | 'country'
          | 'region'
          | 'active'
        >
      >,
    ) =>
      request<FeeRule>(`/admin/fee-rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    // ─── Marketplace settlements (admin/finance) ───
    /**
     * Open chargebacks, soonest deadline first. Read-only: evidence is submitted in the
     * provider's dashboard and the outcome returns through the webhook. Needs FINANCE_READ.
     */
    disputes: () => request<OpenDisputes>('/admin/disputes'),

    settlements: {
      list: (
        params?: PageParams & {
          status?: string;
        } & AdminGroupFilter &
          AdminListFilters,
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
    support: (
      params?: PageParams & {
        kind?: string;
        status?: string;
        q?: string;
      } & AdminListFilters,
    ) => request<Paged<FeedbackRow>>(`/admin/support${qs(params ?? {})}`),
    /** Open and total complaints against one organizer, for the decision to keep selling. */
    complaintCounts: (organizationId: string) =>
      request<{ open: number; total: number }>(`/admin/support/complaints/${organizationId}`),
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
      byMarket: (params?: ReportRange) =>
        request<MarketRevenueReport>(`/admin/reports/by-market${qs(params ?? {})}`),
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
/**
 * An open chargeback. The platform is merchant of record, so a dispute is money the platform
 * has to answer for, with a deadline the provider sets and nobody here can extend.
 */
export interface DisputeRow {
  id: string;
  provider: string;
  providerDisputeId: string;
  status: string;
  amountMinor: number;
  currency: string;
  reason: string | null;
  /** When the provider stops accepting an answer. Null when it set no deadline. */
  evidenceDueBy: string | null;
  createdAt: string;
  bookingId: string | null;
  organization: { id: string; name: string } | null;
}

export interface OpenDisputes {
  disputes: DisputeRow[];
  /** Disputed money per currency. Never summed across them. */
  atRisk: { currency: string; totalMinor: number }[];
}

export interface Paged<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface AuthUser {
  id: string;
  /**
   * Null for an account that signed up by phone and has not given an email address. Such an
   * account carries a placeholder internally; the API never sends it, and nothing may treat
   * it as contact information.
   */
  email: string | null;
  fullName: string;
  roles: string[];
  /**
   * What this account may do in the back office, as the server computes it.
   *
   * Present so the console can offer an operator their OWN work instead of all twenty-four
   * menu items and a landing page that refuses them. It is never authorization: every route
   * still enforces its own guard against the grants in the database, so a client holding a
   * stale list can ask and be refused, and nothing more. Empty for everybody who is not
   * platform staff.
   */
  adminPermissions?: string[];
  /**
   * Where this session stands on the second factor. Only meaningful for back-office accounts:
   * `required` with `verified: false` means the console must send the person to enrollment
   * (`enrolled: false`) or back to sign-in (`enrolled: true`). `stepUp` says whether the server
   * can hold an authenticator at all ('available'), cannot ('unconfigured': sensitive actions are
   * blocked until an operator sets MFA up), or is a developer machine with MFA off ('dormant').
   */
  mfa?: {
    required: boolean;
    enrolled: boolean;
    verified: boolean;
    verifiedAt: number | null;
    stepUp?: 'available' | 'unconfigured' | 'dormant';
  };
  /**
   * The state this customer last told us they were in, for the place-of-supply field.
   *
   * Not a setting and not an address — just their last answer, so the same optional question
   * is not put to them on every purchase. Absent for a first-time buyer.
   */
  lastBuyerRegion?: string | null;
  /**
   * The number that receives sign-in codes and WhatsApp booking updates, when there is one.
   *
   * Read at request time rather than carried in the token: a number added a moment ago would
   * otherwise not appear until the token was refreshed, so the profile would still say "no
   * phone number" to somebody who had just added one.
   */
  phone?: string | null;
  phoneVerified?: boolean;
  memberSince?: string;
  locale?: string | null;
  /** Where the person says they live (ISO alpha-2), or null. Absent from an older API. */
  countryOfResidence?: string | null;
}
export interface UserProfile extends AuthUser {
  status: string;
  createdAt: string;
  memberships: { organizationId: string; role: string; status: string }[];
}
export interface AdminUser {
  id: string;
  /** For a phone-only account this is a placeholder; show it through `adminContact`. */
  email: string;
  /** E.164, or null for an account that has never added one. */
  phone?: string | null;
  fullName: string;
  roles: string[];
  status: string;
  createdAt: string;
  /**
   * ACTIVITY countries: where the account bought tickets, plus where the organizations it belongs
   * to are registered. Kept under its old name for compatibility; `activityCountries` is the same.
   */
  countries: string[];
  /*
    Country EVIDENCE, each kind kept apart and labelled by where it came from. All optional:
    an API older than them sends none, and the console then shows activity only, as before.
  */
  /** Same as `countries`. */
  activityCountries?: string[];
  /** Where the person says they live (chosen in their profile), ISO alpha-2. Never inferred. */
  countryOfResidence?: string | null;
  /** The network's country at sign-up (edge header) - a hint, not a residence. */
  detectedCountry?: string | null;
  /** How `detectedCountry` was obtained ('network'). */
  detectedCountrySource?: string | null;
  /** The VERIFIED number's calling code, `+91` / `+1` - a fact about the number, not the person. */
  phoneCallingCode?: string | null;
  /** The same with the countries sharing it, `+1 (US/CA)`. */
  phoneCallingCodeLabel?: string | null;
}

/** Account counts by country, role and status, for the directory overview. */
export interface UserDirectorySummary {
  total: number;
  /** Accounts with no ACTIVITY country (no booking or organizer country). */
  withoutCountry: number;
  /** ACTIVITY countries. An account active in two is counted in both, so these exceed `total`. */
  byCountry: { country: string; count: number }[];
  /** Same as `withoutCountry`, under the name that says what it counts. */
  withoutActivityCountry?: number;
  /** Accounts with no country evidence of any kind (no residence, network, phone or activity). */
  withoutAnyCountryEvidence?: number;
  /** Residence, as chosen by the person. */
  byResidence?: { country: string; count: number }[];
  /** The network's country at sign-up. */
  byDetected?: { country: string; count: number }[];
  /** Verified numbers by calling code, `+1 (US/CA)`. */
  byPhoneCallingCode?: { code: string; count: number }[];
  byRole: { role: string; count: number }[];
  byStatus: { status: string; count: number }[];
}

export type UserDirectoryFilters = {
  q?: string;
  role?: string;
  status?: string;
  country?: string;
};

/** One of an event's images, as a path for `apiAssetUrl`. */
export interface EventImageView {
  id: string;
  /** The original upload. Prefer `variants` through `eventImageSource`. */
  path: string;
  /** Copies cut to each place an image is shown. Absent on an older API. */
  variants?: Partial<Record<EventImageVariantName, string>>;
  /** Where the crops are centred, as fractions of the width and height. */
  focalPoint?: FocalPoint;
}
export interface OrgEventImage extends EventImageView {
  contentType: string;
  sizeBytes: number;
}
/** An event's images in order — the first is the cover, also given as `imagePath`. */
export interface EventGallery {
  imagePath: string | null;
  imageVariants?: Partial<Record<EventImageVariantName, string>> | null;
  images: OrgEventImage[];
}

/** What kind of content a listing is, outside production. See the API's common/content-label.ts. */
export type ContentLabel = 'DEMO' | 'TEST';

export interface PublicEventCard {
  id: string;
  /**
   * Outside production only: DEMO for curated sample content, TEST for test data, null in
   * production (and on an older API). Display only; it never decides what can be bought.
   */
  contentLabel?: ContentLabel | null;
  title: string;
  slug: string;
  category: string;
  venue: {
    name: string;
    city: string;
    country: string;
    /** ISO alpha-2 of the venue's country when it is a declared market. Absent on an older API. */
    countryCode?: string | null;
    /**
     * The venue's IANA zone, so the card's date is the time at the venue rather than in the
     * reader's browser. Optional: an older API and cards saved before it do not carry one.
     */
    timezone?: string | null;
  };
  organizer: string;
  nextSessionAt: string | null;
  fromPriceMinor: number | null;
  currency: string;
  /** The organizer's image, as a path for `apiAssetUrl`. Absent on saved cards from before. */
  imagePath?: string | null;
  /** The cover's copies; see `eventImageSource`. Absent on saved cards from before. */
  imageVariants?: Partial<Record<EventImageVariantName, string>> | null;
}
/** A performer or presenter on an event. Name is required; the rest is optional. */
export interface EventArtist {
  name: string;
  role?: string | null;
  bio?: string | null;
}

/** The details a buyer checks before paying. All optional: an older API sends none of them. */
export interface EventDetails {
  /** The youngest age admitted: 16 means "16+". Null or absent: no age limit. */
  ageLimit?: number | null;
  /** The organizer's terms, one per line. */
  termsAndConditions?: string | null;
  artists?: EventArtist[] | null;
}

export interface PublicEvent extends EventDetails {
  id: string;
  /**
   * Outside production only: DEMO for curated sample content, TEST for test data, null in
   * production (and on an older API). Display only; it never decides what can be bought.
   */
  contentLabel?: ContentLabel | null;
  title: string;
  slug: string;
  category: string;
  /** The cover image, as a path for `apiAssetUrl`. Null when none was uploaded. */
  imagePath?: string | null;
  /** The cover's copies; see `eventImageSource`. */
  imageVariants?: Partial<Record<EventImageVariantName, string>> | null;
  /** Every image, cover first. Absent on an older API. */
  images?: EventImageView[];
  description: string | null;
  refundPolicy: string | null;
  feeMode: string;
  /** Nobody is charged: no checkout, no fees, tickets issued the moment they book. */
  isFree: boolean;
  /** The organizer takes cash at the venue, so the buyer may reserve and pay on arrival. */
  cashAccepted?: boolean;
  venue: {
    name: string;
    city: string;
    country: string;
    address: string | null;
    /**
     * The venue's IANA zone. Session times are rendered in THIS, not the reader's device:
     * a buyer abroad planning a trip must see the time printed on the ticket. Optional for
     * an older API that did not send it.
     */
    timezone?: string | null;
  };
  /**
   * The zone the event's times are printed in: the venue's, else the one zone its country has.
   * Absent on an older API; `venue.timezone` is the stored column and can be null.
   */
  timeZone?: string | null;
  organizer: {
    id: string;
    name: string;
    /** Checked by the platform team. Absent on an older API. */
    verified?: boolean;
    logoUrl?: string | null;
    description?: string | null;
    website?: string | null;
    instagramUrl?: string | null;
  };
  sessions: {
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    /**
     * The zone THIS session's time is printed in - the same zone its booking and ticket use (a
     * show in a cinema's screen is on the cinema's clock). Absent on an older API.
     */
    timeZone?: string | null;
    /**
     * This session sells named seats, so the buyer picks from a map rather than a quantity.
     *
     * A fact about the SESSION, not the event: two sessions of the same tour can differ, one
     * in a seated theatre and one in a standing room.
     */
    seatBased?: boolean;
    ticketTypes: {
      id: string;
      name: string;
      priceMinor: number;
      currency: string;
      maxPerOrder: number;
      available: number;
      /** Named seat on the map, or capacity from the mapped GA/VIP zone. */
      inventoryKind?: 'SEAT' | 'ZONE';
      /** Inside, before or after the organizer's sales window. Absent on an older API. */
      saleState?: 'ON_SALE' | 'NOT_YET' | 'CLOSED';
      /** When sales open, only for NOT_YET. */
      salesStartAt?: string | null;
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
  /** Ask to pay in cash at the venue. Refused unless the organizer has enabled it. */
  paymentMethod?: 'ONLINE' | 'CASH';
}
export interface BookingResult {
  id: string;
  status: string;
  currency: string;
  holdExpiresAt: string;
  fees: {
    /**
     * The currency these amounts are in.
     *
     * The API has always returned it; this type left it out, so every screen formatting a
     * total fell back to `money()`'s INR default. Correct only for as long as nothing is
     * priced in anything else — and silently wrong the day something is.
     */
    currency: string;
    subtotalMinor: number;
    bookingFeeMinor: number;
    paymentFeeMinor: number;
    customerFeeMinor: number;
    /**
     * The platform fee ALL-IN — what it costs the customer once its own tax is counted.
     *
     * One number rather than two, because "what does this platform charge me" has one answer
     * and neither the base nor the tax on it is that answer. Optional so an older API keeps
     * working; the client falls back to `customerFeeMinor`.
     */
    customerFeeInclusiveMinor?: number;
    /**
     * A statutory per-ticket maintenance charge for the order, when a jurisdiction imposes
     * one. Server-decided: a client must never compute this, or it can disagree with the
     * server about what a customer owes and the customer finds out at the payment page.
     */
    maintenanceMinor?: number;
    /** Whether that amount is inside the ticket price already, or added to the total. */
    maintenanceTreatment?: MaintenanceTreatment;
    /** The combined rate inside that figure — 1800 for 18%, 0 when nothing is taxed. */
    feeTaxRateBasisPoints?: number;
    feeTaxMinor?: number;
    totalMinor: number;
    discountMinor: number;
    /** Zero unless the seller's market has a configured tax rule. */
    taxMinor: number;
    taxLines: ReceiptTaxLine[];
  };
  /** How this booking is being paid for. CASH means nothing is owed to us online. */
  paymentMethod?: 'ONLINE' | 'CASH';
  /** Null for a free or cash booking: there is no Payment row, and no checkout to send to. */
  payment: { id: string; status: string } | null;
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
  /*
    The rest of what the booking was priced with.

    All optional: the API has returned these for a while and older deployments have not, and a
    checkout that crashes because a field is absent is worse than one that shows a slightly
    plainer breakdown. Undeclared, the payment screen could not show the same numbers the
    event page had already shown — which is how the two came to disagree.
  */
  /** The platform fee all-in, including tax on the fee. */
  customerFeeInclusiveMinor?: number;
  customerFeeMinor?: number;
  feeTaxRateBasisPoints?: number;
  feeTaxMinor?: number;
  /** A statutory per-ticket charge, when the jurisdiction sets one. */
  maintenanceMinor?: number;
  maintenanceTreatment?:
    'NOT_APPLICABLE' | 'INCLUDED_IN_TICKET_PRICE' | 'ADDED_TO_TICKET_PRICE' | 'UNCONFIRMED';
  buyerName: string;
  buyerEmail: string;
  event: {
    /** Seeds the recommendations on the confirmation, so they stay in this booking's market. */
    id?: string;
    title: string;
    slug: string;
    /** The organizer's terms. False means no refund is offered for this event. */
    refundsEnabled?: boolean;
    refundCutoffHours?: number;
    /** The organizer's own words about refunds, when they wrote any. */
    refundPolicy?: string | null;
  };
  eventSession: { id: string; startsAt: string };
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
  /** Where the show is: the cinema, else the event's venue. Optional for older APIs. */
  place?: { name: string; city: string | null } | null;
  /**
   * Seats bought, for a reserved-seating show. Held seats before payment, ticketed seats
   * after — so the label list reads the same either side of the transaction. Empty for
   * general-admission events, which have no seats to name.
   */
  seatLabels?: string[];
}
/**
 * What `POST /bookings/guest` answers: the ordinary booking result, plus the session token.
 *
 * The token is optional because a browser that already had one keeps using it. A response
 * with no token and no token sent leaves the caller unable to read its own booking, so the
 * caller treats that as "we cannot follow this booking here" and points the buyer at the
 * emailed link instead of pretending otherwise.
 */
export interface GuestBookingResult extends BookingResult {
  anonymousSessionToken?: string;
}

/**
 * What asking for money back answers with — and it is two different things.
 *
 * A paid booking creates a refund REQUEST that somebody at the organizer reads and decides, so
 * it comes back with an id and a status. A free booking has no money to return: the tickets are
 * cancelled outright, there and then, and the answer is that outcome instead. The account route
 * has always behaved this way; a client that assumed one shape printed an empty status line for
 * every free booking, which is why these are written out separately rather than as one type with
 * everything optional.
 */
export type GuestRefundRequest =
  | {
      id: string;
      status: string;
      amountMinor?: number;
      booking?: { currency: string };
    }
  | {
      outcome: 'CANCELLED';
      bookingId: string;
      bookingStatus: string;
      ticketIds: string[];
      amountMinor: 0;
    };

/** Narrows the answer above: true when the tickets were cancelled rather than a refund requested. */
export function isFreeCancellation(
  result: GuestRefundRequest,
): result is Extract<GuestRefundRequest, { outcome: 'CANCELLED' }> {
  return 'outcome' in result;
}

export interface BookingSummary {
  id: string;
  reference: string | null;
  status: string;
  event: { title: string; slug: string };
  eventSession: { startsAt: string };
  _count: { tickets: number };
  /**
   * The zone the show time is displayed in — the same value `BookingDetail.timeZone` carries,
   * so a row in the list and the detail it opens print the same time. Optional for an older API.
   */
  timeZone?: string | null;
}
export interface WalletTicket {
  id: string;
  serial: string;
  status: string;
  holderName: string | null;
  ticketType: string;
  event: { title: string; slug: string };
  startsAt: string;
  /**
   * Null when the ticket's barcode is a vendor code the server cannot draw as a QR. Every
   * view must fall back to its "QR unavailable" rendering rather than an empty image.
   */
  qrDataUrl: string | null;
  /** Withheld (null) from a buyer who has transferred the ticket to someone else. */
  qrToken?: string | null;
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
  /** The venue's own timezone. Render the show time in THIS, not the device's. */
  timezone?: string | null;
  // Attendee identity (ADR-031).
  assignmentStatus?: AttendeeAssignmentValue;
  attendeeName?: string | null;
  ownedByViewer?: boolean;
  /** True when the ticket has been transferred away from the viewer; no QR is returned. */
  transferred?: boolean;
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
  /** The venue's (or cinema's) IANA zone for `startsAt`. */
  timeZone?: string | null;
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

/** Everything an invoice must name about the seller. All optional until a market needs it. */
/**
 * A cinema as the admin legal-type screen lists it. Where it is comes from its venue first.
 * The legal type (local body, format, cooling) decides which price limit applies, so only the
 * platform team sets it.
 */
export interface AdminCinemaRow {
  id: string;
  name: string;
  organization: { id: string; name: string };
  venueName: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  localBodyType: LocalBodyType | null;
  cinemaFormat: CinemaFormat | null;
  climateType: ClimateType | null;
  updatedAt: string;
}

export interface CinemaLegalTypeBody {
  localBodyType: LocalBodyType | null;
  cinemaFormat: CinemaFormat | null;
  climateType: ClimateType | null;
  /** Kept on the audit entry. At least 5 characters. */
  reason: string;
}

/** One row of the cinema pricing rule table, as the admin console reads it. */
export interface CinemaPricingPolicyRow {
  id: string;
  version: number;
  country: string;
  region: string;
  district: string;
  city: string;
  currency: string;
  localBodyType: LocalBodyType | null;
  cinemaFormat: CinemaFormat | null;
  climateType: ClimateType | null;
  seatCategory: string | null;
  maintenanceChargeMinor: number;
  maintenanceTreatment: MaintenanceTreatment;
  onlineFeePolicy: OnlineFeePolicy;
  onlineFeeCapMinor: number | null;
  ticketPriceMinMinor: number | null;
  ticketPriceMaxMinor: number | null;
  ticketPriceRule: string | null;
  status: CinemaPricingPolicyStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  regulatoryReference: string;
  regulatoryDocumentUrl: string | null;
  /** Internal. Admin console only — never rendered to an organizer or a customer. */
  notes: string | null;
  updatedAt: string;
}

/** What an organizer is told about the order their cinema is sold under. */
/**
 * A seat category as the operator sees it, alongside the class a regulator prices it by.
 *
 * `name` is theirs — Gold, Lounger, Platinum. `regulatoryClass` is the small fixed set that
 * appears in rate orders. The two are kept apart because reading one out of the other is the
 * inference that let a "Lounger" sell with no ceiling while an identical "Recliner" was capped.
 */
export interface SeatClassMapping {
  id: string;
  name: string;
  regulatoryClass: 'REGULAR' | 'RECLINER' | 'PREMIUM' | 'NON_PREMIUM' | null;
  basePriceMinor: number;
  /**
   * What `basePriceMinor` is in: the cinema's venue currency. Null when the cinema's country
   * is not one the platform sells in, and then no price should be shown at all.
   */
  currency?: string | null;
  mapped: boolean;
  /** Per class: does this cinema's pricing order have a rate row for it. Absent on an older API. */
  classHasRate?: Record<string, boolean>;
  /** What each class allows at this cinema. Empty when no order applies; absent on an older API. */
  classRates?: RegulatoryClassRate[];
}

/** The legal price band for one regulatory seat class at one cinema. */
export interface RegulatoryClassRate {
  regulatoryClass: 'REGULAR' | 'RECLINER' | 'PREMIUM' | 'NON_PREMIUM';
  /** False when no pricing order applies here: any price is the organizer's own. */
  regulated: boolean;
  /** False when the order has no rate for this class here: it cannot be sold online at all. */
  sellable: boolean;
  maxMinor: number | null;
  minMinor: number | null;
  regulatoryReference: string | null;
  status: string;
}

export interface CinemaComplianceView {
  jurisdiction: {
    country: string | null;
    region: string | null;
    district: string | null;
    city: string | null;
    localBodyType: string | null;
  };
  classification: { cinemaFormat: string | null; climateType: string | null };
  status: PricingComplianceStatus;
  /**
   * Why INVALID_CINEMA_CLASSIFICATION was given (null for any other status): an unmapped seat
   * category, or a cinema with no classification. Absent on an older API.
   */
  reasonCode?: 'SEAT_CLASS_UNMAPPED' | 'CINEMA_NOT_CLASSIFIED' | null;
  /** The seat categories with no regulatory seat class, when that is the reason. */
  unmappedSeatCategories?: string[];
  summary: string;
  regulatoryReference: string | null;
  effectiveFrom: string | null;
  maintenance: { perTicketMinor: number; treatment: string; description: string } | null;
  maxTicketPriceMinor: number | null;
  ticketPriceRule: string | null;
  onlineFee: { policy: string; description: string; maxMinor?: number | null };
  prices: {
    ticketTypeId: string;
    name: string;
    priceMinor: number;
    ok: boolean;
    reason: string | null;
    /** False when only finished shows use this ticket type. Absent on an older API. */
    upcoming?: boolean;
  }[];
  blocksPublishing: boolean;
  /** The band for every class here, one class at a time. Empty when unregulated; absent on older APIs. */
  classRates?: RegulatoryClassRate[];
}

export interface OrganizationLegalIdentityFields {
  legalName: string | null;
  /** What they registered AS, from their country's own list. */
  legalEntityType: string | null;
  /** LABELS the number — "GSTIN", "EIN", "GST/HST" — so a reader knows what they are seeing. */
  taxRegistrationKind: string | null;
  taxRegistrationNumber: string | null;
  registeredAddressLine1: string | null;
  registeredAddressLine2: string | null;
  registeredCity: string | null;
  registeredRegion: string | null;
  registeredPostalCode: string | null;
  registeredCountry: string | null;
  financeContactName: string | null;
  financeContactEmail: string | null;
  financeContactPhone: string | null;
  /** The named person who answers a customer complaint about this organizer. */
  grievanceOfficerName: string | null;
  grievanceOfficerEmail: string | null;
  grievanceOfficerPhone: string | null;
}

export interface OrganizationLegalIdentity extends OrganizationLegalIdentityFields {
  /** Human-readable labels for the fields still blank. */
  missing: string[];
  /** A registration on file AND nothing missing. Below that, documents are plain receipts. */
  canIssueTaxInvoice: boolean;
}

/** Both organization pictures are uploaded the same way; only the path differs. */
interface OrgImageUrls {
  logoUrl: string | null;
  coverImageUrl: string | null;
}

function uploadOrgImage(id: string, path: 'logo' | 'cover', image: Blob, filename: string) {
  const form = new FormData();
  form.append('file', image, filename);
  return request<OrgImageUrls>(`/organizations/${id}/${path}`, { method: 'POST', body: form });
}

function removeOrgImage(id: string, path: 'logo' | 'cover') {
  return request<OrgImageUrls>(`/organizations/${id}/${path}`, { method: 'DELETE' });
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  /**
   * Open complaints against this organizer, on the admin list only.
   *
   * In the queue because "should this seller keep selling" is the decision the queue exists for,
   * and it cannot be made from a name and a join date.
   */
  openComplaints?: number;
  contactEmail: string | null;
  createdAt: string;
  /**
   * Where the business is registered, and therefore its HOME market.
   *
   * The console uses it to stop showing every organizer every country: a payout provider
   * they cannot use, and a market switcher over currencies they have never sold in, are
   * both noise that reads as something the reader has to understand.
   */
  registeredCountry?: string | null;
  /**
   * The registered legal entity, where it differs from the trading name buyers see.
   *
   * Already sent by `GET /organizations` - `listMine` spreads the whole row - and simply not
   * declared here, so the switcher could not tell two identically named organizations apart.
   */
  legalName?: string | null;
  /** Where the business is registered. The first thing that tells two branches of one brand apart. */
  registeredCity?: string | null;
  registeredRegion?: string | null;
  /** What they registered as: sole proprietorship, Pvt Ltd, LLC. */
  legalEntityType?: string | null;
  /** Whether this organizer takes cash at the venue. Off unless deliberately turned on. */
  cashPaymentsEnabled?: boolean;
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
  /**
   * The accent palette this organization's workspace renders in. Null means the platform
   * default. A brand belongs to the organization, so every member sees the same one.
   */
  consoleTheme?: string | null;
  /**
   * This organizer's events go live without a reviewer. Admin-only to change, and off for
   * every new organization — see the API's Organization.autoApproveEvents.
   */
  autoApproveEvents?: boolean;
  /**
   * The signed-in caller's membership role here (ORGANIZER_OWNER, ORGANIZER_MANAGER or
   * CHECKIN_STAFF), sent by `listMine` so the console can hide actions the API would refuse.
   * Null for a platform administrator, whom no organization role check limits. Absent from
   * the single-organization read. A hint for the UI, never a permission.
   */
  myRole?: string | null;
  /**
   * Counts the console uses to decide what is worth showing.
   *
   * `movies` drives film navigation. It is a count and not a classification: this domain has no
   * organization type, and the `Cinema` model cannot stand in for one - though not because it is
   * the room. `Screen` is the room; `Cinema` is the SITE. Every seat map requires a `Screen` and
   * every `Screen` requires a `Cinema`, so any organizer who draws a seat map for ANY event
   * creates one.
   */
  _count?: { members: number; events: number; venues?: number; movies?: number };
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
  /** One of the palettes the design system ships. '' resets to the platform default. */
  consoleTheme?: string;
}
/** A cash booking as the counter sees it. */
export interface CashBooking {
  id: string;
  reference: string | null;
  buyerName: string;
  buyerEmail: string;
  totalMinor: number;
  currency: string;
  status: string;
  eventTitle: string;
  startsAt: string;
  /** The show's zone (IANA), so its time reads on the venue's clock. Null when unknown. */
  timezone?: string | null;
  collectedAt: string | null;
  collectedBy: string | null;
}
export interface OrgMember {
  id: string;
  role: string;
  status: string;
  user: { id: string; email: string; fullName: string };
}
/** What removing a member returns: the member, and the access that was taken back with them. */
export interface RemovedMember extends OrgMember {
  revoked?: {
    /** Check-in devices they registered or were assigned, now revoked. */
    devices: number;
    /** Offline check-in activations they approved, now revoked. */
    activations: number;
    /** Signed-in sessions ended. Zero when they still work for another organization. */
    sessions: number;
    /** False when sessions were kept because they are still on another organization's team. */
    signedOut: boolean;
  };
}
/**
 * Whether an invitation email left. SENT: a provider took it. NOT_SENT: email is not working
 * here right now; the member stays invited and "Send again" works once it is.
 */
export type InvitationEmailStatus = 'SENT' | 'NOT_SENT';
/**
 * What `invite` returns: the member, and whether the invitation email left. Never the link: it
 * goes to the invitee's address only, so whoever invites cannot accept on their behalf.
 */
export interface InvitedMember extends OrgMember {
  invitationEmail: InvitationEmailStatus;
  /** True when the invite created the account, so the invitee must claim it first. */
  needsPassword: boolean;
}
export interface InvitationSummary {
  email: string;
  organizationName: string;
  role: string;
  needsPassword: boolean;
  expiresAt: string;
}
export interface AcceptedInvitation {
  email: string;
  organizationId: string;
  organizationName: string;
  role: string;
}
export interface NotificationItem {
  id: string;
  type: string;
  subject: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}
/** One channel a person can be reached on, for one kind of message. */
export interface NotificationChannelPreference {
  channel: 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app';
  enabled: boolean;
  /**
   * Policy guarantees this one. A settings screen must show it as required rather than as a
   * switch: nobody should be able to configure themselves into a state where a cancelled
   * show reaches them nowhere, and a toggle that silently does nothing is worse than none.
   */
  required: boolean;
  /** Held back as an emergency fallback — opened only when nothing else got through. */
  deferred: boolean;
}

export interface NotificationPreferenceView {
  /**
   * Whether each channel has anywhere to send to. A WhatsApp switch offered to somebody with
   * no phone number is a switch that cannot work; this is what lets the UI say so.
   */
  destinations: { hasPhone: boolean; phoneVerified: boolean; emailUsable: boolean };
  types: {
    type: string;
    urgency: 'ROUTINE' | 'IMPORTANT' | 'URGENT';
    channels: NotificationChannelPreference[];
  }[];
}

export interface ConsentView {
  channels: {
    channel: string;
    granted: boolean;
    source: string | null;
    decidedAt: string | null;
  }[];
  history: { channel: string; granted: boolean; source: string; createdAt: string }[];
}

/** Whose stream a surface is showing. Stated by every caller — see `notifications.inbox`. */
export type NotificationAudience = 'CUSTOMER' | 'ORGANIZER' | 'ADMIN';

export interface NotificationInbox {
  items: NotificationItem[];
  unreadCount: number;
}

/** The sections of the notification centre, in page order. */
export type NotificationFeedCategory =
  | 'ACTION_REQUIRED'
  | 'BOOKINGS_AND_SALES'
  | 'EVENT_APPROVALS'
  | 'PAYMENTS_AND_PAYOUTS'
  | 'CUSTOMER_ACTIVITY'
  | 'SYSTEM_UPDATES';

export type NotificationFeedSeverity = 'CRITICAL' | 'WARNING' | 'SUCCESS' | 'INFO';

/** One card: every stored notification about one cause, folded together. */
export interface NotificationFeedGroup {
  key: string;
  category: NotificationFeedCategory;
  severity: NotificationFeedSeverity;
  type: string;
  title: string;
  summary: string;
  detail: string | null;
  /** Said instead of an action when only the platform can fix it. */
  ownerNote: string | null;
  action: { label: string; href: string } | null;
  eventId: string | null;
  notificationIds: string[];
  unreadIds: string[];
  read: boolean;
  firstAt: string;
  lastAt: string;
  /** Affected shows, earliest first, each with the zone it should be read in. */
  sessions: { id: string; startsAt: string; timeZone: string | null }[];
  affectedSessions: number;
  /** Checked live. Null means not checked, which is to be read as still a problem. */
  resolved: boolean | null;
  dismissible: boolean;
}

export interface NotificationFeed {
  sections: {
    category: NotificationFeedCategory;
    label: string;
    groups: NotificationFeedGroup[];
  }[];
  unreadCount: number;
  scanned: number;
  truncated: boolean;
}
/**
 * A bookable area inside a venue.
 *
 * `cinemaName` is null unless the space IS a cinema screen. That is the whole difference the
 * model now expresses: an arena, an auditorium and a concert hall are spaces without being
 * cinemas, and a screen is a space that happens to be one.
 */
export interface VenueSpace {
  id: string;
  /** Present on the organization-wide listing, so the console can group without a join. */
  venueId?: string | null;
  name: string;
  capacity: number;
  status: string;
  screenType: string;
  cinemaId: string | null;
  cinemaName: string | null;
  /**
   * What kind of place it is, as the API reads it: a cinema's screen is a cinema screen even
   * when it was created before the kind was stored. Null when nobody has said yet.
   */
  kind?: SpaceKind | null;
  /**
   * EVERY published configuration of this space, current version of each.
   *
   * A space has named layouts - an arena's basketball bowl and its end-stage concert are both
   * live at once - so a single `layout` would show an operator half of what their room does.
   */
  layouts?: { id: string; name: string; layoutKind: string; version: number }[];
  /** The first of them. Kept for callers that only ever wanted one. */
  layout: { id: string; name: string | null; layoutKind: string; version: number } | null;
}

/** A space on its own page: where it is, what it is, what it sells and what uses it. */
export interface SpaceDetail {
  id: string;
  organizationId: string;
  name: string;
  capacity: number;
  status: string;
  screenType: string;
  kind: SpaceKind | null;
  venue: {
    id: string;
    name: string;
    city: string;
    address: string | null;
    country: string | null;
    region: string | null;
    timezone: string | null;
  } | null;
  cinemaId: string | null;
  cinemaName: string | null;
  layouts: { id: string; name: string; layoutKind: string; version: number }[];
  /** Every session ever scheduled in it. A space with any cannot be deleted. */
  sessions: number;
  /** Sessions still to come that are not cancelled. */
  upcomingSessions: number;
  /**
   * For a standing space: each session still to come that is held in it, with how many
   * tickets it has on sale and by how much that is more than the space holds (0 = fits).
   * Older APIs do not send it.
   */
  standingSessions?: {
    sessionId: string;
    eventId: string;
    eventTitle: string;
    startsAt: string;
    onSale: number;
    overCapacityBy: number;
  }[];
}

export interface Venue {
  id: string;
  name: string;
  city: string;
  country: string;
  /** State / province / emirate. Null on every venue created before the field was settable. */
  region: string | null;
  /** IANA zone the venue keeps time in. Every show here is rendered in THIS. */
  timezone: string;
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
  /**
   * What a FIXED `value` is in minor units of; it applies only to bookings in this currency.
   * Null for PERCENT, and for a FIXED code from before coupons carried one — the checkout
   * applies that to INR bookings only.
   */
  currency: string | null;
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
  /** For FIXED only. Omitted, the API uses the currency the organization's venues sell in. */
  currency?: string;
  maxRedemptions?: number;
  /** Show this code to every buyer at checkout. Off unless deliberately set. */
  isPublic?: boolean;
  publicLabel?: string;
  startsAt?: string;
  endsAt?: string;
}
export interface UpdateCouponBody {
  value?: number;
  /** For FIXED only; ignored for PERCENT. */
  currency?: string;
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
  /** Viewers' rating, as the storefront shows it. Null when nobody has rated; absent on older APIs. */
  rating?: MovieRating | null;
}

export interface ScreenBody {
  name: string;
  screenType: string;
  capacity: number;
  kind?: SpaceKind;
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
  /**
   * Seats the published layout sells (aisles excluded); null without one. This - not
   * `capacity`, the number typed when the screen was added - is the room's real size.
   */
  bookableSeats?: number | null;
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
  /** Where a NEW venue created with the space is: decides its currency, tax rules and clock. */
  country?: string;
  region?: string;
}

/*
  `venueId` is omitted and redeclared because the request and the response genuinely differ:
  on create it may be left out (the server makes a venue), and on read it is always present
  and may be null. Widening the request type instead would let a caller send an explicit null
  and mean something the API does not accept.
*/
export interface Cinema extends Omit<CinemaBody, 'venueId'> {
  id: string;
  status: string;
  screens?: Screen[];
  /**
   * Which venue this room sits in.
   *
   * Always set in practice: creating a room without one makes a venue for it, which is how
   * an organization ends up with a venue and a room of the same name looking like two
   * unrelated things in two different lists.
   */
  venueId: string | null;
  /**
   * The venue this room belongs to. Its country decides the currency the room prices in, and
   * the rest is WHERE the cinema is: the cinema's location is the venue's, edited on the venue.
   * The name, city and address are only sent by newer APIs.
   */
  venue?: {
    country: string;
    region: string | null;
    id?: string;
    name?: string;
    city?: string;
    address?: string | null;
    timezone?: string | null;
  } | null;
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

/** `BLOCKED` is a seat the organizer has taken off sale; the public read passes it through. */
export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD' | 'BLOCKED';

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

/**
 * The venue shapes an organizer can start a layout from.
 *
 * The shared catalogue's own type, not a copy: a second list here fell behind the first the
 * moment a template was added, and the console then could not name one the API could build.
 */
export type VenueTemplateKey = SharedVenueTemplateKey;

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
  /** The immutable layout version this session selected when it was scheduled. */
  seatMapId: string;
  /** The VENUE's country, for anything that must behave differently by market. */
  country: string | null;
  /** `id` is the seat category id; `ticketTypeId` is the session's price tier for it. */
  categories: {
    id: string;
    ticketTypeId: string | null;
    name: string;
    colorHex: string | null;
    priceMinor: number;
    /** Layout preview only: a price a template worked out that nobody has set yet. */
    priceSuggested?: boolean;
  }[];
  focal: VenueFocalPoint;
  layoutKind: 'GRID' | 'SECTIONED';
}

/** One block on the venue overview: an outline, what is left in it, and what it costs. */
export interface VenueSectionSummary {
  id: string;
  /** Standing zones are visible context on the plan but are bought by quantity. */
  kind?: 'SECTION' | 'ZONE';
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
  /**
   * The colour and name of the ticket category most of the block's seats are in, so the map can
   * show WHERE each price is. Absent from an older API, which the map draws in a neutral colour.
   */
  colorHex?: string | null;
  categoryName?: string | null;
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
  /** Which version of the space's layout this is. The API has always sent it. */
  version?: number;
  status?: SeatLayoutStatus;
  categories: { id: string; name: string; colorHex: string | null; basePriceMinor: number }[];
  sections: {
    id: string;
    name: string;
    rows: {
      id: string;
      label: string;
      seats: {
        id: string;
        label: string;
        colIndex: number;
        seatCategoryId: string;
        /**
         * SEAT | GAP | WHEELCHAIR | COMPANION. Always sent; typed now because a console that
         * ignored it drew every aisle as a seat with a number on it.
         */
        kind?: string;
      }[];
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
    /** Positions that are not ordinary seats: aisles and accessible places. */
    seatKinds?: { rowLabel: string; seats: number[]; kind: 'WHEELCHAIR' | 'COMPANION' | 'GAP' }[];
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
  /** The cinema listing (event) it belongs to. Absent from an API older than 2026-10-10. */
  eventId?: string;
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
    /** The regulatory class this category is mapped to; null when unmapped. Absent on older APIs. */
    regulatoryClass?: string | null;
    /**
     * The legal price band for that class at this cinema, when a pricing order applies there.
     * `sellable: false` means the class has no rate here and cannot be sold at any price. The
     * server refuses a price outside the band; this is only so the operator sees it first.
     */
    priceLimit?: {
      maxMinor: number | null;
      minMinor: number | null;
      sellable: boolean;
      place: string;
    } | null;
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
  /** The zone the wall-clock times were read in — render results with THIS, not the reader's. */
  timezone: string;
  proposed: number;
  /**
   * Every window the batch can place — populated on a DRY RUN too, which is the point of one.
   *
   * Without it a caller wanting to say "this will create 24 shows" had to compute proposed
   * minus rejected, re-deriving a decision the server had already made.
   */
  creatable: { startsAt: string; endsAt: string }[];
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
  /**
   * Outside production only: DEMO for curated sample content, TEST for test data, null in
   * production (and on an older API). Display only; it never decides what can be bought.
   */
  contentLabel?: ContentLabel | null;
  title: string;
  slug: string;
  posterUrl: string | null;
  certificate: string | null;
  language: string;
  genres: string[];
  runtimeMinutes: number;
  /** Null until someone who watched the film has rated it. Absent on an older API. */
  rating?: MovieRating | null;
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

/**
 * How bookable one screening is, from a customer's point of view.
 *
 * `LIMITED` is the server's "filling fast": 15 or fewer seats left. `SALES_PAUSED` is still
 * listed — a show that vanished would read as a bug to someone about to book it.
 */
export type ShowAvailability = 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'SALES_PAUSED';

/** One bookable screening of a film, with what a showtime picker needs to show it. */
export interface PublicShowRow {
  sessionId: string;
  eventId: string;
  eventSlug: string;
  startsAt: string;
  endsAt: string;
  venue: { id: string; name: string; city: string; country: string };
  cinema: { id: string; name: string; brand: string | null; timezone: string } | null;
  /**
   * The show's calendar date AT THE CINEMA, e.g. "2026-09-13". Group by this — slicing the
   * instant groups by the viewer's zone and files a 00:30 show under the previous day.
   */
  localDate: string | null;
  screen: { id: string; name: string } | null;
  /** Presentation format, from the screen: 2D, 3D, IMAX, 4DX… Free text set by the cinema. */
  format: string | null;
  /** From the film: every screening of a film reports the same language today. */
  language: string;
  currency: string;
  /** The cheapest ticket, as advertised (all-in where the fee mode requires it). */
  fromPriceMinor: number | null;
  seatingType: 'RESERVED' | 'GENERAL_ADMISSION';
  availability: ShowAvailability;
  /** Null for general admission, which has no seat rows. */
  seatsAvailable: number | null;
  seatsTotal: number | null;
}

/** `GET /public/movies/:slug/shows` — the screenings of one film, and the filters present in them. */
export interface PublicMovieShows {
  movie: PublicMovieCard & {
    synopsis: string | null;
    releaseDate: string | null;
    trailerUrl: string | null;
    cast: string[];
    director: string | null;
  };
  shows: PublicShowRow[];
  /** Distinct values in `shows`. `dates` are cinema-local YYYY-MM-DD. */
  filters: { dates: string[]; cities: string[]; formats: string[]; languages: string[] };
  meta: { total: number; returned: number; limit: number };
}

/**
 * `GET /public/shows/:sessionId` — which show a seat page is for.
 *
 * The seat layout carries nothing about the show itself, so without this the seat page could
 * say only "Select seats": not the film, the cinema, or the day.
 */
export interface PublicShowSummary {
  sessionId: string;
  startsAt: string;
  endsAt: string;
  /** SCHEDULED, PAUSED, CANCELLED or COMPLETED. */
  status: string;
  /**
   * The zone the show is advertised in: the cinema's, else the venue's, else the one zone the
   * venue's country has - the zone the buyer's ticket prints. Null only when none of those is
   * known (an older API also sent null for a room in a venue that is not a cinema).
   */
  timeZone: string | null;
  /** Calendar date of the show in `timeZone`, YYYY-MM-DD. */
  localDate: string;
  event: {
    id: string;
    slug: string;
    title: string;
    experienceType: string;
    /** False means the organizer takes no cancellations for this event. */
    refundsEnabled: boolean;
  };
  /** Set for a film screening whose film is published. */
  movie: {
    slug: string;
    title: string;
    certificate: string | null;
    language: string;
    runtimeMinutes: number;
    genres: string[];
    posterUrl: string | null;
  } | null;
  venue: { name: string; city: string; country: string | null };
  cinema: { id: string; name: string } | null;
  screen: { name: string; format: string | null } | null;
  /**
   * Whether a buyer can complete a purchase for this show, decided by the same rules checkout
   * refuses one by. Optional: an older API sends nothing, and then nothing changes.
   */
  onlineBooking?: {
    /** False when nothing on this show can be bought online. Disable seat picking and pay. */
    open: boolean;
    /** An English sentence for clients with no translation. Never the reason. */
    message: string | null;
    /** Ticket types that cannot be bought even while the show is open. */
    closedTicketTypeIds: string[];
  };
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
/** One session on the organizer calendar, with its event and venue. */
export interface OrganizerCalendarSession {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  event: {
    id: string;
    title: string;
    category: string;
    status: string;
    experienceType: string;
    /** The film a cinema listing is for; null for every other kind of event. */
    movieId: string | null;
  };
  venue: {
    id: string;
    name: string;
    city: string;
    country: string | null;
    timezone: string | null;
  };
  /** The zone of the cinema a seated session's room belongs to; null for general admission. */
  cinemaTimezone: string | null;
  /** The room and cinema of a seated session; null for general admission. */
  screenId: string | null;
  cinemaId: string | null;
  /** Tickets sold and on sale over the session's ticket types; null when it has none. */
  sold: number | null;
  capacity: number | null;
}
export interface OrganizerCalendarResponse {
  sessions: OrganizerCalendarSession[];
  /** More sessions matched than `limit`; the latest ones were left out. */
  truncated: boolean;
  limit: number;
}
/** One show's answer from `GET /organizer-calendar/sale-eligibility`. */
export interface OrganizerSessionSaleEligibility {
  sessionId: string;
  /** Something on the show can be bought online now (the storefront's `onlineBooking.open`). */
  open: boolean;
  /** Nothing on the show is refused. */
  sellable: boolean;
  blockers: {
    code: string;
    owner: 'ORGANIZER' | 'PLATFORM';
    /** The organizer's sentence: what is wrong and what to do. */
    message: string;
    fixPath: string | null;
    subject?: string;
  }[];
  /**
   * The unified answer every organizer screen renders: SELLING, PARTIAL or NOT_SELLING over
   * everything checkout reads. Put into words with `saleStateLabel`; never re-derived.
   */
  state: SaleStateKind;
  reasons: SaleReason[];
  openTicketTypeIds: string[];
  closedTicketTypeIds: string[];
  eventId: string;
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
  /** Set when the session is in a room: buyers pick named seats rather than a quantity. */
  screenId?: string | null;
  seatMapId?: string | null;
  /** The standing space a general-admission session is held in; its capacity caps the offer. */
  standingSpaceId?: string | null;
  /**
   * Where a seated session is. `cinema` is null for a space that is not a cinema screen -
   * an arena or an auditorium - so the place is named from `venue` first.
   */
  screen?: {
    name: string;
    venue?: { name: string } | null;
    cinema?: { name: string } | null;
  } | null;
  ticketTypes?: TicketType[];
}
export interface CounterSaleBody {
  eventSessionId: string;
  items: { ticketTypeId: string; quantity: number; seatIds?: string[] }[];
  buyerName: string;
  /** Optional: without it the confirmation goes to the organization's contact address. */
  buyerEmail?: string;
}
export interface CounterShow {
  sessionId: string;
  startsAt: string;
  eventId: string;
  eventTitle: string;
  isFree: boolean;
  venueName: string | null;
  /** The venue's zone, so the time reads as it does on the door. */
  timezone: string | null;
  /** The venue's country: its zone when the venue has none of its own. */
  country?: string | null;
  spaceName: string | null;
  /** Seats are named on these tickets, so the counter gives seats from the seat map. */
  seated: boolean;
  ticketTypes: {
    id: string;
    name: string;
    priceMinor: number;
    currency: string;
    maxPerOrder: number;
    seatCategoryId: string | null;
    /** Null when it is counted on the seat map instead. */
    left: number | null;
  }[];
}
export interface CounterSaleResult {
  bookingId: string;
  reference: string | null;
  status: string;
  totalMinor: number;
  currency: string;
  ticketCount: number;
  emailedTo: string;
}
export interface EventCancelResult {
  eventId: string;
  status: string;
  datesCancelled: number;
  /** References of the paid bookings a refund was opened for. */
  bookingsRequiringRefund: string[];
  /** Cash bookings on this event still owed back: the platform cannot refund cash. */
  cashToReturn: number;
  /** Refund requests on this event waiting for approval, with their totals per currency. */
  refundsAwaiting?: { count: number; totals: CurrencyTotal[] };
  /** Each cancelled cash booking whose money is still to be handed back. */
  cashReturns?: {
    bookingId: string;
    reference: string | null;
    buyerName: string;
    amountMinor: number;
    currency: string;
    /** The credit note that reversed the sale's receipt. */
    creditNoteNumber?: string | null;
  }[];
  /** The cash still to hand back, per currency. */
  cashTotals?: CurrencyTotal[];
}
/** An amount in one currency. Two currencies are never added together. */
export interface CurrencyTotal {
  currency: string;
  amountMinor: number;
}
/** What cancelling an event would do, read before confirming. Changes nothing. */
export interface EventCancelPreview {
  datesToCancel: number;
  onlineRefunds: { count: number; totals: CurrencyTotal[] };
  alreadyInRefund: number;
  free: number;
  cash: { count: number; totals: CurrencyTotal[] };
}
/** A cancelled cash booking: the money to hand back at the counter, or handed back. */
export interface CashReturnRow {
  bookingId: string;
  reference: string | null;
  buyerName: string;
  buyerEmail: string;
  amountMinor: number;
  currency: string;
  eventId: string;
  eventTitle: string;
  startsAt: string;
  /** The show's zone (IANA), so its time reads on the venue's clock. Null when unknown. */
  timezone?: string | null;
  collectedBy: string | null;
  returnedAt: string | null;
  returnedBy: string | null;
  /** The credit note that reversed this sale's receipt. Null for a sale with no receipt. */
  creditNote?: { id: string; number: string } | null;
}
/** A room an event can be seated in — one that has a published seat map. */
export interface SeatingRoom {
  id: string;
  name: string;
  venueName: string;
  /** The venue the space is in. Null only for an old space never linked to one. */
  venueId: string | null;
  layoutId: string;
  layoutName: string | null;
  layoutKind: string;
  /** Seats that can be sold: aisles and gaps are not counted. */
  sellableSeats: number;
  /** The cinema this space is a screen of. Null for every space that is not a cinema screen. */
  cinemaId?: string | null;
  /**
   * What regulated cinema prices need before this layout can sell here, asked before the
   * event exists. `MAP_CLASSES`: `unmapped` categories need a seat class (`fixPath` is the
   * control). `NO_RULES`: no price rules cover the place yet, so it cannot sell online at all.
   * Absent from an older API, which is read as NONE.
   */
  seatClasses?: {
    state: 'NONE' | 'MAP_CLASSES' | 'NO_RULES' | 'BLOCKED';
    unmapped: string[];
    fixPath: string | null;
  };
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
  /** Overrides the event's tax classification for this ticket type. Null inherits it. */
  taxCategory?: string | null;
}
export interface OrgEventDetail extends EventDetails {
  id: string;
  title: string;
  slug: string;
  category: string;
  description: string | null;
  status: string;
  feeMode: string;
  /** Nobody is charged: no checkout, no booking fee, no platform share. */
  isFree: boolean;
  /** What the event is for tax (one of TAX_CATEGORIES). Null: not classified. */
  taxCategory?: string | null;
  refundPolicy: string | null;
  /** The organizer's refund terms: false means no refunds; otherwise until this many hours before. */
  refundsEnabled?: boolean;
  refundCutoffHours?: number;
  publishedAt: string | null;
  reviewNote: string | null;
  venue: Venue;
  organizationId: string;
  sessions: EventSession[];
  /** The cover image, as a path for `apiAssetUrl`. Null when none was uploaded. */
  imagePath?: string | null;
  /** The cover's copies; see `eventImageSource`. */
  imageVariants?: Partial<Record<EventImageVariantName, string>> | null;
  /** Every image, cover first. */
  images?: OrgEventImage[];
  /** Bookings of any status. An event with none can be deleted. */
  _count?: { bookings: number };
  /** Reviewed details changed while paused: resuming sends it to review unless the org is trusted. */
  needsReviewOnResume?: boolean;
  /** Paused by the platform team, so only they can resume it. */
  pausedByAdmin?: boolean;
  /** The platform team's reason for that pause, in their words. Null when not paused by them. */
  pausedByAdminReason?: string | null;
}
/** What resuming did: `sentForReview` when edits made while paused sent it to the review queue. */
export type EventResumeResult = OrgEventDetail & { sentForReview: boolean };
export interface CreateEventBody extends EventDetails {
  organizationId: string;
  venueId: string;
  title: string;
  category: string;
  description?: string;
  /** Prose shown to buyers. Describes the terms; the two below enforce them. */
  refundPolicy?: string;
  /** Whether a refund can be requested at all. Omitted keeps the platform default (true). */
  refundsEnabled?: boolean;
  /** Hours before the session start after which refunds close. 0 = up to start time. */
  refundCutoffHours?: number;
  feeMode: string;
  /** Declared, never inferred from the ticket prices — see the API's Event.isFree. */
  isFree?: boolean;
  /** What the event is for tax (one of TAX_CATEGORIES). Null clears it. Never inferred. */
  taxCategory?: string | null;
}
/** Whether an event at a venue needs a tax classification, and which ones have a rate there. */
export interface TaxClassificationRequirement {
  /** True only where active tax rules depend on the classification. False while GST is off. */
  required: boolean;
  /** Classifications an active rule can rate here. Any other is refused at checkout. */
  ratedCategories: string[];
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
  /** The booking's own currency. */
  currency: string;
  createdAt: string;
  ticketCount: number;
  paymentStatus: string | null;
  /** ONLINE or CASH. A cash booking has no payment row, so `paymentStatus` is null for it. */
  paymentMethod?: string;
  cashCollected?: boolean;
  /** A cancelled cash booking whose money was handed back at the counter. */
  cashReturned?: boolean;
}
/** The four states an organizer reads a booking in. */
export type AttendeeState = 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'REFUNDED';

// A type rather than an interface so it fits the query-string helper's record parameter.
export type AttendeeFilter = {
  sessionId?: string;
  ticketTypeId?: string;
  status?: AttendeeState;
  checkIn?: 'checked_in' | 'not_checked_in';
  q?: string;
};

/**
 * One attendee row: an issued ticket, or - for a booking with no tickets yet (reserved, or
 * cancelled before confirmation) - one ticket line with its quantity. Contact details and
 * payment are null for gate staff, and an email is null rather than a phone-only placeholder.
 */
export interface AttendeeRow {
  id: string;
  /** Null when no ticket has been issued (reserved or cancelled before confirmation). */
  ticketId: string | null;
  serial: string | null;
  bookingId: string;
  reference: string | null;
  bookedAt: string;
  buyerName: string;
  buyerEmail: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  attendeePhone: string | null;
  ticketTypeId: string;
  ticketType: string;
  quantity: number;
  sessionId: string;
  sessionStartsAt: string;
  /** Formatted in the venue's time zone, by the server. */
  sessionLabel: string;
  timeZone: string;
  seatLabel: string | null;
  checkedIn: boolean;
  checkedInAt: string | null;
  status: AttendeeState;
  ticketStatus: string | null;
  bookingStatus: string;
  /** SUCCEEDED, REFUNDED, CASH_DUE, CASH_PAID, NONE... Null on a free event, or for staff. */
  payment: string | null;
}

export interface AttendeeStateTotals {
  rows: number;
  tickets: number;
  checkedIn: number;
}

export interface AttendeeList extends Paged<AttendeeRow> {
  totals: AttendeeStateTotals & { byStatus: Record<AttendeeState, AttendeeStateTotals> };
  filters: {
    sessions: { id: string; startsAt: string; label: string; timeZone: string }[];
    ticketTypes: { id: string; name: string; sessionId: string }[];
  };
  event: { isFree: boolean };
  viewer: { canSeeContact: boolean; canExport: boolean };
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
  | 'SUPERVISOR_REVIEW_REQUIRED'
  | 'DEVICE_NOT_ACTIVE'
  | 'MANIFEST_NOT_VALID';
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

export interface CounterBookingRow {
  id: string;
  reference: string | null;
  status: string;
  buyerName: string | null;
  ticketCount: number;
  eventTitle: string;
  startsAt: string;
  screenName: string | null;
  cinemaName: string | null;
  /** The venue's zone, so the counter reads the time the way the ticket prints it. */
  timezone: string | null;
  currency: string;
  totalMinor: number;
}

export interface CheckInRosterRow {
  id: string;
  /** The booking this seat belongs to, for a counter reprint. */
  bookingId: string;
  serial: string;
  status: string;
  seatLabel: string | null;
  ticketType: string;
  /** The named attendee if there is one, otherwise whoever bought it. */
  name: string | null;
  reference: string | null;
  /** Set when another cinema's system admits this seat, so the door is not left guessing. */
  admittedElsewhereBy: string | null;
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

/**
 * What a refund request on a FREE booking answers with: its tickets are cancelled at once and
 * no refund row exists, so there is no refund `id` to read — narrow on `outcome` first.
 */
export interface FreeCancellationResult {
  outcome: 'CANCELLED';
  bookingId: string;
  bookingStatus: string;
  ticketIds: string[];
  amountMinor: 0;
}

export interface RefundRow {
  id: string;
  bookingId: string;
  amountMinor: number;
  status: string;
  reason: string;
  ticketIds: string[];
  createdAt: string;
  /** `currency` is the booking's: a refund is paid back in it and has no column of its own. */
  booking?: {
    buyerEmail: string;
    eventId: string;
    currency: string;
    reference?: string | null;
    event?: { title: string };
    /** The payment it goes back to. Read by the admin refund page; absent on an older API. */
    payment?: { id: string; provider: string; providerRef: string | null; status: string } | null;
  };
  /** Who decided it. Absent on lists. */
  processedByUserId?: string | null;
  /** The provider's id for the refund, once one was asked for. */
  providerRef?: string | null;
  /**
   * Set when a provider call lost its answer and the provider could not be asked whether it paid:
   * a person must check the provider dashboard. Absent on an older API.
   */
  manualReviewReason?: string | null;
  manualReviewAt?: string | null;
  updatedAt?: string;
}

/** What `refundRetryCheck` answers. `message` is one plain sentence for the admin. */
export interface RefundRetryCheck {
  allowed: boolean;
  /** TICKETS_RETURNED: the provider accepted it once, so only the money is sent again. */
  stage: 'TICKETS_HELD' | 'TICKETS_RETURNED' | null;
  /** UNKNOWN: the last provider call never answered, so the money may have moved. */
  lastAnswer: 'REFUSED' | 'UNKNOWN';
  refusal: string | null;
  /** True when the only thing missing is the admin's confirmation about the provider dashboard. */
  needsConfirmation: boolean;
  message: string;
  /**
   * What an allowed retry does: SEND the money, or RECORD_PROVIDER_REFUND - the provider already
   * has this refund, so it is recorded and nothing is sent. Null when not allowed. Absent on an
   * older API.
   */
  action?: 'SEND' | 'RECORD_PROVIDER_REFUND' | null;
  /** What the provider said when it was asked for the payment's refunds; null if not asked. */
  providerLookup?: {
    kind: 'FOUND' | 'REFUSED' | 'NONE' | 'UNMATCHED' | 'NOT_PAID' | 'UNAVAILABLE';
    providerRef?: string;
    status?: 'COMPLETED' | 'PROCESSING' | 'FAILED';
    amountMinor?: number;
    reason?: string;
  } | null;
  /** Why the refund is held for a manual check, when it is. */
  manualReviewReason?: string | null;
}
/**
 * What a retry did. FAILED is the provider saying no (or showing no refund); NEEDS_REVIEW is a
 * call that never answered and could not be settled by asking; ERROR is anything else.
 */
export interface RefundRetryResult {
  outcome: 'COMPLETED' | 'PROCESSING' | 'FAILED' | 'NEEDS_REVIEW' | 'ERROR';
  message: string | null;
  providerRef: string | null;
  /** True when the provider already had the refund: it was recorded and no money was sent. */
  recorded?: boolean;
  refund: RefundRow | null;
}

/** The seller's legal + tax identity, plus what is still missing to issue a tax invoice. */
export interface OrganizationLegalIdentity {
  legalName: string | null;
  /** Sole proprietorship, Pvt Ltd, LLC - from the country's own list. */
  legalEntityType: string | null;
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
  legalEntityType?: string;
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
  grievanceOfficerName?: string;
  grievanceOfficerEmail?: string;
  grievanceOfficerPhone?: string;
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

/** A buyer's own document, carrying enough of the booking to recognise what it was for. */
export interface MyReceiptRow extends ReceiptSummary {
  booking: {
    id: string;
    reference: string | null;
    event: { title: string };
    eventSession: { startsAt: string };
  };
}

/**
 * What `/receipts/mine` actually returns.
 *
 * Deliberately the same shape as `ReceiptListPage` rather than `Paged<T>`: this mirrors the
 * endpoint, and the endpoint has paged this way since it was written. The client's job is to
 * describe the server, not to wish it were consistent.
 */
export interface MyReceiptsPage {
  items: MyReceiptRow[];
  total: number;
  page: number;
  pageSize: number;
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
  /**
   * What the rate was applied to. Absent on a booking made before it was stored.
   *
   * Without it a reader cannot tell the GST already inside the platform fee from the GST on
   * the tickets — and the checkout showed both as extra rows above a total that contained
   * them, charging the reader for the same money twice on screen.
   */
  basis?: 'TICKETS' | 'FEES' | 'TICKETS_AND_FEES';
  /** Whether the tax sat inside the price. Absent on an older booking; see `priceBreakdown`. */
  inclusive?: boolean;
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
    event?: { id?: string; title: string } | null;
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
  /** The market's name ("India"), one spelling per country. */
  country: string;
  /** ISO alpha-2 of `country`. Absent only on an older API. */
  countryCode?: string;
  /** 0 for a real place found by name that has nothing on sale yet. */
  eventCount: number;
  /** State or province, on a place found by name, where same-named places are common. */
  region?: string | null;
}

/** How a location guess was arrived at. See the API's LocationService for what each means. */
export type LocationSource = 'coordinates' | 'network' | 'device-region' | 'none';

export interface ResolvedLocation {
  country: string | null;
  city: string | null;
  /** State, province or territory of `city`, when known ("Texas", "Telangana"). */
  region?: string | null;
  source: LocationSource;
  /** True only for a coordinate fix. Anything else is a suggestion to confirm, not apply. */
  confident: boolean;
  /**
   * The country it is safe to filter by — the guess, but only when we sell there.
   *
   * Null whenever we have nothing on sale in the guessed country. Scoping to a country we
   * do not operate in shows an empty storefront, and an empty storefront reads as a dead
   * company rather than as a wrong guess.
   */
  scopeCountry: string | null;
  /**
   * A few cities worth offering immediately — NOT every city on the platform.
   *
   * Named `topCities` so nobody builds a complete menu out of a partial list. Anything
   * beyond these comes from `location.cities({ q })`.
   */
  topCities: SellableCity[];
}

/** One thing standing between this event and a completed purchase. */
/** Who can actually put a sellability issue right. */
export type SellabilityOwner = 'ORGANIZER' | 'PLATFORM';

export interface SellabilityIssue {
  code: string;
  /**
   * Who can fix it.
   *
   * `PLATFORM` issues carry no fix link, because there is no organizer-reachable control for
   * them — a jurisdiction's ticket ceilings come from a government order, not a form.
   */
  owner: SellabilityOwner;
  /** What is wrong, in the organizer's vocabulary. */
  message: string;
  /** What to do about it. */
  fix: string;
  /** Where to go, relative to the organizer console. Null when there is no single screen. */
  fixPath: string | null;
  /** Set only when exactly one show is affected. */
  eventSessionId?: string;
  /** How many shows carry this same fault. */
  affectedSessions: number;
  /** The seat category, ticket type or currency the issue is about. */
  subject?: string;
  /**
   * The shows it affects; empty for a fault that belongs to no one show (an event with no
   * dates). Optional for older APIs, which did not send it.
   */
  sessions?: { id: string; startsAt: string; timeZone: string | null }[];
}

export interface EventSellability {
  eventId: string;
  /** False when at least one blocker exists. A warning never makes this false. */
  sellable: boolean;
  /** Sales that WILL be refused. */
  blockers: SellabilityIssue[];
  /** Sales that will succeed and are probably not what the organizer meant. */
  warnings: SellabilityIssue[];
  checkedAt: string;
}

export interface SectionFeed {
  sections: DiscoverySection[];
  /**
   * The city the feed is filtered to, in its stored spelling, or null when it is filtered by
   * country (or by nothing). Named even when it is empty, so the page can say so.
   *
   * There is no "fell back to all cities" any more: an empty place gets an empty feed. The
   * fallback was the old rule the owner reversed for the whole storefront.
   */
  appliedCity: string | null;
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
  /** The bank's own reference for the transfer that settled it, when there is one. */
  paidReference?: string | null;
  note?: string | null;
  /** Why it did not reach the organizer. Set on a FAILED payout. */
  failureReason?: string | null;
  createdAt: string;
  organization?: { name: string };
}

/** One thing an organizer still has to complete, and what it costs them until they do. */
export interface ReadinessItem {
  key: string;
  severity: 'BLOCKING' | 'IMPORTANT' | 'SUGGESTED';
  title: string;
  consequence: string;
  /** Where to fix it, relative to the organizer console. */
  fixPath: string;
}

/**
 * One thing an organizer still has to do.
 *
 * The dashboard, Get started and the setup card are filtered views of ONE list of these. They
 * used to be three checklists - two of them derived in the browser from different endpoints -
 * which could and did disagree about the same question.
 */
export interface OrganizerAction {
  key: string;
  category: 'BUSINESS' | 'MONEY' | 'OPERATIONS';
  severity: 'BLOCKING' | 'IMPORTANT' | 'SUGGESTED';
  /** Always ORGANIZATION from this endpoint; event sellability is answered against the event. */
  scope: 'ORGANIZATION' | 'EVENT';
  organizationId: string;
  eventId?: string;
  /** Whether something is actually prevented. Never true for an organization gap. */
  blocking: boolean;
  title: string;
  consequence: string;
  fixPath: string;
  actionLabel: string;
  done: boolean;
  /** Shown, never counted against completion. */
  optional?: boolean;
}

export interface OrganizerActionSummary {
  organizationId: string;
  actions: OrganizerAction[];
  progress: { done: number; total: number };
  counts: { blocking: number; important: number; suggested: number };
}

export interface OrganizationReadiness {
  items: ReadinessItem[];
  summary: { blocking: number; important: number; suggested: number };
}

/**
 * Where an organizer's payout setup stands, as the SERVER decides it.
 *
 * The console used to be handed `verifiedAt`, `chargesEnabled`, `payoutsEnabled`,
 * `requirementsDue` and `disabledReason` and left to work out what they meant together - which is
 * how it ended up showing the bare word UNVERIFIED with no indication of whether that stopped
 * anything or whether anybody was waiting on the organizer. Every consumer that reconstructs that
 * logic reconstructs it differently; this one does not reconstruct it at all.
 */
export type PayoutAccountStateCode =
  | 'NO_ACCOUNT'
  | 'DETAILS_REQUIRED'
  | 'UNDER_REVIEW'
  | 'ACTION_REQUIRED'
  | 'RESTRICTED'
  | 'VERIFIED'
  | 'PAYOUTS_ENABLED';

export interface PayoutAccountAction {
  kind: 'ADD_BANK_ACCOUNT' | 'CONTINUE_PROVIDER_ONBOARDING' | 'CONTACT_SUPPORT';
  label: string;
  /** Relative to the organizer console. */
  href: string;
}

/*
  ── UNIFIED FINANCE ────────────────────────────────────────────────────────────────────
  The organizer's financial records across BOTH settlement paths, per currency.

  Every money field that can be ABSENT is optional here on purpose, and a consumer must treat
  absent as "the source cannot prove this" rather than as zero. Absent and zero are different
  financial statements: a legacy payout never stored its discount, which is not the same as a
  payout proving its discount was nothing.
*/

/** Which settlement path produced an entry. */
export type FinancePathCode = 'PLATFORM' | 'PROVIDER';

/** Whether an entry's event attribution can be relied on. */
export type FinanceAttributionCode = 'AUTHORITATIVE' | 'UNKNOWN_LEGACY';

export type FinanceStateCode =
  'PENDING' | 'IN_PROGRESS' | 'PAID' | 'PARTIALLY_REFUNDED' | 'ATTENTION_REQUIRED';

export interface FinanceFeeLineDto {
  key: 'BOOKING' | 'PAYMENT_PROCESSING' | 'PLATFORM' | 'PLATFORM_COMBINED';
  amountMinor: number;
  /**
   * Whether this line came OUT of `organizerNetMinor`.
   *
   * Never sum every line to compute deductions: booking and payment fees are reported and borne
   * by the customer on top of the ticket price. Summing all of them understates what the
   * organizer is owed by exactly those, and the total looks entirely plausible.
   */
  deducted: boolean;
}

export interface FinanceMoneyDto {
  /** What the organizer is entitled to from this record. The only always-present amount. */
  organizerNetMinor: number;
  grossFaceValueMinor?: number;
  discountMinor?: number;
  fees?: FinanceFeeLineDto[];
  refundsMinor?: number;
  adjustmentsMinor?: number;
}

/** What actually moved, where the path moves money. Absent on the platform ledger path. */
export interface FinanceMovementDto {
  transferredOutMinor: number;
  recoveredMinor: number;
  /** Still with the organizer after confirmed recoveries. Not "entitlement not yet sent". */
  stillOutMinor: number;
}

export interface FinanceEntryDto {
  /** The source TABLE, which is not the same axis as the path. */
  sourceType: 'PAYOUT' | 'SETTLEMENT';
  sourceId: string;
  sourceStatus: string;
  state: FinanceStateCode;
  organizationId: string;
  currency: string;
  attribution: FinanceAttributionCode;
  eventId: string | null;
  coveredEventIds?: string[];
  periodStart: string | null;
  periodEnd: string | null;
  money: FinanceMoneyDto;
  movement?: FinanceMovementDto;
}

export interface FinanceComposedEntryDto {
  path: FinancePathCode;
  entry: FinanceEntryDto;
}

export type FinanceWarningCategoryCode = 'HISTORICAL_LIMITATION' | 'FINANCIAL_INTEGRITY';

export interface FinanceWarningDto {
  category: FinanceWarningCategoryCode;
  code:
    | 'EVENT_ATTRIBUTION_UNAVAILABLE'
    | 'DEDUCTION_DETAIL_UNAVAILABLE'
    | 'EVIDENCE_DISAGREEMENT'
    | 'DOUBLE_CLAIM'
    | 'NEEDS_RECONCILIATION'
    /** A settlement cannot say what moved, because the original transfer was never recorded. */
    | 'MOVEMENT_DETAIL_UNAVAILABLE';
  sourceIds: string[];
  detail: string;
}

export interface FinanceSummaryDto {
  entitlementMinor: number;
  paidMinor: number;
  pendingMinor: number;
  attentionMinor: number;
  movement?: FinanceMovementDto;
  refundsMinor?: number;
  deductedFeesMinor?: number;
  counts: { platform: number; provider: number };
}

/**
 * One settlement route's share of a currency group.
 *
 * Provided by the server precisely so a screen showing the two routes separately does not have
 * to add anything up. Summing entries in a component would be a second financial opinion in the
 * browser.
 */
export interface FinancePathSummaryDto extends FinanceSummaryDto {
  path: FinancePathCode;
}

export interface FinanceCurrencyGroupDto {
  currency: string;
  entries: FinanceComposedEntryDto[];
  /** Both routes together. */
  summary: FinanceSummaryDto;
  /** One entry per route PRESENT. A platform-only organization has one, not a zeroed pair. */
  paths: FinancePathSummaryDto[];
  /**
   * Settlements a provider transfer has CLAIMED, and nothing else: what the provider pays the
   * organizer directly. The PROVIDER path above also holds settlements that have moved nothing,
   * whose revenue `/payouts/summary` still counts, so showing it as provider money shows that
   * money twice. Absent when no transfer has claimed anything.
   */
  providerRoute?: FinancePathSummaryDto;
  warnings: FinanceWarningDto[];
}

/**
 * One group per currency. There is no combined total, by design.
 *
 * An organizer with INR and USD gets two groups. Nothing in this shape can hold a figure spanning
 * both, so a cross-currency total is unrepresentable rather than merely discouraged.
 */
export interface UnifiedFinanceDto {
  currencies: FinanceCurrencyGroupDto[];
}

export interface PayoutAccountState {
  organizationId: string;
  code: PayoutAccountStateCode;
  /** Which facts decided it: the bank account, the provider account, or neither. */
  basis: 'NONE' | 'BANK' | 'CONNECT';
  /** Whether PAID ticket sales are affected. A boolean because selling is never "pending". */
  salesAffected: boolean;
  /**
   * Whether money can reach the organizer.
   *
   * Three values, not two: VERIFIED means the bank account was checked and nothing yet proves
   * money can leave, which is PENDING. A boolean forced that to read as "available".
   */
  payouts: 'AVAILABLE' | 'PENDING' | 'UNAVAILABLE';
  /** Whether anybody is waiting on the ORGANIZER. False when the wait is ours. */
  organizerActionRequired: boolean;
  /** Safe organizer-facing sentence. Never provider-internal text. */
  explanation: string;
  action: PayoutAccountAction | null;
  /** A count, never the provider's requirement codes. */
  outstandingRequirements: number;
  /**
   * One entry per provider/market this organizer uses, worst first. THE representation: the flat
   * fields above are a single-row reading kept for older clients and can disagree with a panel.
   */
  providers: PayoutProviderEntry[];
  providerSummary: PayoutProviderSummary;
}

/** One currency's settlement position. Currencies never combine into a total. */
export interface PayoutSummaryCurrency {
  currency: string;
  gross: number;
  discount: number;
  bookingFee: number;
  paymentFee: number;
  organizerFee: number;
  refund: number;
  /** What a payout raised right now would come to. May be negative. */
  net: number;
  /** Already paid out. */
  paid: number;
  /** Committed but not yet paid. */
  pending: number;
  /** Revenue that exists and is not yet eligible. */
  held: number;
  /**
   * Sold online for cancelled events, after refunds: owed back to buyers, never paid out.
   * Optional only because an API older than this field does not send it.
   */
  cancelled?: number;
  /** Cash taken at the venue for bookings that still stand. The organizer already holds it. */
  cash?: number;
  /** Cash taken for bookings cancelled since and not yet handed back: the buyer's money. */
  cashToReturn?: number;
  /**
   * The organizer fee inside `held`, `cancelled`, `cash` and `cashToReturn` (and on cash already
   * handed back), which are stated before it.
   */
  feeNotDeducted?: number;
}

/**
 * The organizer's money, read only.
 *
 * Observational by contract: asking for it creates no payout, claims no revenue and contacts no
 * provider.
 */
export interface PayoutSummary {
  organizationId: string;
  eventId: string | null;
  asOf: string;
  holdDays: number;
  currencies: PayoutSummaryCurrency[];
  heldRevenue: {
    eventId: string;
    eventTitle: string;
    currency: string;
    grossMinor: number;
    payableFrom: string;
  }[];
  /** Money these figures deliberately do not account for. See the server contract. */
  excluded: { providerSettledEvents: number };
}

/** The terms settlements run under, for the platform or for one organization. */
export interface PayoutSetting {
  id: string;
  organizationId: string | null;
  /** Null means inherited: the platform row, then the environment default. */
  holdDays: number | null;
  minPayoutMinor: Record<string, number> | null;
  autoGenerate: boolean | null;
  runFrequency: string | null;
  runAnchorDay: number | null;
  lastRunAt: string | null;
  updatedByUserId: string | null;
  updatedAt: string;
  organization?: { id: string; name: string } | null;
}

export interface PayoutSettings {
  /** What applies when nothing is configured at all. */
  environmentHoldDays: number;
  platform: PayoutSetting | null;
  organizations: PayoutSetting[];
}

/** What an admin may write. Null clears an override back to inherited. */
export interface PayoutSettingsInput {
  holdDays?: number | null;
  minPayoutMinor?: Record<string, number> | null;
  /** Whether the platform raises this scope's settlements by itself. */
  autoGenerate?: boolean | null;
  runFrequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | null;
  /** WEEKLY: ISO weekday 1-7. MONTHLY: day of month 1-28. */
  runAnchorDay?: number | null;
}

/**
 * Where an organizer's money is sent. The account number is NEVER in this shape - only the
 * last four digits, which is what a person matches against a statement.
 */
export interface PayoutAccount {
  id: string;
  currency: string;
  holderName: string;
  bankName: string;
  /** IFSC, routing number or SWIFT/BIC. */
  bankCode: string;
  accountLast4: string;
  verifiedAt: string | null;
  updatedAt: string;
  /** Where the account stands. A saved or changed account waits for staff to check it. */
  status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';
  /** Counts saves. A verification names the version it checked. */
  version: number;
  rejectedAt: string | null;
  /** Why staff turned the details down, in their words. */
  rejectionReason: string | null;
  organization?: { id: string; name: string };
  /** Admin list only: who entered these details. */
  savedBy?: { id: string; email: string } | null;
  /** Admin list only: who verified the current version (they can never pay into it). */
  verifiedBy?: { id: string; email: string } | null;
  /**
   * Admin list only: why the signed-in admin may NOT verify or reject this waiting account -
   * they entered it, or they belong to its organization. Null when they may, or it is decided.
   * Advice for the screen; the decision routes enforce the rule themselves.
   */
  independenceBlock?: 'SAME_PERSON' | 'ORGANIZATION_MEMBER' | null;
}

/** One saved version of a payout bank account. Masked: nothing here can hold a full number. */
export interface PayoutAccountVersion {
  version: number;
  currency: string;
  holderName: string;
  bankName: string;
  bankCode: string;
  accountLast4: string;
  /** holderName, bankName, bankCode, accountNumber, or `initial` for the first save. */
  changedFields: string[];
  status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | 'SUPERSEDED';
  savedAt: string;
  savedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** The admin view of a version also says which staff member decided it. */
export interface AdminPayoutAccountVersion extends PayoutAccountVersion {
  decidedBy: string | null;
}

/** The one reply that carries the full number, after an audited reveal. */
export interface RevealedPayoutAccount extends PayoutAccount {
  accountNumber: string;
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
  /* `contact` is the account's verified phone when there is one; a guest has none and
     Razorpay asks them for it, which is Razorpay's own requirement and not ours. */
  prefill: { name: string; email: string; contact?: string };
  callbackUrl: string;
  /**
   * The Razorpay account currently offers UPI, so Checkout may lead with "Pay by any UPI
   * App" (QR / intent). Optional: an older API omits it, which means "do not add the block".
   */
  upiEnabled?: boolean;
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
  /** The event's selling currency. Money carries its own: `money()` without one shows rupees. */
  currency: string;
  grossTicketSalesMinor: number;
  bookingFeesMinor: number;
  paymentFeesMinor: number;
  refundsMinor: number;
  netOrganizerRevenueMinor: number;
  ticketsSold: number;
  ticketsRemaining: number;
  checkInCount: number;
  salesByTicketType: { ticketType: string; quantity: number; grossMinor: number }[];
  /** Calendar days (YYYY-MM-DD) in the venue's zone, not the viewer's. */
  salesByDay: { day: string; bookings: number; grossMinor: number }[];
  /** The venue zone those days are in. */
  salesDayZone?: string;
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
  /** The event's selling currency. Money carries its own: `money()` without one shows rupees. */
  currency: string;
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
/** The same figures, labelled with the currency they are in. */
export interface AnalyticsCurrencyRevenue extends AnalyticsRevenue {
  currency: string;
  /*
    What `netMinor` takes off gross besides the fee (organizer analytics only):
    netMinor = grossMinor - organizerFeesMinor - refundedSalesMinor - cashGivenBackMinor.
    Optional only because an API older than these fields does not send them.
  */
  /** The organizer's share of completed refunds: the ticket money that came off their sales. */
  refundedSalesMinor?: number;
  /** The rest of those refunds: booking and payment fees returned to buyers, never in gross. */
  refundedOutsideSalesMinor?: number;
  /** Cash handed back at the counter for cancelled cash bookings. */
  cashGivenBackMinor?: number;
}
/** One market an organization trades in, and what it took there. */
export interface AnalyticsCountryRevenue {
  country: string;
  currency: string;
  grossMinor: number;
  bookings: number;
}
/** One market on the organizer dashboard's "By market" table. */
export interface AnalyticsOrganizerMarket {
  /** ISO alpha-2 of the country the currency is sold from, or null when unknown. */
  country: string | null;
  currency: string;
  /** Ticket sales on paid bookings, before fees. */
  grossMinor: number;
  /** After organizer fees and completed refunds. */
  netMinor: number;
  refundsMinor: number;
  paidBookings: number;
  /** Bookings of any status, paid or not. */
  totalBookings: number;
  paymentFailures: number;
}
export interface OrganizerAnalytics {
  organizationId: string;
  attendance: { issued: number; checkedIn: number; checkInRate: number };
  conversion: { total: number; confirmed: number; rate: number };
  repeatVisitors: { totalCustomers: number; repeatCustomers: number; rate: number };
  topTicketType: { name: string; quantity: number } | null;
  capacity: { sold: number; capacity: number; utilization: number };
  /**
   * Present only for OWNER/MANAGER + platform admins, and a LIST.
   *
   * An organizer with venues in two countries has two sets of figures, not one. There is no
   * correct combined total — the platform has no exchange-rate source, and inventing a
   * reporting currency would show a number nobody was ever charged — so the dashboard renders
   * one block per currency.
   */
  revenue?: AnalyticsCurrencyRevenue[];
  refunds?: { currency: string; count: number; amountMinor: number; refundRate: number }[];
  coupons?: { currency: string; redemptions: number; discountMinor: number }[];
  /** Where the money came from. Empty for an organizer trading in one place. */
  countries?: AnalyticsCountryRevenue[];
  /**
   * Every market the organization sells in or has a venue in — including one that has sold
   * nothing — with its money, bookings and payment failures, as the admin dashboard lists them.
   */
  markets?: AnalyticsOrganizerMarket[];
  topEvents?: {
    eventId: string;
    title: string;
    currency: string;
    grossMinor: number;
    bookings: number;
  }[];
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
  /** Omitted for members who may not view the organization's financials. */
  revenue?: AnalyticsRevenue;
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
  /**
   * The money figures per currency sold in, biggest market first. The three totals above add
   * currencies together and are kept only for older clients — show these instead.
   */
  money?: CurrencyMoney[];
  activeOrganizers: number;
  publishedEvents: number;
  paymentFailures: number;
  upcomingPayouts: number;
  confirmedBookings: number;
  pendingOrganizers?: number;
  pendingEvents?: number;
}
/** A market's money on the platform overview: every figure in one currency. */
export interface CurrencyMoney {
  currency: string;
  gmvMinor: number;
  platformRevenueMinor: number;
  refundVolumeMinor: number;
  paidBookings: number;
  /** Bookings of any status in this currency, paid or not. */
  totalBookings: number;
  /** Failed payments on bookings in this currency. */
  paymentFailures: number;
  /** ISO alpha-2 of the country this currency is sold from, or null when unknown. */
  country: string | null;
}
export interface AdminEventRow {
  id: string;
  title: string;
  status: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  organization: { name: string };
  /** `country` is as stored - any spelling; name it with `countryDisplay`. */
  venue: {
    name: string;
    city: string;
    country?: string | null;
    /** The venue's zone; its dates are read on its calendar. Absent from an older API. */
    timezone?: string | null;
  };
  /**
   * When the event actually happens, as opposed to when its row was last edited.
   *
   * A moderator is deciding about something that takes place on a date, and "updated 19
   * September" does not say whether the show has already been and gone. Null where the event has
   * no session at all - which means nobody can buy a ticket to it, and is worth seeing.
   */
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  sessionCount: number;
}
/**
 * One session on the admin calendar.
 *
 * `timezone` is the zone the session's local day and time are read in - the venue's, then its
 * room's - or null when nothing records one. It is never guessed; the console shows a null-zone
 * session in UTC and says so.
 */
export interface AdminCalendarSession {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  timezone: string | null;
  room: string | null;
  event: { id: string; title: string; status: string; category: string };
  organization: { id: string; name: string };
  venue: { name: string; city: string; country: string | null };
}
export interface AdminCalendarResponse {
  data: AdminCalendarSession[];
  /** `truncated` means the window held more sessions than `limit`; narrow the filters. */
  meta: { from: string; to: string; limit: number; truncated: boolean };
}
/** What an admin queue can be grouped by. Which ones a given queue accepts is server-side. */
export type AdminGroupBy = 'country' | 'organizer' | 'event' | 'currency';

export interface AdminGroupRow {
  /**
   * What to filter the list by to see this group's rows, or null when the group is "not recorded".
   *
   * For a country grouping this is the country itself; for an organizer or event it is the id,
   * because a name is not unique and a filter built on one would quietly merge two organizations
   * that happen to share it.
   */
  key: string | null;
  label: string;
  count: number;
  /**
   * Money in the group, one entry PER CURRENCY, never summed together.
   *
   * A group selling in INR and USD has two entries. Adding them would be the defect that once
   * showed a payout total of rupees and dollars as rupees.
   */
  totals: { currency: string; totalMinor: number }[];
}

/**
 * Narrows an admin list to one row of its grouped summary.
 *
 * `groupBy` on its own narrows nothing: it says which summary is on screen while no group has
 * been clicked. `groupKey` is what narrows, and `ADMIN_GROUP_KEY_NONE` selects the group with no
 * value - the "Not recorded" row.
 */
/**
 * The group whose key is null, as a value that survives the wire.
 *
 * Not the empty string: `qs()` above drops empty parameters, so an empty key would leave the
 * browser as no key at all and the request would be refused. Mirrors `GROUP_KEY_NONE` on the API.
 */
export const ADMIN_GROUP_KEY_NONE = '__none__';

/**
 * What to count, and over which rows.
 *
 * `status` and `q` are the SAME filters the list under the summary is showing, and sending them is
 * not optional in practice: a summary counted over every row sits above a list that is filtered,
 * and the two numbers disagree with nothing on screen to say which is right.
 */
export type AdminGroupQuery = {
  groupBy: AdminGroupBy;
  status?: string;
  q?: string;
} & AdminListFilters;

/**
 * The filters the finance and operations queues share, as the API reads them.
 *
 * `country` is an ISO alpha-2 code. `from` and `to` are calendar days, `YYYY-MM-DD`, in UTC and
 * inclusive at both ends - the server refuses any other shape with a 400 rather than guessing.
 * A type alias, not an interface, for the same `qs()` reason as `AdminGroupFilter` below.
 */
export type AdminListFilters = {
  country?: string;
  organizationId?: string;
  eventId?: string;
  from?: string;
  to?: string;
};

export type AdminGroupFilter = {
  groupBy?: AdminGroupBy;
  /*
    A type alias rather than an `interface` on purpose. `qs()` takes `Record<string, unknown>`,
    and TypeScript gives an object-literal type an implicit index signature while an interface
    gets none - so as an interface this compiled everywhere except the six call sites that
    actually serialise it.
  */
  groupKey?: string;
};

export interface AdminGroupedSummary {
  resource: string;
  groupBy: string;
  groups: AdminGroupRow[];
  /** True when there were more groups than the summary returns. The list below is still whole. */
  truncated: boolean;
}

export interface AdminBookingRow {
  id: string;
  reference: string | null;
  status: string;
  /** May be a phone-only placeholder on older bookings; show it through `adminContact`. */
  buyerEmail: string;
  totalMinor: number;
  /** Money carries its own currency: `money()` without one formats as rupees. */
  currency: string;
  createdAt: string;
  event: { title: string };
  /** The venue's country, as stored. Name it with `countryDisplay`. */
  country?: string | null;
  paymentStatus: string | null;
}
export interface AdminPaymentRow {
  id: string;
  status: string;
  amountMinor: number;
  /** Money carries its own currency: `money()` without one formats as rupees. */
  currency: string;
  provider: string;
  providerRef: string | null;
  createdAt: string;
  bookingId: string;
  buyerEmail: string;
  /** Which sale this paid for. A payment on its own is an amount and an opaque id. */
  bookingReference: string | null;
  eventTitle: string;
}
/** `GET /admin/organizers/:id/review-signals`. Every field is derived when asked, never stored. */
export interface OrganizerReviewSignals {
  organizationId: string;
  name: string;
  status: string;
  registeredAt: string;
  /** `missing` names fields in a reviewer's words ("legal name"), never a schema path. */
  identity: { complete: boolean; missing: string[] };
  /** Null when the organization has no owner. `emailDomain` is null for a phone-only owner. */
  owner: {
    userId: string;
    emailDomain: string | null;
    accountCreatedAt: string;
    accountAgeDays: number;
  } | null;
  otherOrganizationsByOwner: {
    organizationId: string;
    name: string;
    status: string;
    registeredAt: string;
  }[];
  nameCollisions: { organizationId: string; name: string; status: string; exact: boolean }[];
}

/**
 * One message as support sees it. `delivery` is the API's reading of every fact on the row,
 * because `status` alone says SENT on older rows about messages that never left the platform.
 */
export interface AdminNotificationRow {
  id: string;
  type: string;
  channel: string;
  status: string;
  recipient: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  provider: string | null;
  deliveryState: string | null;
  delivery: {
    verdict:
      | 'DELIVERED'
      | 'IN_APP'
      | 'ACCEPTED'
      | 'NOT_DELIVERED'
      | 'NOT_SENT'
      | 'LOG_ONLY'
      | 'IN_PROGRESS'
      | 'CANCELLED';
    /** true = reached the person, false = did not, null = nobody has said. */
    delivered: boolean | null;
    label: string;
  };
}

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  organizationId: string | null;
  /** Named rather than shown as an id. Null for a platform-wide action. */
  organizationName: string | null;
  correlationId: string | null;
  createdAt: string;
  actor: { email: string; fullName: string } | null;
  /** What the action recorded alongside it (a reason, an amount, a provider reference). */
  metadata?: Record<string, unknown> | null;
}

/* A type alias, not an interface: `qs` takes a `Record<string, unknown>`, and an interface is
   not assignable to one. */
export type AuditFilters = {
  action?: string;
  organizationId?: string;
  entityType?: string;
  /** The market the acting organizer is registered in, ISO alpha-2. */
  country?: string;
  /** Entries about one event: the event itself, or an action that names it. */
  eventId?: string;
  /** One record's history: `Type:id` pairs, comma-separated, at most twenty. */
  subjects?: string;
  /** `YYYY-MM-DD`, UTC, inclusive. */
  from?: string;
  to?: string;
};

/**
 * Who and what is in an audit window, so the console can offer a way in before it lists rows.
 *
 * The country is the ORGANIZER's registered country. An audit row records an action, not a sale,
 * so it has no place of supply and nothing financial may be derived from this.
 */
export interface AuditSummary {
  total: number;
  byOrganization: {
    organizationId: string | null;
    name: string;
    country: string | null;
    count: number;
  }[];
  byAction: { action: string; count: number }[];
  /** Every action the log actually holds, for the filter - not a list typed into a page. */
  actions: string[];
}
/**
 * A tax rule as the admin console edits it.
 *
 * Rates are BASIS POINTS: 1800 is 18%. Amounts are minor units. Both are integers because a
 * float rate reintroduces exactly the rounding drift minor units exist to prevent.
 */
export interface TaxRule {
  id: string;
  label: string;
  rateBasisPoints: number;
  appliesTo: 'TICKETS' | 'FEES' | 'TICKETS_AND_FEES';
  /** Rules sharing a group are alternatives; one wins. Empty means it always applies. */
  taxGroup: string;
  country: string;
  region: string;
  currency: string;
  category: string;
  /** Band bounds on the price of ONE ticket, inclusive. Null is unbounded. */
  minUnitMinor: number | null;
  maxUnitMinor: number | null;
  /** Whether the ticket price already contains this tax. */
  inclusive: boolean;
  split: 'NONE' | 'CGST_SGST';
  priority: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  active: boolean;
  /**
   * Whether this rule applies to a sale happening right now.
   *
   * Server-computed, because `active` alone misleads in both directions — a rule can be
   * switched on and not yet started, or switched on and long superseded.
   */
  inForceNow?: boolean;
}

export interface FeeRule {
  id: string;
  label: string;
  minMinor: number;
  maxMinor: number | null;
  /** FLAT: the fee in minor units. PERCENT: unused, stored as 0. */
  feeMinor: number;
  currency: string;
  /**
   * How the band charges. Optional on input (a band with no type is a fixed amount, as every
   * band was before percentages); always present on what the API returns.
   */
  feeType?: 'FLAT' | 'PERCENT';
  /** PERCENT: the share of the order in basis points. 500 is 5%. */
  feePercentBps?: number | null;
  /** PERCENT, optional: the least the band charges, in minor units. */
  minFeeMinor?: number | null;
  /** PERCENT, optional: the most the band charges, in minor units. */
  maxFeeMinor?: number | null;
  /**
   * Where the band applies — '*' for anywhere.
   *
   * A rule naming a region beats one naming only a country, which beats the wildcard, and
   * the winning specificity supplies the WHOLE schedule. Several Indian states cap what may
   * be charged for booking a cinema ticket online, which one national band cannot express.
   */
  country: string;
  region: string;
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
/**
 * A film's rating: the average of 1–5 stars from the people who watched it — each person's
 * latest rating counted once, across every cinema showing it — and how many of them rated.
 */
export interface MovieRating {
  /** 1.0–5.0, one decimal. */
  average: number;
  /** Viewers who rated — the "votes". */
  count: number;
}
export interface MyMovieReview {
  /** Your latest rating of this film, through whichever cinema you rated it. */
  review: { id: string; rating: number; comment: string | null; eventId: string } | null;
  /** The listing to rate through: one whose show you have watched. Null when you cannot rate yet. */
  eligibleEventId: string | null;
  /** Why you cannot rate yet: no confirmed booking for this film, or your show has not started. */
  reason: 'NO_BOOKING' | 'NOT_STARTED' | null;
}

// ─── Support / Customer Success ───

export type FeedbackKindValue =
  | 'CONTACT'
  | 'BUG'
  | 'FEATURE'
  | 'GENERAL'
  /** Somebody says an organizer wronged them. Countable per organizer, unlike CONTACT. */
  | 'COMPLAINT'
  | 'CSAT'
  | 'ORGANIZER_CSAT';
export type FeedbackStatusValue = 'OPEN' | 'TRIAGED' | 'CLOSED';

/** Payload for `api.support.submit`. */
export interface FeedbackSubmission {
  kind: FeedbackKindValue;
  email?: string;
  /** What the sender calls themselves, shown to the support team. */
  name?: string;
  /** The language the form was shown in, so the acknowledgement email is written in it. */
  locale?: string;
  subject?: string;
  message: string;
  rating?: number;
  metadata?: Record<string, unknown>;
  /**
   * The booking a complaint is about.
   *
   * The organizer is NOT sent and is not accepted: the server derives it from this booking, so
   * nobody can file a complaint against a seller they never bought from.
   */
  bookingId?: string;
}

/** A support submission row as returned by the admin inbox. */
export interface FeedbackRow {
  id: string;
  /** The readable reference the sender was given (ETG-SUP-2026-000142); null only on a row from before references. */
  reference: string | null;
  kind: FeedbackKindValue;
  status: FeedbackStatusValue;
  email: string | null;
  subject: string | null;
  message: string;
  rating: number | null;
  metadata: Record<string, unknown> | null;
  userId: string | null;
  user: { email: string; fullName: string } | null;
  /** Which organizer it is about, where the server could attribute it. */
  organizationId: string | null;
  organizationName: string | null;
  bookingId: string | null;
  bookingReference: string | null;
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
  /** Failed in the last 24 hours - only these make the queue degraded. */
  recentFailed?: number;
  lastFailedAt?: string | null;
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
  /** LOCAL / QA / UAT / PRODUCTION. QA and UAT run NODE_ENV=production, so show this instead. */
  appEnv?: string | null;
  /** Age of the newest VERIFIED backup, from its evidence row (apps/api/src/ops/backup-freshness.ts). */
  backup?: OpsBackupFreshness;
  /** Whether money-critical failures are emailed to operators. Absent on an older API. */
  opsAlerts?: OpsAlertsStatus;
  /** The controlled India pilot (apps/api/src/pilot). Absent on an older API, null when unwired. */
  pilot?: OpsPilotStatus | null;
}

/** The API's PilotStatus. Amounts are integer minor units of each currency. */
export interface OpsPilotStatus {
  mode: 'on' | 'off';
  /** False when pilot mode is on but a variable could not be read: nothing is sellable. */
  valid: boolean;
  problems: string[];
  limits: {
    organizationIds: string[];
    currencies: string[];
    providers: string[];
    gaOnly: boolean;
    maxOrderMinor: number;
    maxDailySalesMinor: number;
    buyerAllowlistCount: number;
    autoPause: boolean;
    webhookRejectThreshold: number;
    webhookWindowMinutes: number;
  } | null;
  today: { day: string; sales: { currency: string; countedMinor: number; capMinor: number }[] };
  lastAutoPause: {
    at: string;
    eventId: string | null;
    organizationId: string | null;
    trigger: string | null;
  } | null;
}

/** The API's BackupFreshness. 'never' means no evidence row, not proof that no dump exists. */
export interface OpsBackupFreshness {
  status: 'fresh' | 'stale' | 'never' | 'unknown';
  lastVerifiedAt: string | null;
  ageHours: number | null;
  maxAgeHours: number;
  lastBackupName: string | null;
  lastRestoreDrillAt: string | null;
}

export interface OpsAlertsStatus {
  configured: boolean;
  status: 'configured' | 'not_configured';
  reason: string | null;
  recipients: number;
  emailProvider: string;
  lastAlertAt: string | null;
  lastAlertKind: string | null;
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
export type ReportCsvName =
  'daily-revenue' | 'by-market' | 'organizer-revenue' | 'refunds' | 'settlement';

export interface DailyRevenuePoint {
  day: string;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
  bookings: number;
}
/** A whole revenue report, for one currency. */
export interface CurrencyRevenueReport {
  currency: string;
  totals: {
    grossMinor: number;
    platformFeesMinor: number;
    refundsMinor: number;
    netMinor: number;
    bookings: number;
  };
  series: DailyRevenuePoint[];
}
/**
 * One country the platform sells in, and what it did in the range.
 *
 * Money stays grouped by currency everywhere else on the reports page, because a rupee and a
 * dollar cannot be added. This is the country view an operator actually asks for, read from the
 * venue of the event - the same fact the platform prices, taxes and routes payment on.
 *
 * Configured markets with no sales are in the list with their zeros. Leaving them out is what
 * made "the reports only show INR" a question rather than a statement.
 */
export interface MarketRevenueRow {
  code: string | null;
  country: string;
  currency: string;
  /** False where a venue holds a country the platform has no market configuration for. */
  configured: boolean;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
  bookings: number;
  organizers: number;
  events: number;
}

export interface MarketRevenueReport {
  from: string;
  to: string;
  markets: MarketRevenueRow[];
}

export interface DailyRevenueReport {
  from: string;
  to: string;
  /**
   * One block per currency traded in the window.
   *
   * This was a single `totals` and `series`, summed across every booking on the platform —
   * valid only while every seller was in one country. There is no combined figure to offer
   * instead: converting needs an exchange-rate source this platform does not have.
   */
  byCurrency: CurrencyRevenueReport[];
}
export interface OrganizerRevenueRow {
  organizationId: string;
  organizationName: string;
  /** An organization selling in two currencies appears once per currency. */
  currency: string;
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
  currency: string;
  outstandingMinor: number;
  paidMinor: number;
  outstandingCount: number;
  paidCount: number;
}
export interface SettlementReport {
  /** One block per payout currency; a rupee and a dollar payout are never added together. */
  byCurrency: {
    currency: string;
    totals: { outstandingMinor: number; paidMinor: number; payoutCount: number };
    byOrg: SettlementOrgRow[];
  }[];
  payouts: Payout[];
}
export interface RefundReport {
  from: string;
  to: string;
  /** One block per currency, the currency of the bookings the refunds returned money from. */
  byCurrency: {
    currency: string;
    totals: { count: number; amountMinor: number };
    byStatus: { status: string; count: number; amountMinor: number }[];
    byDay: { day: string; count: number; amountMinor: number }[];
  }[];
}
export interface PlatformFeesReport {
  from: string;
  to: string;
  byCurrency: {
    currency: string;
    totals: { platformFeesMinor: number };
    series: { day: string; feesMinor: number }[];
  }[];
}
/** Tax on documents: charged on sale documents, given back on credit notes, and the net. */
export interface TaxReportAmounts {
  chargedMinor: number;
  /** A positive amount: the tax the credit notes gave back. */
  reversedMinor: number;
  netMinor: number;
}
export interface TaxReport {
  from: string;
  to: string;
  /** Whether any tax rule is configured at all — not whether this period collected any. */
  taxModelled: boolean;
  note: string;
  /**
   * Per currency, read from the documents issued in the range: tax on the sale documents
   * minus tax on the credit notes (refunds and cancelled cash sales), by issue date.
   */
  byCurrency: {
    currency: string;
    taxChargedMinor: number;
    taxReversedMinor: number;
    netTaxMinor: number;
    invoices: number;
    creditNotes: number;
    breakdown: (TaxReportAmounts & {
      label: string;
      rateBasisPoints: number;
      component: 'CGST' | 'SGST' | 'UTGST' | 'IGST' | null;
      netBaseMinor: number;
    })[];
    /** The venue's country and state: the place of supply for admission. */
    byPlace: (TaxReportAmounts & { country: string | null; region: string | null })[];
    /** YYYY-MM (UTC). */
    byMonth: (TaxReportAmounts & { month: string })[];
    /** Bookings confirmed in the range, before refunds. */
    taxableBaseMinor: number;
    grossMinor: number;
    platformFeesMinor: number;
  }[];
}
export interface TopExperienceRow {
  eventId: string;
  /** An event sold in two currencies appears once per currency. */
  currency: string;
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
  /** Positions by seat kind, for the shared reconciliation (`reconcileSeats`). */
  kindCounts?: { kind: string; count: number }[];
  /**
   * Ticket categories whose price a template worked out and nobody changed or accepted yet.
   * Publishing accepts them, so the publish dialog lists them first.
   */
  suggestedPrices?: { name: string; priceMinor: number }[];
  futureShows: number;
  historicalShows: number;
  createdAt: string;
}

/** One way to size a template to a space: its rows, and the seats it builds. */
export interface LayoutTemplateSizeOption {
  rows: number;
  seatsPerRow: number;
  seats: number;
  /** Seats taken off the ends of the longest rows to land exactly. 0 for even rows. */
  trimmed: number;
}

/** How a template is to meet the space's planned size. */
export type LayoutTemplateFitMode = 'EXACT' | 'AT_MOST' | 'AT_LEAST';

/** A layout as the editor's document, with what the editor needs to know about it. */
export interface LayoutEditorResponse {
  id: string;
  screenId: string;
  version: number;
  status: SeatLayoutStatus;
  /** Only a draft can be saved. A published layout opens read-only. */
  editable: boolean;
  layoutKind: 'GRID' | 'SECTIONED';
  country: string | null;
  focal: VenueFocalPoint;
  document: LayoutDocument;
}

/** One template, described without its seats: what the layout gallery draws and counts. */
export interface LayoutTemplateOutline {
  key: VenueTemplateKey;
  label: string;
  description: string;
  layoutKind: 'GRID' | 'SECTIONED';
  focal: { kind: VenueFocalPoint['kind']; label: string; shape: VenuePoint[] };
  categories: { name: string; colorHex: string; priceWeight: number }[];
  sections: {
    name: string;
    categoryName: string;
    tier: string;
    shape: VenuePoint[];
    rowLabels: string[];
    /** The widest row, in positions (aisles included). */
    positions: number;
    /** 1-based positions that are not ordinary seats, in the generator's own shape. */
    seatKinds: { rowLabel: string; seats: number[]; kind: 'WHEELCHAIR' | 'COMPANION' | 'GAP' }[];
  }[];
  kindCounts: { kind: string; count: number }[];
  /**
   * Present when the outlines were asked for at a seat count: how this template was sized.
   * MATCH lands at or just over the target; TOO_BIG cannot get that small; TOO_SMALL cannot
   * get that big.
   */
  fit?: {
    rows: number;
    seatsPerRow: number;
    seats: number;
    target: number;
    verdict: 'MATCH' | 'TOO_BIG' | 'TOO_SMALL';
    /** Every size it can be built at for this target. Absent from an older API. */
    options?: {
      exact: LayoutTemplateSizeOption | null;
      below: LayoutTemplateSizeOption | null;
      above: LayoutTemplateSizeOption | null;
    };
  };
}

/** What a layout preview adds to the buyer's shape: which layout it is, and its kind counts. */
export interface SeatLayoutPreviewMeta {
  preview: {
    name: string | null;
    version: number;
    status: SeatLayoutStatus;
    kindCounts: { kind: string; count: number }[];
  };
}

/** The buyer's seat read for a layout with no session behind it. `sessionId` is "preview". */
export type SeatLayoutPreview =
  (VenueOverview & SeatLayoutPreviewMeta) | (SeatLayout & SeatLayoutPreviewMeta);

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
