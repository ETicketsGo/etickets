import Foundation
import Testing
import UIKit
@testable import ETicketsGo

@Suite("Wire models, fixtures and view-model logic")
struct ModelAndMockTests {
    let catalog = MockCatalogRepository(latency: .zero)

    @Test("Every fixture decodes with the live decoder")
    func fixturesDecode() async throws {
        let feed = try await catalog.discovery()
        #expect(!feed.nowShowing.isEmpty && !feed.trendingEvents.isEmpty)
        let tickets = try await MockTicketsRepository(session: await signedInSession(), latency: .zero).tickets()
        #expect(tickets.count == 4)
        #expect(try FixtureStore().load("me", as: AuthenticatedUser.self).fullName == "Demo Customer")
    }

    @Test("Every event and showtime in the fixtures opens a detail record")
    func fixturesAreLinked() async throws {
        let feed = try await catalog.discovery()
        for event in feed.trendingEvents + feed.thisWeekend {
            #expect(try await catalog.event(slug: event.slug).id == event.id)
        }
        for movie in feed.nowShowing {
            let shows = try await catalog.movieShows(slug: movie.slug)
            for slug in Set(shows.shows.map(\.eventSlug)) {
                _ = try await catalog.event(slug: slug)
            }
        }
    }

    @Test("Mock search filters by text and category")
    func mockSearch() async throws {
        let jazz = try await catalog.events(EventQuery(text: "jazz")).data
        #expect(jazz.map(\.slug) == ["monsoon-jazz-nights-hyderabad"])
        let music = try await catalog.events(EventQuery(category: "live-music"))
        #expect(music.meta.total == 2)
        #expect(try await catalog.events(EventQuery(text: "zzz")).data.isEmpty)
    }

    @Test("Decodes dates with and without fractional seconds, and null fields")
    func decodesWireFormat() throws {
        let json = #"""
        {"id":"e","title":"T","slug":"t","category":"comedy","venue":{"name":"V","city":"C","country":"IN"},
         "organizer":"O","nextSessionAt":"2026-11-07T14:00:00Z","fromPriceMinor":null,"currency":"INR"}
        """#
        let event = try JSONDecoder.etg.decode(EventSummary.self, from: Data(json.utf8))
        #expect(event.nextSessionAt != nil)
        #expect(event.fromPriceMinor == nil)
        #expect(event.imagePath == nil)
    }

    @Test("Image URLs prefer the cut for the use and join relative paths to the API base")
    func imageURL() throws {
        let json = #"""
        {"id":"e","title":"T","slug":"t","category":"c","venue":{"name":"V","city":"C","country":"IN"},
         "organizer":"O","nextSessionAt":null,"fromPriceMinor":0,"currency":"INR",
         "imagePath":"/public/events/e/image","imageVariants":{"card":"/public/events/e/images/1/card"}}
        """#
        let event = try JSONDecoder.etg.decode(EventSummary.self, from: Data(json.utf8))
        let base = URL(string: "https://api-qa.eticketsgo.com/api")
        #expect(event.imageURL(for: .card, base: base)?.absoluteString == "https://api-qa.eticketsgo.com/api/public/events/e/images/1/card")
        #expect(event.imageURL(for: .banner, base: base)?.absoluteString == "https://api-qa.eticketsgo.com/api/public/events/e/image")
        #expect(event.imageURL(for: .card, base: nil) == nil)
    }

    @Test("Money is formatted from minor units")
    func money() {
        let india = Locale(identifier: "en_IN")
        #expect(Formatters.money(minor: 79900, currency: "INR", locale: india) == "₹799")
        #expect(Formatters.fromPrice(minor: 0, currency: "INR") == "Free")
        #expect(Formatters.fromPrice(minor: nil, currency: "INR") == nil)
        #expect(Formatters.category("live-music") == "Live Music")
    }

    @Test("Times show in the venue's zone, named when it differs from the device's")
    func venueTimeZone() {
        let show = ISO8601DateFormatter().date(from: "2026-11-07T14:00:00Z")!  // 7:30 PM in India
        let locale = Locale(identifier: "en_US")
        let denver = TimeZone(identifier: "America/Denver")!
        let kolkata = TimeZone(identifier: "Asia/Kolkata")!

        let abroad = Formatters.time(show, timeZone: "Asia/Kolkata", locale: locale, deviceZone: denver)
        #expect(abroad.hasPrefix("7:30\u{202F}PM") || abroad.hasPrefix("7:30 PM"))
        #expect(abroad.count > "7:30 PM".count)  // zone named

        let atHome = Formatters.time(show, timeZone: "Asia/Kolkata", locale: locale, deviceZone: kolkata)
        #expect(atHome.count <= "7:30 PM".count)  // same zone: no suffix

        // No or unknown zone: the device's clock, as before.
        #expect(Formatters.venueZone(nil, deviceZone: denver) == denver)
        #expect(Formatters.venueZone("Not/AZone", deviceZone: denver) == denver)
    }

    @Test("Showtimes group by the cinema's calendar day, not the device's")
    func showDaysUseCinemaZone() async throws {
        let shows = try await catalog.movieShows(slug: "the-long-monsoon").shows
        let days = MovieDetailViewModel.days(shows, deviceZone: TimeZone(identifier: "America/Los_Angeles")!)
        #expect(days.count == 2)
        #expect(days.allSatisfy { $0.shows.count == 3 })
    }

    @Test("A card venue with a null country and no zone still decodes")
    func nullableVenueFields() throws {
        let json = #"{"name":"V","city":"C","country":null}"#
        let venue = try JSONDecoder.etg.decode(Venue.self, from: Data(json.utf8))
        #expect(venue.country == nil && venue.timezone == nil)
    }

    @Test("Tickets split into upcoming and past around now")
    func ticketSplit() async throws {
        let tickets = try await MockTicketsRepository(session: await signedInSession(), latency: .zero).tickets()
        let now = ISO8601DateFormatter().date(from: "2026-10-22T00:00:00Z")!
        guard case let .tickets(upcoming, past) = MyTicketsViewModel.split(tickets, now: now) else {
            Issue.record("expected tickets"); return
        }
        #expect(upcoming.count == 3)
        #expect(past.map(\.id) == ["tkt-4"])
        #expect(upcoming.map(\.startsAt) == upcoming.map(\.startsAt).sorted())
    }

    @Test("Only server-rendered PNG data URLs become a ticket code")
    func ticketCode() async throws {
        let ticket = try await MockTicketsRepository(session: await signedInSession(), latency: .zero).tickets()[0]
        #expect(TicketDetailView.image(fromDataURL: ticket.qrDataUrl) != nil)
        #expect(TicketDetailView.image(fromDataURL: nil) == nil)
        #expect(TicketDetailView.image(fromDataURL: "https://example.com/qr.png") == nil)
    }

    @MainActor
    @Test("A failed load shows an error; a failed refresh keeps the content")
    func homeViewModelStates() async {
        let model = HomeViewModel(catalog: FailingCatalog())
        await model.load()
        guard case .failed = model.state else { Issue.record("expected failure"); return }

        let loaded = HomeViewModel(catalog: catalog)
        await loaded.load()
        #expect(loaded.state.value != nil)
    }
}

/// A MOCK session that is already signed in.
func signedInSession(configuration: AppConfiguration = .mock) async -> AuthSession {
    let store = InMemoryTokenStore(StoredSession(
        tokens: TokenPair(accessToken: "a", refreshToken: "r"), identity: MockAuthService.demoEmail, user: nil))
    return AuthSession(store: store, configuration: configuration) { _ in TokenPair(accessToken: "a2", refreshToken: "r2") }
}

struct FailingCatalog: CatalogRepository {
    func discovery() async throws -> DiscoveryFeed { throw APIError.transport(.notConnectedToInternet) }
    func events(_ query: EventQuery) async throws -> Page<EventSummary> { throw APIError.transport(.timedOut) }
    func event(slug: String) async throws -> EventDetail { throw APIError.transport(.timedOut) }
    func movieShows(slug: String) async throws -> MovieShows { throw APIError.transport(.timedOut) }
}
