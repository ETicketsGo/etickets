import Foundation
import Testing
@testable import ETicketsGo

/// Locates the test bundle (fixtures are its resources, not the app's).
private final class TestBundleToken {}

private func recorded<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
    let bundle = Bundle(for: TestBundleToken.self)
    let url = try #require(bundle.url(forResource: name, withExtension: "json"), "missing fixture \(name)")
    return try JSONDecoder.etg.decode(T.self, from: Data(contentsOf: url))
}

/// Responses recorded from the QA API's public, read-only endpoints (no sign-in, no writes),
/// decoded with the app's live decoder. A model that drifts from what the server actually
/// sends fails here before it fails on a customer's phone. Re-record with
/// `docs/recording-fixtures.md` when the API changes.
@Suite("Recorded QA responses decode")
struct RecordedContractTests {
    @Test("GET /public/discovery")
    func discovery() throws {
        let feed = try recorded("qa-discovery", as: DiscoveryFeed.self)
        #expect(!feed.trendingEvents.isEmpty || !feed.thisWeekend.isEmpty)
        #expect(feed.trendingEvents.allSatisfy { $0.venue.timezone != nil })
    }

    @Test("GET /public/events (paginated)")
    func events() throws {
        let page = try recorded("qa-events", as: Page<EventSummary>.self)
        #expect(page.meta.page == 1 && page.meta.total >= page.data.count)
        #expect(!page.data.isEmpty)
    }

    @Test("GET /public/events/:slug")
    func eventDetail() throws {
        let event = try recorded("qa-event-detail", as: EventDetail.self)
        #expect(!event.sessions.isEmpty)
        #expect(event.timeZone != nil)
    }

    @Test("GET /public/movies/:slug/shows")
    func movieShows() throws {
        let data = try recorded("qa-movie-shows", as: MovieShows.self)
        #expect(data.shows.allSatisfy { $0.timeZone != nil })
    }

    @Test("GET /public/movies (unpaginated cards)")
    func movies() throws {
        let movies = try recorded("qa-movies", as: [MovieSummary].self)
        #expect(!movies.isEmpty)
    }
}
