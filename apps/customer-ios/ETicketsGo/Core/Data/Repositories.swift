import Foundation

// Feature code depends on these protocols only. MOCK builds get the fixture-backed
// implementations; QA/PROD get the remote ones. Swapping one for the other is the
// whole of the "replace mocks with NestJS" step — no view or view model changes.

protocol CatalogRepository: Sendable {
    func discovery() async throws -> DiscoveryFeed
    func events(_ query: EventQuery) async throws -> Page<EventSummary>
    func event(slug: String) async throws -> EventDetail
    func movieShows(slug: String) async throws -> MovieShows
}

protocol TicketsRepository: Sendable {
    func tickets() async throws -> [Ticket]
}

// MARK: - Remote (QA / PROD)

struct RemoteCatalogRepository: CatalogRepository {
    let client: APIClient

    func discovery() async throws -> DiscoveryFeed { try await client.send(CustomerAPI.discovery()) }
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
}
