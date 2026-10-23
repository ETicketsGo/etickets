import Foundation
import Testing
@testable import ETicketsGo

/// Live tests against the QA API. Skipped unless explicitly enabled, so a normal test run never
/// touches the network. Run them with `docs/qa-integration-tests.md`.
///
/// - `ETG_QA_LIVE=1`: public, read-only discovery checks.
/// - `ETG_QA_EMAIL` + `ETG_QA_PASSWORD`: an **approved QA test account**. Enables the signed-in
///   checks (sign-in, booking history, tickets, refresh, logout). Credentials come only from the
///   environment of the test run; nothing is stored or committed.
///
/// Writes are limited to the session itself (login, refresh, logout) and only for the account
/// supplied, which is also the only identity on the run's allowlist. PROD is never used.
private enum QAEnv {
    static let env = ProcessInfo.processInfo.environment
    static let live = env["ETG_QA_LIVE"] == "1"
    static let email = env["ETG_QA_EMAIL"].flatMap { $0.isEmpty ? nil : $0 }
    static let password = env["ETG_QA_PASSWORD"].flatMap { $0.isEmpty ? nil : $0 }
    static var signedIn: Bool { email != nil && password != nil }

    static var configuration: AppConfiguration {
        AppConfiguration(
            environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!,
            allowsMutations: true, qaTestAccounts: email.map { [$0] } ?? [])
    }
}

/// The same wiring as `AppContainer.make` for QA, with an in-memory token store.
private struct QAStack {
    let session: AuthSession
    let auth: RemoteAuthService
    let client: APIClient
    let store = InMemoryTokenStore()

    init() {
        let config = QAEnv.configuration
        let publicClient = APIClient(configuration: config)
        let store = self.store
        session = AuthSession(store: store, configuration: config) { refreshToken in
            try await publicClient.send(AuthAPI.refresh(refreshToken))
        }
        client = APIClient(configuration: config, tokens: session)
        auth = RemoteAuthService(publicClient: publicClient, client: client, session: session, configuration: config)
    }
}

@Suite("QA live: public discovery (read-only)", .enabled(if: QAEnv.live), .serialized)
struct QALiveDiscoveryTests {
    let catalog = RemoteCatalogRepository(client: APIClient(configuration: QAEnv.configuration))

    @Test("Discovery, an event's detail and a movie's shows decode from the live API")
    func discoveryChain() async throws {
        let feed = try await catalog.discovery()
        let event = try #require(feed.trendingEvents.first ?? feed.thisWeekend.first, "QA has no events")
        let detail = try await catalog.event(slug: event.slug)
        #expect(detail.id == event.id)
        #expect(detail.timeZone != nil)
        if let movie = feed.nowShowing.first {
            let shows = try await catalog.movieShows(slug: movie.slug)
            #expect(shows.movie.slug == movie.slug)
            #expect(shows.shows.allSatisfy { $0.timeZone != nil })
        }
    }

    @Test("Explore search and paging decode from the live API")
    func explore() async throws {
        let page = try await catalog.events(EventQuery(page: 1, pageSize: 5))
        #expect(page.meta.pageSize == 5)
        #expect(page.data.count <= 5)
    }

    @Test("A write without an approved session is refused locally, before anything is sent")
    func writesStayBlocked() async {
        let client = APIClient(configuration: QAEnv.configuration)
        await #expect(throws: APIError.mutationBlocked(.qa)) {
            _ = try await client.send(Endpoint<IgnoredResponse>(method: .post, path: "/bookings/quote"))
        }
    }
}

@Suite("QA live: signed-in (approved test account)", .enabled(if: QAEnv.signedIn), .serialized)
struct QALiveSignedInTests {
    @Test("Sign in, read booking history and tickets, show only server-issued codes, refresh, log out")
    func journey() async throws {
        let stack = QAStack()
        let email = try #require(QAEnv.email), password = try #require(QAEnv.password)

        let user = try await stack.auth.login(email: email, password: password)
        #expect(user.email.lowercased() == email.lowercased())

        let tickets = RemoteTicketsRepository(client: stack.client)
        let bookings = try await tickets.bookings()
        let wallet = try await tickets.tickets()
        for ticket in wallet {
            // Server-issued only: a presentable ticket either carries a decodable image or is a
            // vendor code; a withheld one never renders a code.
            switch TicketCodeView.presentation(for: ticket) {
            case .code: #expect(TicketDetailView.image(fromDataURL: ticket.qrDataUrl) != nil)
            case .transferred: #expect(!ticket.isPresentable)
            case .vendorCode, .unavailable, .void, .checkedIn, .ended: break
            }
        }
        if let first = wallet.first {
            #expect(try await tickets.ticket(id: first.id).id == first.id)
        }
        if let booking = bookings.first {
            #expect(try await tickets.booking(id: booking.id).id == booking.id)
        }

        // Offline copy: no token is saved, presentability is.
        let offline = InMemoryOfflineTicketStore()
        try offline.save(wallet, userId: user.id, now: .now)
        let saved = offline.load(userId: user.id, now: .now)?.tickets ?? []
        #expect(saved.allSatisfy { $0.qrToken == nil })

        // Refresh rotates the pair.
        let before = try #require(await stack.session.current?.tokens)
        #expect(await stack.session.refreshAfterUnauthorized(rejected: before.accessToken))
        let after = try #require(await stack.session.current?.tokens)
        #expect(after.refreshToken != before.refreshToken)

        // Logout revokes: the server then rejects the revoked refresh token.
        await stack.auth.logout()
        #expect(await stack.session.current == nil)
        let publicClient = APIClient(configuration: QAEnv.configuration)
        await #expect(throws: (any Error).self) { _ = try await publicClient.send(AuthAPI.refresh(after.refreshToken)) }
    }

    @Test("A wrong password gets the server's message and leaves no session")
    func wrongPassword() async throws {
        let stack = QAStack()
        let email = try #require(QAEnv.email)
        do {
            _ = try await stack.auth.login(email: email, password: "definitely-not-the-password")
            Issue.record("login unexpectedly succeeded")
        } catch let APIError.server(status, code, _, _) {
            #expect(status == 401 && code == "INVALID_CREDENTIALS")
        }
        #expect(await stack.session.current == nil)
    }
}
