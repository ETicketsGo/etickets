// Customer-web facade over the shared web-kit client. Keeps the flat call
// shape existing pages use while the client logic lives in one shared package.
import {
  api as wk,
  tokenStore,
  ApiRequestError,
  API_URL,
  type Paged,
  type PublicEventCard,
  type BookingRequest,
  type FeedbackSubmission,
  type AssignAttendeeBody,
  type InviteAttendeeBody,
  type CreateShareBody,
  type ShareExpiryValue,
  type SharePermissionValue,
} from '@eticketsgo/web-kit';

export { tokenStore, ApiRequestError, API_URL };
export type {
  PublicEvent,
  PublicEventCard,
  BookingResult,
  BookingDetail,
  WalletTicket,
  BookingSummary,
  BookingRequest,
  RefundRow,
  PublicMovieCard,
  PublicMovie,
  SeatLayout,
  SeatLayoutSeat,
  SeatStatus,
  Discovery,
  DiscoverySection,
  DiscoverySectionKind,
  OrganizerSpotlight,
  VenueSpotlight,
  OrganizerProfile,
  FeedbackSubmission,
  AttendeeTicket,
  AttendeeSummary,
  AttendeeAssignmentValue,
  InviteResult,
  ShareCreated,
  ShareActivity,
  ResolvedShare,
  SharePermissionValue,
  ShareExpiryValue,
} from '@eticketsgo/web-kit';
export type PaginatedEvents = Paged<PublicEventCard>;

export const api = {
  register: wk.auth.register,
  login: wk.auth.login,
  me: wk.auth.me,
  updateProfile: wk.users.updateProfile,
  listEvents: (params: Record<string, string | undefined>) => wk.publicEvents.list(params),
  getEvent: wk.publicEvents.get,
  createBooking: (body: BookingRequest) => wk.bookings.create(body),
  getBooking: wk.bookings.get,
  createPaymentIntent: wk.bookings.pay,
  mockPay: wk.payments.mockPay,
  wallet: wk.tickets.wallet,
  getTicket: wk.tickets.get,
  // Wallet-pass sandbox (Apple/Google) — projections of an existing valid ticket.
  walletProviders: wk.walletPasses.providers,
  generateWalletPass: (ticketId: string, provider: 'apple' | 'google') =>
    wk.walletPasses.generate(ticketId, provider),
  // Attendee identity (ADR-031): assign / invite / transfer / claim.
  assignAttendee: (ticketId: string, body: AssignAttendeeBody) =>
    wk.attendees.assign(ticketId, body),
  inviteAttendee: (ticketId: string, body: InviteAttendeeBody) =>
    wk.attendees.invite(ticketId, body),
  transferTicket: (ticketId: string, body: InviteAttendeeBody) =>
    wk.attendees.transfer(ticketId, body),
  unassignAttendee: (ticketId: string) => wk.attendees.unassign(ticketId),
  attendeeSummary: (bookingId: string) => wk.attendees.summary(bookingId),
  acceptInvite: (token: string) => wk.attendees.accept(token),
  declineInvite: (token: string) => wk.attendees.decline(token),
  resendInvite: (inviteId: string) => wk.attendees.resend(inviteId),
  // Secure Experience Sharing (ADR-032).
  createShare: (ticketId: string, body: CreateShareBody) => wk.sharing.create(ticketId, body),
  shareActivity: (ticketId: string) => wk.sharing.activity(ticketId),
  revokeShare: (shareId: string) => wk.sharing.revoke(shareId),
  extendShare: (shareId: string, expiry: ShareExpiryValue) => wk.sharing.extend(shareId, expiry),
  changeSharePermission: (shareId: string, permission: SharePermissionValue) =>
    wk.sharing.permission(shareId, permission),
  resolveShare: (token: string) => wk.sharing.resolve(token),
  listBookings: wk.bookings.list,
  requestRefund: (body: { bookingId: string; reason: string; ticketIds?: string[] }) =>
    wk.refunds.request(body),
  refundsForBooking: wk.refunds.forBooking,
  reviewsForEvent: wk.reviews.forEvent,
  myReview: wk.reviews.mine,
  createReview: wk.reviews.create,
  organizerProfile: wk.publicEvents.organizer,
  // Discovery hub (PR-4): unified movies + events + categories feed, and
  // resolved platform feature flags for capability-gated UI.
  discovery: () => wk.discovery(),
  // Discovery Platform sprint: composed strategy sections + category counts.
  discoverySections: (city?: string) => wk.discovery.sections(city),
  // Recommendation Platform: "you might also like" events for an event page.
  recommendations: (params?: { eventId?: string; limit?: number; strategy?: string }) =>
    wk.recommendations(params),
  publicCategories: () => wk.publicCategories(),
  capabilities: () => wk.capabilities(),
  // Movies (PR-3): discovery, detail + showtimes, and per-show seat layout.
  listMovies: (params?: { city?: string; genre?: string; q?: string }) =>
    wk.publicMovies.list(params),
  getMovie: (slug: string) => wk.publicMovies.get(slug),
  showSeats: (sessionId: string) => wk.publicShows.seats(sessionId),
  // Analytics Platform: the signed-in customer's own booking analytics.
  analytics: () => wk.analytics.customer(),
  // Customer Success: contact, bug report, feature request, feedback, CSAT.
  submitFeedback: (body: FeedbackSubmission) => wk.support.submit(body),
  // Notification center (v1.2 WS8): in-app inbox + read state.
  notificationsInbox: (params?: { limit?: number; before?: string }) =>
    wk.notifications.inbox(params),
  notificationsUnreadCount: () => wk.notifications.unreadCount(),
  markNotificationRead: (id: string) => wk.notifications.markRead(id),
  markAllNotificationsRead: () => wk.notifications.markAllRead(),
};
