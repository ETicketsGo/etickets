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

struct MockCatalogRepository: CatalogRepository {
    var fixtures = FixtureStore()
    var latency: Duration = .milliseconds(350)

    func discovery() async throws -> DiscoveryFeed {
        try await simulatedLatency(latency)
        return try fixtures.load("discovery")
    }

    /// Filters locally so search and categories behave believably. The real filtering
    /// (`q`, `category`, city scoping) is the server's; this is not a model of it.
    func events(_ query: EventQuery) async throws -> Page<EventSummary> {
        try await simulatedLatency(latency)
        let all: [EventSummary] = try fixtures.load("events")
        let text = query.text?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        let matches = all.filter { event in
            (query.category == nil || event.category == query.category)
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

struct MockTicketsRepository: TicketsRepository {
    var fixtures = FixtureStore()
    var latency: Duration = .milliseconds(350)

    func tickets() async throws -> [Ticket] {
        try await simulatedLatency(latency)
        return try fixtures.load("tickets")
    }
}

struct MockAccountRepository: AccountRepository {
    var fixtures = FixtureStore()

    func currentUser() async throws -> AuthenticatedUser? { try fixtures.load("me") }
}
