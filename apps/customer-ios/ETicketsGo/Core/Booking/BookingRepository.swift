import Foundation

extension CustomerAPI {
    /// GET /public/location/cities
    static func cities(limit: Int = 30) -> Endpoint<[City]> {
        Endpoint(path: "/public/location/cities", query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    /// GET /public/shows/:sessionId/seats
    static func seats(sessionId: String, section: String? = nil) -> Endpoint<SeatMap> {
        Endpoint(path: "/public/shows/\(sessionId)/seats",
                 query: section.map { [URLQueryItem(name: "section", value: $0)] } ?? [])
    }

    /// POST /bookings/quote — public and side-effect free.
    static func quote(_ body: QuoteBody) -> Endpoint<Quote> {
        Endpoint(method: .post, path: "/bookings/quote", body: try? JSONEncoder.etg.encode(body), isSideEffectFree: true)
    }

    /// POST /bookings. One idempotency key per attempt, reused on retry, so a resent request
    /// replays the stored response instead of creating a second booking.
    static func createBooking(_ body: CreateBookingBody, idempotencyKey: String) -> Endpoint<CreatedBooking> {
        Endpoint(method: .post, path: "/bookings", body: try? JSONEncoder.etg.encode(body), requiresAuth: true,
                 headers: ["idempotency-key": idempotencyKey])
    }

    /// POST /bookings/:id/pay
    /// `returnTo: "app"` asks the server to send the buyer back to the app after the hosted
    /// page (PR #471). A fixed value, not a URL; servers that predate it ignore the body, and
    /// the return is still never treated as payment - the booking is polled.
    static func pay(bookingId: String) -> Endpoint<PaymentStart> {
        Endpoint(method: .post, path: "/bookings/\(bookingId)/pay", body: Data(#"{"returnTo":"app"}"#.utf8), requiresAuth: true)
    }

    /// POST /bookings/:id/cancel — only while PENDING_PAYMENT.
    static func cancelBooking(id: String) -> Endpoint<IgnoredResponse> {
        Endpoint(method: .post, path: "/bookings/\(id)/cancel", requiresAuth: true)
    }
}

/// Booking and checkout. The repository moves the customer's choices to the server and the
/// server's answers back; it holds no pricing or availability logic of its own.
protocol BookingRepository: Sendable {
    func cities() async throws -> [City]
    func seatMap(sessionId: String, section: String?) async throws -> SeatMap
    func quote(_ body: QuoteBody) async throws -> Quote
    func createBooking(_ body: CreateBookingBody, idempotencyKey: String) async throws -> CreatedBooking
    func startPayment(bookingId: String) async throws -> PaymentStart
    func booking(id: String) async throws -> Booking
    func cancel(bookingId: String) async throws
}

enum BookingError: Error, Equatable, Sendable {
    /// QA/PROD builds: holds, payments and cancellations are switched off.
    case writesDisabled

    var userMessage: String {
        "Booking is switched off in this build. Prices and seats you see are live; nothing is reserved."
    }
}

struct RemoteBookingRepository: BookingRepository {
    let client: APIClient

    func cities() async throws -> [City] { try await client.send(CustomerAPI.cities()) }
    func seatMap(sessionId: String, section: String?) async throws -> SeatMap {
        try await client.send(CustomerAPI.seats(sessionId: sessionId, section: section))
    }
    func quote(_ body: QuoteBody) async throws -> Quote { try await client.send(CustomerAPI.quote(body)) }

    func createBooking(_ body: CreateBookingBody, idempotencyKey: String) async throws -> CreatedBooking {
        try requireWrites()
        return try await client.send(CustomerAPI.createBooking(body, idempotencyKey: idempotencyKey))
    }

    func startPayment(bookingId: String) async throws -> PaymentStart {
        try requireWrites()
        return try await client.send(CustomerAPI.pay(bookingId: bookingId))
    }

    func booking(id: String) async throws -> Booking { try await client.send(CustomerAPI.booking(id: id)) }

    func cancel(bookingId: String) async throws {
        try requireWrites()
        _ = try await client.send(CustomerAPI.cancelBooking(id: bookingId))
    }

    private func requireWrites() throws {
        guard client.configuration.bookingWritesPermitted else { throw BookingError.writesDisabled }
    }
}
