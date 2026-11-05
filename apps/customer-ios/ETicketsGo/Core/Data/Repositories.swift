import Foundation

// Feature code depends on these protocols only. MOCK builds get the fixture-backed
// implementations; QA/PROD get the remote ones. Swapping one for the other is the
// whole of the "replace mocks with NestJS" step — no view or view model changes.

protocol CatalogRepository: Sendable {
    func discovery(city: String?) async throws -> DiscoveryFeed
    func events(_ query: EventQuery) async throws -> Page<EventSummary>
    func event(slug: String) async throws -> EventDetail
    func movieShows(slug: String) async throws -> MovieShows
}

protocol TicketsRepository: Sendable {
    func tickets() async throws -> [Ticket]
    func ticket(id: String) async throws -> Ticket
    func bookings() async throws -> [Booking]
    func booking(id: String) async throws -> Booking
    func refunds(bookingId: String) async throws -> [Refund]
    func requestRefund(bookingId: String, reason: String) async throws
}

// MARK: - Remote (QA / PROD)

struct RemoteCatalogRepository: CatalogRepository {
    let client: APIClient

    func discovery(city: String?) async throws -> DiscoveryFeed { try await client.send(CustomerAPI.discovery(city: city)) }
    func events(_ query: EventQuery) async throws -> Page<EventSummary> {
        try await client.send(CustomerAPI.events(query))
    }
    func event(slug: String) async throws -> EventDetail { try await client.send(CustomerAPI.event(slug: slug)) }
    func movieShows(slug: String) async throws -> MovieShows {
        try await client.send(CustomerAPI.movieShows(slug: slug))
    }
}

struct RemoteTicketsRepository: TicketsRepository {
    let client: APIClient

    func tickets() async throws -> [Ticket] { try await client.send(CustomerAPI.tickets()) }
    func ticket(id: String) async throws -> Ticket { try await client.send(CustomerAPI.ticket(id: id)) }
    func bookings() async throws -> [Booking] { try await client.send(CustomerAPI.bookings()).data }
    func booking(id: String) async throws -> Booking { try await client.send(CustomerAPI.booking(id: id)) }
    func refunds(bookingId: String) async throws -> [Refund] { try await client.send(CustomerAPI.refunds(bookingId: bookingId)) }
    func requestRefund(bookingId: String, reason: String) async throws {
        _ = try await client.send(CustomerAPI.requestRefund(bookingId: bookingId, reason: reason))
    }
}

extension CatalogRepository {
    /// Discovery with no city scope.
    func discovery() async throws -> DiscoveryFeed { try await discovery(city: nil) }
}
