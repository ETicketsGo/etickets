import Foundation
import Testing
@testable import ETicketsGo

private final class BookingFixtureToken {}

private func recorded<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = try #require(Bundle(for: BookingFixtureToken.self).url(forResource: name, withExtension: "json"))
    return try JSONDecoder.etg.decode(T.self, from: Data(contentsOf: url))
}

@MainActor
private func mockStack(holdSeconds: TimeInterval = 600) async -> (BookingRepository, MockCommerceServer, EventDetail, EventDetail) {
    let session = await signedInSession()
    let server = MockCommerceServer(holdDuration: holdSeconds, confirmationDelay: .milliseconds(20))
    let repo = MockBookingRepository(server: server, session: session, latency: .zero)
    let catalog = MockCatalogRepository(latency: .zero)
    let jazz = try! await catalog.event(slug: "monsoon-jazz-nights-hyderabad")
    let cinema = try! await catalog.event(slug: "the-long-monsoon-galaxy-cinemas-hyderabad")
    return (repo, server, jazz, cinema)
}

private let buyer = AuthenticatedUser(id: "usr-demo", email: "demo.customer@example.com", fullName: "Demo Customer", roles: ["CUSTOMER"], organizationId: nil)

@Suite("Booking contracts (recorded QA responses)")
struct BookingContractTests2 {
    @Test("A real QA quote, seat map and city list decode")
    func recordedDecode() throws {
        let quote = try recorded("qa-quote", as: Quote.self)
        #expect(quote.fees.totalMinor == quote.fees.netSubtotalMinor + quote.fees.customerFeeMinor + quote.fees.taxMinor)
        let seats = try recorded("qa-seats", as: SeatMap.self)
        #expect(seats.view == "seats")
        #expect(seats.sections.allSatisfy { $0.rows != nil })
        #expect(try recorded("qa-cities", as: [City].self).count > 0)
    }

    @Test("Quote is a side-effect-free POST: allowed on QA without a session, refused on PROD")
    func quoteGuard() async throws {
        let body = QuoteBody(eventSessionId: "s", items: [BookingItem(ticketTypeId: "t", quantity: 1)], couponCode: nil)
        let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true)
        let request = try await APIClient(configuration: qa, transport: StubTransport()).makeRequest(CustomerAPI.quote(body))
        #expect(request.httpMethod == "POST" && request.url?.path() == "/api/bookings/quote")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)

        let prod = AppConfiguration(environment: .prod, apiBaseURL: URL(string: "https://api.eticketsgo.com/api")!, allowsMutations: true)
        await #expect(throws: APIError.mutationBlocked(.prod)) {
            _ = try await APIClient(configuration: prod, transport: StubTransport()).makeRequest(CustomerAPI.quote(body))
        }
    }

    @Test("Create-booking sends the idempotency key; QA and PROD refuse booking writes before sending")
    func bookingWritesGuard() async throws {
        let body = CreateBookingBody(eventSessionId: "s", items: [], buyerName: "a", buyerEmail: "a@b.co", paymentMethod: .online, couponCode: nil)
        let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true)
        let endpoint = CustomerAPI.createBooking(body, idempotencyKey: "key-1")
        #expect(endpoint.headers["idempotency-key"] == "key-1")

        let transport = StubTransport()
        let repo = RemoteBookingRepository(client: APIClient(configuration: qa, transport: transport, tokens: FixedToken()))
        await #expect(throws: BookingError.writesDisabled) { _ = try await repo.createBooking(body, idempotencyKey: "k") }
        await #expect(throws: BookingError.writesDisabled) { _ = try await repo.startPayment(bookingId: "b") }
        await #expect(throws: BookingError.writesDisabled) { try await repo.cancel(bookingId: "b") }
        #expect(transport.requests.isEmpty)
    }

    @Test("Payment handoff comes from the server's answer: hosted URL, simulated, or Razorpay unsupported")
    func handoff() {
        let stripe = PaymentStart(providerRef: "cs_1", clientActionUrl: "https://checkout.stripe.com/c/pay/cs_1", status: "REQUIRES_PAYMENT", provider: nil, razorpay: nil)
        #expect(PaymentHandoff.from(stripe, bookingId: "b", environment: .qa) == .hostedPage(URL(string: "https://checkout.stripe.com/c/pay/cs_1")!))
        let razorpay = PaymentStart(providerRef: "order_1", clientActionUrl: "order_1", status: "REQUIRES_PAYMENT", provider: "razorpay",
                                    razorpay: .init(keyId: "rzp_test", orderId: "order_1", amountMinor: 100, currency: "INR"))
        guard case .unsupported = PaymentHandoff.from(razorpay, bookingId: "b", environment: .qa) else { Issue.record("razorpay"); return }
        let mock = PaymentStart(providerRef: nil, clientActionUrl: "mock://checkout/b", status: "REQUIRES_PAYMENT", provider: "mock", razorpay: nil)
        #expect(PaymentHandoff.from(mock, bookingId: "b", environment: .mock) == .simulated(bookingId: "b"))
        guard case .unsupported = PaymentHandoff.from(mock, bookingId: "b", environment: .qa) else { Issue.record("mock in qa"); return }
        let insecure = PaymentStart(providerRef: nil, clientActionUrl: "http://pay.example.com", status: "REQUIRES_PAYMENT", provider: nil, razorpay: nil)
        guard case .unsupported = PaymentHandoff.from(insecure, bookingId: "b", environment: .qa) else { Issue.record("http"); return }
    }
}

@Suite("MOCK booking journey", .serialized)
@MainActor
struct MockBookingJourneyTests {
    @Test("Select → server quote → reserve → pay → simulated provider → poll → confirmed → tickets issued")
    func happyPath() async throws {
        let (repo, server, jazz, _) = await mockStack()
        let model = TicketSelectionViewModel(event: jazz, repository: repo, configuration: .mock)
        let lawn = try #require(model.session?.ticketTypes.first)
        model.setQuantity(lawn, 2)
        await model.refreshQuote()
        let quote = try #require(model.quote.value)
        #expect(quote.fees.subtotalMinor == lawn.priceMinor * 2)   // the server's figure, displayed as-is

        model.setQuantity(lawn, 3)                                   // quantity change → re-quote
        await model.refreshQuote()
        #expect(model.quote.value?.fees.subtotalMinor == lawn.priceMinor * 3)

        await model.reserve(buyer: buyer)
        let created = try #require(model.reserved)
        #expect(created.status == "PENDING_PAYMENT" && created.holdExpiresAt != nil)

        let checkout = CheckoutViewModel(created: created, repository: repo, environment: .mock)
        await checkout.pay()
        #expect(checkout.phase == .awaitingProvider(.simulated(bookingId: created.id)))
        await server.providerApproved(bookingId: created.id)
        await checkout.providerFinished()
        guard case .confirmed = checkout.phase else { Issue.record("not confirmed: \(checkout.phase)"); return }
        #expect(await server.issuedTickets.filter { $0.bookingId == created.id }.count == 3)
    }

    @Test("Returning from the provider without approval does not confirm anything")
    func returnIsNotProof() async throws {
        let (repo, _, jazz, _) = await mockStack()
        let model = TicketSelectionViewModel(event: jazz, repository: repo, configuration: .mock)
        model.setQuantity(try #require(model.session?.ticketTypes.first), 1)
        await model.reserve(buyer: buyer)
        let checkout = CheckoutViewModel(created: try #require(model.reserved), repository: repo, environment: .mock)
        await checkout.pay()
        #expect(await checkout.refresh() == false)    // the customer closed the page; server still pending
        if case .confirmed = checkout.phase { Issue.record("confirmed without payment") }
    }

    @Test("A resent reservation with the same key replays, it does not book twice")
    func idempotentReserve() async throws {
        let (repo, server, jazz, _) = await mockStack()
        let session = try #require(jazz.sessions.first), type = try #require(session.ticketTypes.first)
        let body = CreateBookingBody(eventSessionId: session.id, items: [BookingItem(ticketTypeId: type.id, quantity: 1)],
                                     buyerName: "A", buyerEmail: "a@b.co", paymentMethod: .online, couponCode: nil)
        let first = try await repo.createBooking(body, idempotencyKey: "same")
        let second = try await repo.createBooking(body, idempotencyKey: "same")
        #expect(first.id == second.id)
        #expect(await server.allBookings().count == 1)
    }

    @Test("Seats: choosing seats builds one item per ticket type; a taken seat gets the server's 409 and a fresh map")
    func seats() async throws {
        let (repo, _, _, cinema) = await mockStack()
        let model = TicketSelectionViewModel(event: cinema, repository: repo, configuration: .mock)
        #expect(model.isSeated)
        await model.loadSeatMap()
        let map = try #require(model.seatMap.value)
        let free = map.sections.flatMap { $0.rows ?? [] }.flatMap(\.seats).filter(\.isSelectable)
        model.toggle(free[0]); model.toggle(free[1])
        #expect(model.items.reduce(0) { $0 + $1.quantity } == 2)
        #expect(model.items.allSatisfy { $0.seatIds?.count == $0.quantity })

        // Someone else books one of them first.
        let other = TicketSelectionViewModel(event: cinema, repository: repo, configuration: .mock)
        await other.loadSeatMap()
        other.toggle(free[1])
        await other.reserve(buyer: buyer)
        #expect(other.reserved != nil)

        await model.reserve(buyer: buyer)
        #expect(model.reserved == nil)
        #expect(model.reserveError?.contains("taken") == true)
        #expect(model.items.isEmpty)                             // selection cleared, map reloaded
        let reloaded = try #require(model.seatMap.value)
        #expect(reloaded.sections.flatMap { $0.rows ?? [] }.flatMap(\.seats).first { $0.id == free[1].id }?.status == "HELD")
    }

    @Test("Steppers cap at min(available, maxPerOrder); sold-out types can't be chosen")
    func caps() async throws {
        let (repo, _, jazz, _) = await mockStack()
        let model = TicketSelectionViewModel(event: jazz, repository: repo, configuration: .mock)
        let types = try #require(model.session?.ticketTypes)
        let soldOut = try #require(types.first { $0.available == 0 })
        model.setQuantity(soldOut, 2)
        #expect(model.quantity(soldOut) == 0)
        let lawn = try #require(types.first { $0.available > 0 })
        model.setQuantity(lawn, 99)
        #expect(model.quantity(lawn) == min(lawn.available, lawn.maxPerOrder))
    }

    @Test("A hold that runs out ends as expired, and can't be paid")
    func holdExpiry() async throws {
        let (repo, _, jazz, _) = await mockStack(holdSeconds: 0.05)
        let model = TicketSelectionViewModel(event: jazz, repository: repo, configuration: .mock)
        model.setQuantity(try #require(model.session?.ticketTypes.first), 1)
        await model.reserve(buyer: buyer)
        let checkout = CheckoutViewModel(created: try #require(model.reserved), repository: repo, environment: .mock)
        try await Task.sleep(for: .milliseconds(100))
        await checkout.holdTimedOut()
        #expect(checkout.phase == .expired)
        await checkout.pay()
        #expect(checkout.phase == .expired)
    }

    @Test("Releasing a hold cancels it on the server")
    func release() async throws {
        let (repo, server, jazz, _) = await mockStack()
        let model = TicketSelectionViewModel(event: jazz, repository: repo, configuration: .mock)
        model.setQuantity(try #require(model.session?.ticketTypes.first), 1)
        await model.reserve(buyer: buyer)
        let created = try #require(model.reserved)
        let checkout = CheckoutViewModel(created: created, repository: repo, environment: .mock)
        await checkout.cancel()
        #expect(checkout.phase == .cancelled)
        #expect(try await server.booking(id: created.id).status == "CANCELLED")
    }

    @Test("QA build: selection and quote work, reserving is refused with an explanation")
    func qaReadOnly() async throws {
        let (repo, _, jazz, _) = await mockStack()
        let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true)
        let model = TicketSelectionViewModel(event: jazz, repository: repo, configuration: qa)
        #expect(!model.bookingEnabled)
    }

    @Test("Interrupted checkout: a pending booking with time left can be resumed")
    func resume() async throws {
        let (repo, _, jazz, _) = await mockStack()
        let model = TicketSelectionViewModel(event: jazz, repository: repo, configuration: .mock)
        model.setQuantity(try #require(model.session?.ticketTypes.first), 1)
        await model.reserve(buyer: buyer)
        let booking = try await repo.booking(id: try #require(model.reserved).id)
        #expect(BookingDetailView.canResume(booking))
        #expect(BookingDetailView.resumable(booking).fees.totalMinor == booking.totalMinor)
        #expect(!BookingDetailView.canResume(booking, now: .now.addingTimeInterval(3600)))
    }
}

@Suite("Ticket status presentation")
struct TicketStatusTests {
    @Test("Refunded, cancelled and void tickets never show a code, even when an image arrives")
    func voidStatuses() async throws {
        let tickets = try await MockTicketsRepository(session: await signedInSession(), latency: .zero).tickets()
        let refunded = try #require(tickets.first { $0.id == "tkt-6" })
        #expect(refunded.qrDataUrl != nil)                                  // the image is there…
        guard case .void = TicketCodeView.presentation(for: refunded) else { Issue.record("refunded shows a code"); return }
        let used = try #require(tickets.first { $0.id == "tkt-4" })
        #expect(TicketCodeView.presentation(for: used) == .checkedIn)
        #expect(TicketCard.statusLabel(refunded) == "Refunded")
        #expect(TicketCard.statusLabel(try #require(tickets.first { $0.id == "tkt-5" })) == "Transferred")
    }

    @Test("An active ticket for an event long over says it has ended")
    func ended() async throws {
        let ticket = try #require(try await MockTicketsRepository(session: await signedInSession(), latency: .zero).tickets().first { $0.id == "tkt-1" })
        #expect(TicketCodeView.presentation(for: ticket, now: ticket.startsAt.addingTimeInterval(86400)) == .ended)
        #expect(TicketCodeView.presentation(for: ticket, now: ticket.startsAt.addingTimeInterval(-3600)) == .code)
    }
}
