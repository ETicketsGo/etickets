import Foundation
import Testing
@testable import ETicketsGo

private func mockTickets() async throws -> [Ticket] {
    try await MockTicketsRepository(session: await signedInSession(), latency: .zero).tickets()
}

private let now = ISO8601DateFormatter().date(from: "2026-10-22T00:00:00Z")!

/// A repository whose every call fails like an unreachable server.
private struct OfflineRepository: TicketsRepository {
    var error: APIError = .transport(.notConnectedToInternet)
    func tickets() async throws -> [Ticket] { throw error }
    func ticket(id: String) async throws -> Ticket { throw error }
    func bookings() async throws -> [Booking] { throw error }
    func booking(id: String) async throws -> Booking { throw error }
}

@Suite("Bookings and ticket endpoints")
struct BookingContractTests {
    @Test("Booking history, booking and ticket endpoints are bearer GETs under /api")
    func endpoints() async throws {
        let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true)
        let client = APIClient(configuration: qa, transport: StubTransport(), tokens: FixedToken())
        let list = try await client.makeRequest(CustomerAPI.bookings())
        #expect(list.httpMethod == "GET" && list.url?.path() == "/api/bookings")
        #expect(list.url?.query?.contains("pageSize=50") == true)
        #expect(list.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
        #expect(try await client.makeRequest(CustomerAPI.booking(id: "bkg-1")).url?.path() == "/api/bookings/bkg-1")
        #expect(try await client.makeRequest(CustomerAPI.ticket(id: "tkt 1")).url?.path() == "/api/tickets/tkt%201")
    }

    @Test("Bookings decode, including `_count`, and link to their tickets")
    func bookingsDecode() async throws {
        let repo = MockTicketsRepository(session: await signedInSession(), latency: .zero)
        let bookings = try await repo.bookings()
        #expect(bookings.count == 4)
        let jazz = try #require(bookings.first { $0.id == "bkg-1" })
        #expect(jazz.ticketCount == 2)
        #expect(jazz.totalMinor == jazz.subtotalMinor + jazz.customerFeeMinor - jazz.discountMinor)
        #expect(try await repo.tickets().filter { $0.bookingId == "bkg-1" }.count == 2)
    }

    @Test("Booking statuses read as words; an unknown status is shown, not hidden")
    func statuses() {
        #expect(BookingStatusPill.describe("CONFIRMED").0 == "Confirmed")
        #expect(BookingStatusPill.describe("cancelled").0 == "Cancelled")
        #expect(BookingStatusPill.describe("PARTIALLY_REFUNDED").0 == "Refunded")
        #expect(BookingStatusPill.describe("ON_HOLD_REVIEW").0 == "On Hold Review")
    }
}

@Suite("Authorized server-issued code")
struct TicketCodeTests {
    @Test("A ticket shows its server-rendered code only when the server lets this viewer present it")
    func presentation() async throws {
        let tickets = try await mockTickets()
        let valid = try #require(tickets.first { $0.id == "tkt-1" })
        let transferred = try #require(tickets.first { $0.id == "tkt-5" })

        #expect(valid.isPresentable)
        #expect(TicketCodeView.presentation(for: valid) == .code)
        #expect(!transferred.isPresentable)
        #expect(TicketCodeView.presentation(for: transferred) == .transferred)
    }

    @Test("An empty token is withheld; a vendor barcode that isn't QR is explained, not drawn")
    func edgeCases() async throws {
        var ticket = try #require(try await mockTickets().first)
        ticket.qrToken = ""
        #expect(TicketCodeView.presentation(for: ticket) == .transferred)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601  // the wire format
        let json = try encoder.encode(try #require(try await mockTickets().first))
        var dict = try #require(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        dict["qrDataUrl"] = NSNull()
        dict["vendorBarcode"] = "VENDOR-CODE-128"
        dict["vendorBarcodeFormat"] = "CODE128"
        let vendor = try JSONDecoder.etg.decode(Ticket.self, from: JSONSerialization.data(withJSONObject: dict))
        #expect(TicketCodeView.presentation(for: vendor) == .vendorCode)
    }

    @Test("The offline copy drops the token but remembers whether it could be presented")
    func offlineCopy() async throws {
        let tickets = try await mockTickets()
        let valid = try #require(tickets.first { $0.id == "tkt-1" }).offlineCopy()
        #expect(valid.qrToken == nil && valid.isPresentable && valid.qrDataUrl != nil)
        #expect(TicketCodeView.presentation(for: valid) == .code)
        let transferred = try #require(tickets.first { $0.id == "tkt-5" }).offlineCopy()
        #expect(!transferred.isPresentable)
    }

    @MainActor
    @Test("Opening a ticket asks the server again; if that fails, the saved copy is shown and flagged")
    func detailRefresh() async throws {
        let ticket = try #require(try await mockTickets().first)
        let fresh = TicketDetailViewModel(ticket: ticket.offlineCopy(), repository: MockTicketsRepository(session: await signedInSession(), latency: .zero))
        await fresh.refresh()
        #expect(!fresh.isSavedCopy && fresh.ticket.qrToken != nil)

        let offline = TicketDetailViewModel(ticket: ticket.offlineCopy(), repository: OfflineRepository())
        await offline.refresh()
        #expect(offline.isSavedCopy && offline.ticket.qrToken == nil)
    }
}

@Suite("Offline read-only tickets", .serialized)
struct OfflineTicketTests {
    private func fileStore() -> FileOfflineTicketStore {
        FileOfflineTicketStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("etg-offline-\(UUID().uuidString)"))
    }

    @Test("The saved file holds upcoming tickets only, no signed token, protected and excluded from backup")
    func savedFile() async throws {
        let store = fileStore()
        defer { store.clear() }
        let tickets = try await mockTickets()
        try store.save(tickets, userId: "usr-demo", now: now)

        let url = store.file(for: "usr-demo")
        let bytes = try String(contentsOf: url, encoding: .utf8)
        #expect(!bytes.contains("MOCK.ETG"))  // the signed tokens are MOCK.<serial>
        #expect(!url.lastPathComponent.contains("usr-demo"))

        let wallet = try #require(store.load(userId: "usr-demo", now: now))
        #expect(wallet.tickets.count == 5)  // the September ticket is past
        #expect(wallet.tickets.allSatisfy { $0.qrToken == nil })

        let protection = try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey] as? FileProtectionType
        #expect(protection == nil || protection == .complete)  // the simulator may not report it
        #expect(try store.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test("Another user, a copy older than 7 days, or a cleared store gives nothing")
    func expiryAndIsolation() async throws {
        let store = fileStore()
        try store.save(try await mockTickets(), userId: "usr-demo", now: now)
        #expect(store.load(userId: "usr-other", now: now) == nil)
        #expect(store.load(userId: "usr-demo", now: now.addingTimeInterval(6 * 24 * 3600)) != nil)
        #expect(store.load(userId: "usr-demo", now: now.addingTimeInterval(8 * 24 * 3600)) == nil)
        #expect(!FileManager.default.fileExists(atPath: store.file(for: "usr-demo").path))  // stale copy deleted

        try store.save(try await mockTickets(), userId: "usr-demo", now: now)
        store.clear()
        #expect(store.load(userId: "usr-demo", now: now) == nil)
    }

    @MainActor
    @Test("Offline, My Tickets shows the saved copy and says so; signed out, it never does")
    func viewModelFallsBack() async throws {
        let offline = InMemoryOfflineTicketStore()
        let online = MyTicketsViewModel(repository: MockTicketsRepository(session: await signedInSession(), latency: .zero), offline: offline)
        await online.load(userId: "usr-demo", now: now)
        guard case .tickets(_, _, nil)? = online.state.value else { Issue.record("expected live tickets"); return }

        let cut = MyTicketsViewModel(repository: OfflineRepository(), offline: offline)
        await cut.load(userId: "usr-demo", now: now.addingTimeInterval(3600))
        guard case let .tickets(upcoming, _, offlineSince)? = cut.state.value else { Issue.record("expected saved tickets"); return }
        #expect(offlineSince == now)
        #expect(upcoming.count == 5 && upcoming.allSatisfy { $0.qrToken == nil })

        let signedOut = MyTicketsViewModel(repository: OfflineRepository(error: .unauthorized), offline: offline)
        await signedOut.load(userId: "usr-demo", now: now)
        guard case .signedOut? = signedOut.state.value else { Issue.record("expected signed out"); return }

        let nothingSaved = MyTicketsViewModel(repository: OfflineRepository(), offline: InMemoryOfflineTicketStore())
        await nothingSaved.load(userId: "usr-demo", now: now)
        guard case .failed = nothingSaved.state else { Issue.record("expected an error"); return }
    }

    @MainActor
    @Test("Signing out removes the saved tickets")
    func logoutClears() async throws {
        let offline = InMemoryOfflineTicketStore()
        let container = AppContainer.mock(offline: offline, latency: .zero)
        try await container.auth.login(email: MockAuthService.demoEmail, password: MockAuthService.demoPassword)
        try offline.save(try await container.tickets.tickets(), userId: "usr-demo", now: .now)
        #expect(offline.load(userId: "usr-demo", now: .now) != nil)

        await container.auth.logout()
        #expect(offline.load(userId: "usr-demo", now: .now) == nil)
    }

    @MainActor
    @Test("An expired session removes the saved tickets")
    func expiryClears() async throws {
        let offline = InMemoryOfflineTicketStore()
        let store = InMemoryTokenStore(StoredSession(tokens: TokenPair(accessToken: "a", refreshToken: "r"), identity: "x", user: nil))
        let config = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true)
        let session = AuthSession(store: store, configuration: config) { _ in
            throw APIError.server(status: 401, code: "INVALID_REFRESH_TOKEN", message: nil)
        }
        let auth = AuthStore(service: MockAuthService(session: session, latency: .zero), session: session, offlineTickets: offline)
        await auth.start()
        try offline.save(try await mockTickets(), userId: "usr-demo", now: .now)

        _ = await session.refreshAfterUnauthorized(rejected: "a")
        // Wait for the expiry event to reach the store (it is delivered asynchronously).
        for _ in 0..<100 where !auth.sessionExpired { try await Task.sleep(for: .milliseconds(10)) }
        #expect(auth.sessionExpired)
        #expect(offline.load(userId: "usr-demo", now: .now) == nil)
    }
}
