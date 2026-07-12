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
} from '@eticketsgo/web-kit';

export { tokenStore, ApiRequestError, API_URL };
export type {
  PublicEvent,
  BookingResult,
  BookingDetail,
  WalletTicket,
  BookingSummary,
  BookingRequest,
} from '@eticketsgo/web-kit';
export type PaginatedEvents = Paged<PublicEventCard>;

export const api = {
  register: wk.auth.register,
  login: wk.auth.login,
  me: wk.auth.me,
  listEvents: (params: Record<string, string | undefined>) => wk.publicEvents.list(params),
  getEvent: wk.publicEvents.get,
  createBooking: (body: BookingRequest) => wk.bookings.create(body),
  getBooking: wk.bookings.get,
  createPaymentIntent: wk.bookings.pay,
  mockPay: wk.payments.mockPay,
  wallet: wk.tickets.wallet,
  listBookings: wk.bookings.list,
};
