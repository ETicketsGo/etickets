import Foundation
import Testing
@testable import ETicketsGo

/// Fails the first `failures` booking reads like a dropped connection, then behaves.
private struct FlakyBookingRepository: BookingRepository {
    let base: any BookingRepository
    let counter = FailOnceCounter()
    let failures: Int
    func cities() async throws -> [City] { try await base.cities() }
    func seatMap(sessionId: String, section: String?) async throws -> SeatMap { try await base.seatMap(sessionId: sessionId, section: section) }
    func quote(_ body: QuoteBody) async throws -> Quote { try await base.quote(body) }
    func createBooking(_ body: CreateBookingBody, idempotencyKey: String) async throws -> CreatedBooking { try await base.createBooking(body, idempotencyKey: idempotencyKey) }
    func startPayment(bookingId: String) async throws -> PaymentStart { try await base.startPayment(bookingId: bookingId) }
    func booking(id: String) async throws -> Booking {
        if await counter.next() <= failures { throw APIError.transport(.networkConnectionLost) }
        return try await base.booking(id: id)
    }
    func cancel(bookingId: String) async throws { try await base.cancel(bookingId: bookingId) }
}

actor FailOnceCounter {
    private var n = 0
    func next() -> Int { n += 1; return n }
}

private let buyer = AuthenticatedUser(id: "usr-demo", email: "demo.customer@example.com", fullName: "Demo Customer", roles: ["CUSTOMER"], organizationId: nil)

@MainActor
private func reserved(holdSeconds: TimeInterval = 600) async throws -> (any BookingRepository, MockCommerceServer, CreatedBooking) {
    let server = MockCommerceServer(holdDuration: holdSeconds, confirmationDelay: .milliseconds(20))
    let repo = MockBookingRepository(server: server, session: await signedInSession(), latency: .zero)
    let event = try await MockCatalogRepository(latency: .zero).event(slug: "laugh-riot-standup-vijayawada")
    let session = try #require(event.sessions.first), type = try #require(session.ticketTypes.first)
    let created = try await repo.createBooking(
        CreateBookingBody(eventSessionId: session.id, items: [BookingItem(ticketTypeId: type.id, quantity: 1)],
                          buyerName: buyer.fullName, buyerEmail: buyer.email, paymentMethod: .online, couponCode: nil),
        idempotencyKey: UUID().uuidString)
    return (repo, server, created)
}

@Suite("Checkout handoff hardening", .serialized)
@MainActor
struct CheckoutHandoffTests {
    @Test("Leaving the provider page without paying ends in 'not completed', then paying again works")
    func cancelledProvider() async throws {
        let (repo, server, created) = try await reserved()
        let model = CheckoutViewModel(created: created, repository: repo, environment: .mock)
        await model.pay()
        await model.providerFinished(cancelled: true)
        #expect(model.phase == .paymentNotCompleted)
        await model.pay()
        guard case .awaitingProvider = model.phase else { Issue.record("can't pay again: \(model.phase)"); return }
        await server.providerApproved(bookingId: created.id)
        await model.providerFinished(cancelled: false)
        guard case .confirmed = model.phase else { Issue.record("not confirmed"); return }
    }

    @Test("A duplicate provider callback confirms once and issues tickets once")
    func duplicateCallback() async throws {
        let (repo, server, created) = try await reserved()
        let model = CheckoutViewModel(created: created, repository: repo, environment: .mock)
        await model.pay()
        await server.providerApproved(bookingId: created.id)
        await server.providerApproved(bookingId: created.id)
        await model.providerFinished()
        try await Task.sleep(for: .milliseconds(100))
        #expect(await server.issuedTickets.filter { $0.bookingId == created.id }.count == 1)
    }

    @Test("A dropped connection while polling doesn't lose the confirmation")
    func interruptedPolling() async throws {
        let (base, server, created) = try await reserved()
        let model = CheckoutViewModel(created: created, repository: FlakyBookingRepository(base: base, failures: 3), environment: .mock)
        await model.pay()
        await server.providerApproved(bookingId: created.id)
        await model.providerFinished()
        guard case .confirmed = model.phase else { Issue.record("lost confirmation: \(model.phase)"); return }
    }

    @Test("A payment that lands after the hold expired does not confirm the booking")
    func lateApproval() async throws {
        let (repo, server, created) = try await reserved(holdSeconds: 0.05)
        let model = CheckoutViewModel(created: created, repository: repo, environment: .mock)
        try await Task.sleep(for: .milliseconds(100))
        await server.providerApproved(bookingId: created.id)
        try await Task.sleep(for: .milliseconds(100))
        #expect(try await server.booking(id: created.id).status == "EXPIRED")
        #expect(await server.issuedTickets.filter { $0.bookingId == created.id }.isEmpty)
        await model.holdTimedOut()
        #expect(model.phase == .expired)
    }

    @Test("Abandoned checkout: the hold lapses and the tickets go back on sale")
    func abandoned() async throws {
        let (repo, server, created) = try await reserved(holdSeconds: 0.05)
        try await Task.sleep(for: .milliseconds(100))
        #expect(try await repo.booking(id: created.id).status == "EXPIRED")
        await #expect(throws: (any Error).self) { _ = try await server.startPayment(bookingId: created.id) }
    }

    @Test("QA with native checkout off: a hosted page is not opened")
    func nativeCheckoutFlag() {
        let stripe = PaymentStart(providerRef: "cs", clientActionUrl: "https://checkout.stripe.com/c/pay/cs", status: "REQUIRES_PAYMENT", provider: nil, razorpay: nil)
        guard case .unsupported = PaymentHandoff.from(stripe, bookingId: "b", environment: .qa, nativeCheckout: false) else {
            Issue.record("opened a hosted page with the flag off"); return
        }
        let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api"), allowsMutations: true)
        #expect(!qa.nativeCheckoutPermitted)
        #expect(AppConfiguration.mock.nativeCheckoutPermitted)
    }

    @Test("Return links identify a booking; foreign hosts, plain http and odd ids are ignored")
    func returnLinks() {
        let web = "qa.eticketsgo.com"
        #expect(PaymentReturn.parse(URL(string: "https://qa.eticketsgo.com/checkout/success?session_id=cs_1&booking=bkg_1")!, appScheme: "etgnative-qa", webHost: web)
                == PaymentReturn(bookingId: "bkg_1", kind: .success))
        #expect(PaymentReturn.parse(URL(string: "https://qa.eticketsgo.com/en/checkout/cancel?booking=bkg_1")!, appScheme: nil, webHost: web)
                == PaymentReturn(bookingId: "bkg_1", kind: .cancel))
        #expect(PaymentReturn.parse(URL(string: "etgnative-qa://checkout/return?booking=bkg-2")!, appScheme: "etgnative-qa", webHost: web)
                == PaymentReturn(bookingId: "bkg-2", kind: .success))
        #expect(PaymentReturn.parse(URL(string: "https://evil.example/checkout/success?booking=bkg_1")!, appScheme: nil, webHost: web) == nil)
        #expect(PaymentReturn.parse(URL(string: "http://qa.eticketsgo.com/checkout/success?booking=bkg_1")!, appScheme: nil, webHost: web) == nil)
        #expect(PaymentReturn.parse(URL(string: "etickets://checkout/return?booking=bkg_1")!, appScheme: "etgnative-qa", webHost: web) == nil)
        #expect(PaymentReturn.parse(URL(string: "https://qa.eticketsgo.com/checkout/success?booking=../x")!, appScheme: nil, webHost: web) == nil)
    }

    @Test("Pending checkout record: survives relaunch, belongs to one user, cleared on demand")
    func pendingRecord() throws {
        let defaults = try #require(UserDefaults(suiteName: "etg.tests.pending.\(UUID().uuidString)"))
        let store = PendingCheckoutStore(defaults: defaults)
        store.record(PendingCheckout(bookingId: "b1", userId: "u1", title: "T", holdExpiresAt: .now))
        store.markPaymentStarted(bookingId: "b1")
        let relaunched = PendingCheckoutStore(defaults: defaults)
        #expect(relaunched.pending(for: "u1")?.paymentStartedAt != nil)
        #expect(relaunched.pending(for: "u2") == nil)
        relaunched.clear(bookingId: "other")
        #expect(relaunched.current != nil)
        relaunched.clear()
        #expect(PendingCheckoutStore(defaults: defaults).current == nil)
    }

    @Test("MOCK server state survives a relaunch")
    func mockPersistence() async throws {
        MockCommerceServer.discardSavedState()
        defer { MockCommerceServer.discardSavedState() }
        let first = MockCommerceServer(persists: true)
        let event = try await MockCatalogRepository(latency: .zero).event(slug: "laugh-riot-standup-vijayawada")
        let session = try #require(event.sessions.first)
        let created = try await first.createBooking(
            CreateBookingBody(eventSessionId: session.id, items: [BookingItem(ticketTypeId: try #require(session.ticketTypes.first).id, quantity: 1)],
                              buyerName: "A", buyerEmail: "a@b.co", paymentMethod: .online, couponCode: nil), idempotencyKey: "k")
        let relaunched = MockCommerceServer(persists: true)
        #expect(try await relaunched.booking(id: created.id).status == "PENDING_PAYMENT")
    }
}

@Suite("Shared universal links (#470)")
struct SharedLinkTests {
    private let host = "qa.eticketsgo.com"

    @Test("Event, movie and booking pages map to their screens, with or without a locale")
    func parses() {
        #expect(SharedLink.parse(URL(string: "https://qa.eticketsgo.com/events/riverbend-jazz-night-6a61a6")!, webHost: host)
            == .event(slug: "riverbend-jazz-night-6a61a6"))
        #expect(SharedLink.parse(URL(string: "https://qa.eticketsgo.com/fr-CA/movies/dune-3")!, webHost: host) == .movie(slug: "dune-3"))
        #expect(SharedLink.parse(URL(string: "https://qa.eticketsgo.com/en/booking/cmabc123")!, webHost: host) == .booking(id: "cmabc123"))
    }

    @Test("Other hosts, schemes, paths and odd ids are ignored")
    func ignores() {
        for link in ["https://evil.example/events/x", "http://qa.eticketsgo.com/events/x", "https://qa.eticketsgo.com/checkout/success",
                     "https://qa.eticketsgo.com/events", "https://qa.eticketsgo.com/events/a/b", "https://qa.eticketsgo.com/events/%2e%2e"] {
            #expect(SharedLink.parse(URL(string: link)!, webHost: host) == nil, "\(link)")
        }
        #expect(SharedLink.parse(URL(string: "https://eticketsgo.com/events/x")!, webHost: nil) == nil)
    }

    @Test("The router opens each link on the right tab")
    @MainActor
    func routes() {
        let router = AppRouter(arguments: [])
        router.open(.event(slug: "s"))
        #expect(router.selectedTab == .home && router.paths[.home] == [.event(slug: "s")])
        router.open(.booking(id: "b"))
        #expect(router.selectedTab == .profile && router.paths[.profile] == [.bookings])
        router.open(.movie(slug: "m"))
        #expect(router.selectedTab == .movies)
    }
}
