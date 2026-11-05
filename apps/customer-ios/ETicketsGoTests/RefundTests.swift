import Foundation
import Testing
@testable import ETicketsGo

/// A fixture booking with the given status, start and refund terms, edited in its wire form so
/// every other field stays exactly as the API sends it.
private func booking(status: String = "CONFIRMED", startsIn hours: Double, enabled: Bool?, cutoff: Int?) throws -> Booking {
    let url = try #require(Bundle.main.url(forResource: "bookings", withExtension: "json"))
    let all = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
    var dict = try #require(all.first)
    dict["status"] = status
    var event = dict["event"] as? [String: Any] ?? [:]
    event["refundsEnabled"] = enabled ?? NSNull()
    event["refundCutoffHours"] = cutoff ?? NSNull()
    dict["event"] = event
    var session = dict["eventSession"] as? [String: Any] ?? [:]
    session["startsAt"] = ISO8601DateFormatter().string(from: Date.now.addingTimeInterval(hours * 3600))
    dict["eventSession"] = session
    return try JSONDecoder.etg.decode(Booking.self, from: JSONSerialization.data(withJSONObject: dict))
}

@Suite("Refund requests")
struct RefundTests {
    @Test("POST /refunds sends {bookingId, reason}; GET /refunds/booking/:id lists them")
    func contract() async throws {
        let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true)
        let client = APIClient(configuration: qa, transport: StubTransport(), tokens: ApprovedWriter())
        let post = try await client.makeRequest(CustomerAPI.requestRefund(bookingId: "bkg-1", reason: "Cannot attend"))
        #expect(post.httpMethod == "POST" && post.url?.path() == "/api/refunds")
        let body = try #require(post.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: String])
        #expect(body == ["bookingId": "bkg-1", "reason": "Cannot attend"])
        let get = try await client.makeRequest(CustomerAPI.refunds(bookingId: "bkg-1"))
        #expect(get.httpMethod == "GET" && get.url?.path() == "/api/refunds/booking/bkg-1")
        let decoded = try JSONDecoder.etg.decode([Refund].self, from: Data(#"[{"id":"r1","status":"REQUESTED","amountMinor":5000,"currency":"USD","reason":"x","createdAt":"2026-11-05T10:00:00.000Z"}]"#.utf8))
        #expect(decoded.first?.isOpen == true && decoded.first?.amountMinor == 5000)
    }

    @Test("The window follows the event's own terms, as on Android")
    func window() throws {
        #expect(RefundWindow.of(try booking(startsIn: 72, enabled: true, cutoff: 48)).isOpen)
        guard case .closed = RefundWindow.of(try booking(startsIn: 24, enabled: true, cutoff: 48)) else { Issue.record("expected closed"); return }
        #expect(RefundWindow.of(try booking(startsIn: 72, enabled: false, cutoff: 48)) == .notOffered)
        #expect(RefundWindow.of(try booking(startsIn: 72, enabled: nil, cutoff: nil)) == .notOffered)
        #expect(RefundWindow.of(try booking(status: "PENDING_PAYMENT", startsIn: 72, enabled: true, cutoff: 0)) == .notApplicable)
        #expect(RefundWindow.of(try booking(status: "PARTIALLY_REFUNDED", startsIn: 72, enabled: true, cutoff: 0)).isOpen)
    }

    @Test("Statuses read as words; open ones block another request")
    func statuses() {
        func refund(_ s: String) -> Refund { Refund(id: "r", status: s, amountMinor: nil, currency: nil, reason: nil, createdAt: .now) }
        #expect(refund("REQUESTED").statusLabel == "Requested, waiting for the organizer")
        #expect(refund("COMPLETED").statusLabel == "Refunded" && !refund("COMPLETED").isOpen)
        #expect(refund("PROCESSING").isOpen && refund("APPROVED").isOpen && !refund("REJECTED").isOpen)
    }

    @Test("Reasons are 3 to 500 characters once trimmed")
    func reasonRule() {
        #expect(validRefundReason("  ok  ") == nil)
        #expect(validRefundReason(" Can't attend ") == "Can't attend")
        #expect(validRefundReason(String(repeating: "x", count: 501)) == nil)
    }

    @Test("One request: the view model refuses a second while one is open, and shows the server's refusal")
    @MainActor
    func noDuplicates() async throws {
        let repo = OneBookingRepository(booking: try booking(startsIn: 96, enabled: true, cutoff: 48))
        let model = BookingDetailViewModel(booking: repo.booking, repository: repo)
        await model.load()
        #expect(model.canRequestRefund)
        #expect(await model.requestRefund(reason: "ab") == false)   // too short: nothing sent
        #expect(await model.requestRefund(reason: "Cannot attend"))
        #expect(model.refunds.value?.count == 1 && model.refunds.value?.first?.status == "REQUESTED")
        #expect(!model.canRequestRefund)
        // A second device asking anyway gets the server's refusal, shown as-is.
        #expect(await model.requestRefund(reason: "Asking again") == false)
        #expect(model.refundError == "No refundable tickets in this booking.")
        #expect(model.refunds.value?.count == 1)
    }
}

extension RefundWindow {
    var isOpen: Bool { if case .open = self { true } else { false } }
}

/// One booking and the MOCK refund store: deterministic, whatever today's date is.
private struct OneBookingRepository: TicketsRepository {
    let booking: Booking
    let store = MockRefundStore()
    func tickets() async throws -> [Ticket] { [] }
    func ticket(id: String) async throws -> Ticket { throw APIError.invalidResponse }
    func bookings() async throws -> [Booking] { [booking] }
    func booking(id: String) async throws -> Booking { booking }
    func refunds(bookingId: String) async throws -> [Refund] { await store.refunds(for: bookingId) }
    func requestRefund(bookingId: String, reason: String) async throws { try await store.request(bookingId: bookingId, reason: reason) }
}

/// A signed-in, approved QA test session, so the write is built rather than refused locally.
private struct ApprovedWriter: AccessTokenProviding {
    func accessToken() async -> String? { "test-token" }
    func refreshAfterUnauthorized(rejected: String) async -> Bool { false }
    func mayWriteInQA() async -> Bool { true }
}
