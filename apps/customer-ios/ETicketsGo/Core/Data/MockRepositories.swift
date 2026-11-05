import Foundation

/// Loads the JSON fixtures in Resources/MockData. They are written in the API's wire format
/// and decoded with the same decoder as live responses, so a fixture that drifts from the
/// contract fails here exactly as a real response would.
struct FixtureStore: Sendable {
    let bundle: Bundle

    init(bundle: Bundle = .main) { self.bundle = bundle }

    func load<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            throw MockError.missingFixture(name)
        }
        return try JSONDecoder.etg.decode(T.self, from: Data(contentsOf: url))
    }
}

enum MockError: Error, Equatable {
    case missingFixture(String)
    case notFound(String)
}

/// A short, fixed delay so loading states are visible and exercised in MOCK.
private func simulatedLatency(_ duration: Duration) async throws {
    if duration > .zero { try await Task.sleep(for: duration) }
}

/// After `allowed` successful calls, every call fails as if offline — for exercising the saved
/// ticket path in MOCK.
final class GoesOffline: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: Int?
    init(after allowed: Int?) { remaining = allowed }
    func check() throws {
        let offline = lock.withLock { () -> Bool in
            guard let left = remaining else { return false }
            if left > 0 { remaining = left - 1; return false }
            return true
        }
        if offline { throw APIError.transport(.notConnectedToInternet) }
    }
}

/// Fails its first call, then succeeds — for exercising error and retry screens in MOCK.
final class FailOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var armed: Bool
    init(armed: Bool) { self.armed = armed }
    func check() throws {
        let fail = lock.withLock { () -> Bool in defer { armed = false }; return armed }
        if fail { throw APIError.transport(.timedOut) }
    }
}

struct MockCatalogRepository: CatalogRepository {
    var fixtures = FixtureStore()
    var latency: Duration = .milliseconds(350)
    var failOnce = FailOnce(armed: false)

    /// Like the server, a chosen city narrows the shelves to that city's events.
    func discovery(city: String?) async throws -> DiscoveryFeed {
        try await simulatedLatency(latency)
        try failOnce.check()
        let feed: DiscoveryFeed = try fixtures.load("discovery")
        guard let city else { return feed }
        let inCity = { (e: EventSummary) in e.venue.city.caseInsensitiveCompare(city) == .orderedSame }
        return DiscoveryFeed(nowShowing: feed.nowShowing, trendingEvents: feed.trendingEvents.filter(inCity),
                             thisWeekend: feed.thisWeekend.filter(inCity), categories: feed.categories)
    }

    /// Filters locally so search and categories behave believably. The real filtering
    /// (`q`, `category`, city scoping) is the server's; this is not a model of it.
    func events(_ query: EventQuery) async throws -> Page<EventSummary> {
        try await simulatedLatency(latency)
        let all: [EventSummary] = try fixtures.load("events")
        let text = query.text?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        let matches = all.filter { event in
            (query.category == nil || event.category == query.category)
                && (query.city == nil || event.venue.city.caseInsensitiveCompare(query.city!) == .orderedSame)
                && (text.isEmpty
                    || event.title.lowercased().contains(text)
                    || event.venue.name.lowercased().contains(text)
                    || event.venue.city.lowercased().contains(text))
        }
        let start = (query.page - 1) * query.pageSize
        let slice = start < matches.count ? Array(matches[start..<min(start + query.pageSize, matches.count)]) : []
        let pages = max(1, Int((Double(matches.count) / Double(query.pageSize)).rounded(.up)))
        return Page(data: slice, meta: PageMeta(
            page: query.page, pageSize: query.pageSize, total: matches.count, totalPages: pages))
    }

    func event(slug: String) async throws -> EventDetail {
        try await simulatedLatency(latency)
        let all: [EventDetail] = try fixtures.load("event-details")
        guard let match = all.first(where: { $0.slug == slug }) else { throw MockError.notFound(slug) }
        return match
    }

    func movieShows(slug: String) async throws -> MovieShows {
        try await simulatedLatency(latency)
        let all: [MovieShows] = try fixtures.load("movie-shows")
        guard let match = all.first(where: { $0.movie.slug == slug }) else { throw MockError.notFound(slug) }
        return match
    }
}

/// Like GET /tickets, answers only for a signed-in session. Includes whatever the MOCK
/// commerce server issued during this run.
struct MockTicketsRepository: TicketsRepository {
    let session: AuthSession
    var fixtures = FixtureStore()
    var latency: Duration = .milliseconds(350)
    var server: MockCommerceServer?
    var network = GoesOffline(after: nil)

    func tickets() async throws -> [Ticket] {
        try await signedIn()
        try network.check()
        let issued = await server?.issuedTickets ?? []
        return issued + (try fixtures.load("tickets") as [Ticket])
    }

    func ticket(id: String) async throws -> Ticket {
        try await signedIn()
        let all: [Ticket] = (await server?.issuedTickets ?? []) + (try fixtures.load("tickets") as [Ticket])
        guard let match = all.first(where: { $0.id == id }) else { throw APIError.server(status: 404, code: "NOT_FOUND", message: "Ticket not found.") }
        return match
    }

    func bookings() async throws -> [Booking] {
        try await signedIn()
        return (await server?.allBookings() ?? []) + (try fixtures.load("bookings") as [Booking])
    }

    func booking(id: String) async throws -> Booking {
        try await signedIn()
        if let live = try? await server?.booking(id: id) { return live }
        let all: [Booking] = try fixtures.load("bookings")
        guard let match = all.first(where: { $0.id == id }) else { throw APIError.server(status: 404, code: "NOT_FOUND", message: "Booking not found.") }
        return match
    }

    private func signedIn() async throws {
        try await simulatedLatency(latency)
        guard await session.accessToken() != nil else { throw APIError.unauthorized }
    }
}
