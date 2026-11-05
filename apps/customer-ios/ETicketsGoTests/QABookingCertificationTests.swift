import Foundation
import Testing
@testable import ETicketsGo

/// Real QA booking certification: sign-in → quote → hold → duplicate protection → Stripe test
/// checkout → webhook-driven confirmation → issued ticket/QR → check-in accepts once, rejects
/// reuse. **Creates real QA records** — so it refuses to run unless every gate is set:
///
/// - `ETG_QA_CERT=1`
/// - `ETG_QA_ALLOW_BOOKING_MUTATIONS=1` — the explicit authorization for QA writes
/// - `ETG_QA_EMAIL` / `ETG_QA_PASSWORD` — an approved, disposable QA customer
/// - `ETG_QA_CERT_EVENT_SLUG` — a disposable QA event priced in USD or CAD (Stripe; INR would
///   route to Razorpay, which has no app checkout yet)
/// - optional `ETG_QA_STAFF_EMAIL` / `ETG_QA_STAFF_PASSWORD` — a QA staff member of that event's
///   organisation, for the check-in steps
/// - optional `ETG_CERT_URL_FILE` - also write the checkout URL to this file
/// - optional `ETG_QA_CERT_WAIT_SECONDS` (default 600) — how long to wait for the operator to
///   complete the Stripe **test** checkout (card 4242 4242 4242 4242) at the printed URL
///
/// See docs/qa-booking-certification.md. Stripe test mode only; never PROD (hard-wired to QA).
private enum Cert {
    static let env = ProcessInfo.processInfo.environment
    static var enabled: Bool {
        env["ETG_QA_CERT"] == "1" && env["ETG_QA_ALLOW_BOOKING_MUTATIONS"] == "1"
            && env["ETG_QA_EMAIL"] != nil && env["ETG_QA_PASSWORD"] != nil && env["ETG_QA_CERT_EVENT_SLUG"] != nil
    }
    static var waitSeconds: Double { Double(env["ETG_QA_CERT_WAIT_SECONDS"] ?? "") ?? 600 }

    static func configuration(account: String) -> AppConfiguration {
        AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true,
                         qaTestAccounts: [account], allowsBookingWrites: true, allowsNativeCheckout: true)
    }
}

/// POST /checkins (apps/api/src/checkins/checkins.controller.ts) — staff only.
private struct CheckInBody: Encodable { let token: String; let expectedSessionId: String? }
private struct CheckInOutcome: Decodable, Sendable { let result: String; let message: String? }

private struct Signed {
    let auth: RemoteAuthService
    let client: APIClient

    init(account: String) {
        let config = Cert.configuration(account: account)
        let publicClient = APIClient(configuration: config)
        let session = AuthSession(store: InMemoryTokenStore(), configuration: config) { try await publicClient.send(AuthAPI.refresh($0)) }
        client = APIClient(configuration: config, tokens: session)
        auth = RemoteAuthService(publicClient: publicClient, client: client, session: session, configuration: config)
    }
}

@Suite("QA booking certification (creates QA records; gated)", .enabled(if: Cert.enabled), .serialized)
struct QABookingCertificationTests {
    @Test("End to end: hold → Stripe test payment → server confirmation → ticket → check-in once")
    func certify() async throws {
        let email = try #require(Cert.env["ETG_QA_EMAIL"]), password = try #require(Cert.env["ETG_QA_PASSWORD"])
        let customer = Signed(account: email)
        let user = try await customer.auth.login(email: email, password: password)                       // 1

        let catalog = RemoteCatalogRepository(client: customer.client)
        let event = try await catalog.event(slug: try #require(Cert.env["ETG_QA_CERT_EVENT_SLUG"]))       // 2
        let session = try #require(EventDetailViewModel.upcomingSessions(event).first, "no upcoming session")
        let type = try #require(session.ticketTypes.first { $0.available > 0 && $0.priceMinor > 0 }, "no paid ticket on sale")
        let items = [BookingItem(ticketTypeId: type.id, quantity: 1)]

        let booking = RemoteBookingRepository(client: customer.client)
        let quote = try await booking.quote(QuoteBody(eventSessionId: session.id, items: items, couponCode: nil))  // 3
        #expect(quote.fees.totalMinor > 0)
        #expect(["USD", "CAD"].contains(quote.fees.currency), "certification needs a Stripe (USD/CAD) event")

        let key = UUID().uuidString
        let body = CreateBookingBody(eventSessionId: session.id, items: items, buyerName: user.fullName, buyerEmail: try #require(user.email),
                                     paymentMethod: .online, couponCode: nil)
        let held = try await booking.createBooking(body, idempotencyKey: key)                             // 4
        #expect(held.status == "PENDING_PAYMENT" && held.holdExpiresAt != nil)
        #expect(held.fees.totalMinor == quote.fees.totalMinor, "hold priced differently from the quote")
        let replay = try await booking.createBooking(body, idempotencyKey: key)                           // 5
        #expect(replay.id == held.id, "a resent request created a second booking")

        let start = try await booking.startPayment(bookingId: held.id)                                    // 6
        guard case let .hostedPage(url) = PaymentHandoff.from(start, bookingId: held.id, environment: .qa) else {
            Issue.record("no hosted checkout page: \(start)"); return
        }
        #expect(url.host()?.hasSuffix("stripe.com") == true)
        #expect(try await booking.booking(id: held.id).status == "PENDING_PAYMENT", "confirmed before anyone paid") // 8
        print("ETG-CERT: complete the Stripe TEST checkout (4242 4242 4242 4242) within \(Int(Cert.waitSeconds))s:\n\(url)")
        // For an automated test-mode run: the operator's script reads the URL from this file.
        if let path = Cert.env["ETG_CERT_URL_FILE"] { try? url.absoluteString.write(toFile: path, atomically: true, encoding: .utf8) }

        let deadline = Date().addingTimeInterval(Cert.waitSeconds)                                        // 7–8
        var status = "PENDING_PAYMENT"
        while Date() < deadline, status == "PENDING_PAYMENT" {
            try await Task.sleep(for: .seconds(5))
            status = try await booking.booking(id: held.id).status
        }
        #expect(status == "CONFIRMED", "not confirmed by the server (status \(status))")
        guard status == "CONFIRMED" else { return }

        let tickets = try await RemoteTicketsRepository(client: customer.client).tickets().filter { $0.bookingId == held.id } // 9–10
        #expect(tickets.count == 1)
        let ticket = try #require(tickets.first)
        #expect(TicketCodeView.presentation(for: ticket) == .code)
        let token = try #require(ticket.qrToken)

        // 11: check-in, when a staff account is supplied.
        guard let staffEmail = Cert.env["ETG_QA_STAFF_EMAIL"], let staffPassword = Cert.env["ETG_QA_STAFF_PASSWORD"] else { return }
        let staff = Signed(account: staffEmail)
        _ = try await staff.auth.login(email: staffEmail, password: staffPassword)
        func scan(_ token: String) async throws -> String {
            try await staff.client.send(Endpoint<CheckInOutcome>(
                method: .post, path: "/checkins", body: try JSONEncoder.etg.encode(CheckInBody(token: token, expectedSessionId: session.id)),
                requiresAuth: true)).result
        }
        #expect(try await scan(token) == "SUCCESS")
        #expect(try await scan(token) == "DUPLICATE", "the same ticket was admitted twice")
        #expect(try await scan(String(token.dropLast(3)) + "AAA") == "INVALID", "a tampered code was accepted")
    }

    @Test("An abandoned hold can be released and never confirms")
    func releaseAbandonedHold() async throws {
        let email = try #require(Cert.env["ETG_QA_EMAIL"]), password = try #require(Cert.env["ETG_QA_PASSWORD"])
        let customer = Signed(account: email)
        let user = try await customer.auth.login(email: email, password: password)
        let event = try await RemoteCatalogRepository(client: customer.client).event(slug: try #require(Cert.env["ETG_QA_CERT_EVENT_SLUG"]))
        let session = try #require(EventDetailViewModel.upcomingSessions(event).first)
        let type = try #require(session.ticketTypes.first { $0.available > 0 && $0.priceMinor > 0 })
        let booking = RemoteBookingRepository(client: customer.client)
        let held = try await booking.createBooking(
            CreateBookingBody(eventSessionId: session.id, items: [BookingItem(ticketTypeId: type.id, quantity: 1)],
                              buyerName: user.fullName, buyerEmail: try #require(user.email), paymentMethod: .online, couponCode: nil),
            idempotencyKey: UUID().uuidString)
        try await booking.cancel(bookingId: held.id)
        #expect(try await booking.booking(id: held.id).status == "CANCELLED")
        await #expect(throws: (any Error).self) { _ = try await booking.startPayment(bookingId: held.id) }
    }
}
