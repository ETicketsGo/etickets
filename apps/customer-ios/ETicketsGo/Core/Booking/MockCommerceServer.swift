import CoreImage.CIFilterBuiltins
import Foundation
import UIKit

/// MOCK ONLY. An in-memory stand-in for the ETicketsGo backend's booking, pricing, inventory,
/// payment-provider and ticket-issuance services, so the whole purchase journey can be
/// demonstrated with no network and no money.
///
/// Everything in here plays the SERVER's part. The fee arithmetic below exists only so the
/// simulation returns realistic `FeeCalcResult`s; app code never prices anything and never
/// calls into this type except through `BookingRepository`/`TicketsRepository`, exactly as it
/// calls the real API. Nothing here ships in a QA or PROD code path.
actor MockCommerceServer {
    struct HeldBooking: Codable {
        var booking: Booking
        let sessionId: String
        let items: [BookingItem]
        let fees: FeeBreakdown
        var paymentStarted = false
    }

    private let fixtures: FixtureStore
    private let holdDuration: TimeInterval
    private let confirmationDelay: Duration
    private var events: [EventDetail] = []
    private var heldSeats: [String: String] = [:]          // seatId → bookingId
    private var soldSeats: Set<String> = []
    private var soldByType: [String: Int] = [:]            // ticketTypeId → quantity
    private var bookings: [String: HeldBooking] = [:]
    private var byIdempotencyKey: [String: CreatedBooking] = [:]
    private(set) var issuedTickets: [Ticket] = []
    private var sequence = 0
    private let persists: Bool

    /// What survives an app relaunch (MOCK only, in Caches; never in QA or PROD).
    private struct SavedState: Codable {
        var heldSeats: [String: String]
        var soldSeats: Set<String>
        var soldByType: [String: Int]
        var bookings: [String: HeldBooking]
        var issuedTickets: [Ticket]
        var sequence: Int
    }

    private static var stateURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("mock-commerce-state.json")
    }

    nonisolated static func discardSavedState() {
        try? FileManager.default.removeItem(at: stateURL)
    }

    init(fixtures: FixtureStore = FixtureStore(), holdDuration: TimeInterval = 600, confirmationDelay: Duration = .seconds(3), persists: Bool = false) {
        self.fixtures = fixtures
        self.holdDuration = holdDuration
        self.confirmationDelay = confirmationDelay
        self.persists = persists
        if persists, let data = try? Data(contentsOf: Self.stateURL),
           let saved = try? JSONDecoder().decode(SavedState.self, from: data) {
            heldSeats = saved.heldSeats
            soldSeats = saved.soldSeats
            soldByType = saved.soldByType
            bookings = saved.bookings
            issuedTickets = saved.issuedTickets
            sequence = saved.sequence
        }
    }

    private func save() {
        guard persists else { return }
        let state = SavedState(heldSeats: heldSeats, soldSeats: soldSeats, soldByType: soldByType,
                               bookings: bookings, issuedTickets: issuedTickets, sequence: sequence)
        try? JSONEncoder().encode(state).write(to: Self.stateURL, options: .atomic)
    }

    // MARK: Catalogue lookups

    private func allEvents() throws -> [EventDetail] {
        if events.isEmpty { events = try fixtures.load("event-details") }
        return events
    }

    private func session(_ id: String) throws -> (EventDetail, EventSession) {
        for event in try allEvents() {
            if let session = event.sessions.first(where: { $0.id == id }) { return (event, session) }
        }
        throw APIError.server(status: 404, code: "NOT_FOUND", message: "That show is no longer available.")
    }

    // MARK: Seat map

    /// A deterministic theatre for any seat-based session: rows A–H × 12 seats. The last two rows
    /// are the session's second ticket type (if any); a fixed pattern is already sold.
    func seatMap(sessionId: String) throws -> SeatMap {
        let (_, session) = try session(sessionId)
        guard session.seatBased == true, let first = session.ticketTypes.first else {
            throw APIError.server(status: 404, code: "NO_SEAT_MAP", message: "This show has no reserved seating.")
        }
        let premium = session.ticketTypes.count > 1 ? session.ticketTypes[1] : first
        let categories = [
            SeatMap.Category(id: "cat-\(first.id)", ticketTypeId: first.id, name: first.name, colorHex: nil, priceMinor: first.priceMinor),
            SeatMap.Category(id: "cat-\(premium.id)", ticketTypeId: premium.id, name: premium.name, colorHex: "#B8955A", priceMinor: premium.priceMinor),
        ]
        let rows = ["A", "B", "C", "D", "E", "F", "G", "H"].enumerated().map { index, label in
            let category = index >= 6 ? categories[1] : categories[0]
            let seats = (1...12).map { col -> SeatMap.Seat in
                let id = "\(sessionId)-\(label)\(col)"
                let presold = (index * 7 + col * 3) % 11 == 0
                let status = presold || soldSeats.contains(id) ? "SOLD" : heldSeats[id] != nil ? "HELD" : "AVAILABLE"
                return SeatMap.Seat(id: id, label: "\(col)", colIndex: col, categoryId: category.id, kind: "SEAT", status: status)
            }
            return SeatMap.Row(label: label, seats: seats)
        }
        return SeatMap(view: "seats", sessionId: sessionId,
                       sections: [SeatMap.Section(id: "main", name: "Auditorium", rows: rows, availableCount: nil, totalCount: nil)],
                       categories: categories)
    }

    // MARK: Pricing (server stand-in)

    func quote(_ body: QuoteBody) throws -> Quote {
        Quote(fees: try price(sessionId: body.eventSessionId, items: body.items), coupon: .init(code: body.couponCode, applied: false))
    }

    private func price(sessionId: String, items: [BookingItem]) throws -> FeeBreakdown {
        let (_, session) = try session(sessionId)
        var subtotal = 0, tickets = 0
        var currency = "INR"
        for item in items {
            guard let type = session.ticketTypes.first(where: { $0.id == item.ticketTypeId }) else {
                throw APIError.server(status: 400, code: "VALIDATION_FAILED", message: "That ticket type isn't on sale for this show.")
            }
            subtotal += type.priceMinor * item.quantity
            tickets += item.quantity
            currency = type.currency
        }
        guard subtotal > 0 else {
            return FeeBreakdown(currency: currency, subtotalMinor: 0, discountMinor: 0, netSubtotalMinor: 0, bookingFeeMinor: 0,
                                paymentFeeMinor: 0, customerFeeMinor: 0, taxLines: [], taxMinor: 0, maintenanceMinor: 0, totalMinor: 0)
        }
        let bookingFee = 1000 * tickets
        let paymentFee = Int((Double(subtotal + bookingFee) * 0.02).rounded())
        let fees = bookingFee + paymentFee
        let gst = Int((Double(fees) * 0.18).rounded())
        let taxLines = currency == "INR"
            ? [TaxLine(label: "GST on fees (18%)", rateBasisPoints: 1800, baseMinor: fees, amountMinor: gst, basis: "FEES", inclusive: false)]
            : []
        let tax = taxLines.reduce(0) { $0 + $1.amountMinor }
        return FeeBreakdown(currency: currency, subtotalMinor: subtotal, discountMinor: 0, netSubtotalMinor: subtotal,
                            bookingFeeMinor: bookingFee, paymentFeeMinor: paymentFee, customerFeeMinor: fees,
                            taxLines: taxLines, taxMinor: tax, maintenanceMinor: 0, totalMinor: subtotal + fees + tax)
    }

    // MARK: Bookings

    func createBooking(_ body: CreateBookingBody, idempotencyKey: String, now: Date = .now) throws -> CreatedBooking {
        if let replay = byIdempotencyKey[idempotencyKey] { return replay }
        expireHolds(now: now)
        let (event, session) = try session(body.eventSessionId)

        for item in body.items {
            guard let type = session.ticketTypes.first(where: { $0.id == item.ticketTypeId }) else {
                throw APIError.server(status: 400, code: "VALIDATION_FAILED", message: "That ticket type isn't on sale for this show.")
            }
            if let seats = item.seatIds {
                guard seats.count == item.quantity else {
                    throw APIError.server(status: 400, code: "VALIDATION_FAILED", message: "Choose one seat per ticket.")
                }
                let map = try seatMap(sessionId: body.eventSessionId)
                let status = Dictionary(uniqueKeysWithValues: map.sections.flatMap { $0.rows ?? [] }.flatMap(\.seats).map { ($0.id, $0.status) })
                guard seats.allSatisfy({ status[$0] == "AVAILABLE" }) else {
                    throw APIError.server(status: 409, code: "BOOKING_INVENTORY_UNAVAILABLE",
                                          message: "Some of those seats were just taken. Please choose again.")
                }
            } else {
                let remaining = type.available - (soldByType[type.id] ?? 0) - held(typeId: type.id)
                guard item.quantity <= remaining else {
                    throw APIError.server(status: 409, code: "BOOKING_INVENTORY_UNAVAILABLE",
                                          message: remaining > 0 ? "Only \(remaining) left for \(type.name)." : "\(type.name) just sold out.")
                }
            }
        }

        let fees = try price(sessionId: body.eventSessionId, items: body.items)
        sequence += 1
        let id = "bkg-mock-\(sequence)"
        let free = fees.totalMinor == 0
        let holdExpiresAt = free ? nil : now.addingTimeInterval(holdDuration)
        let booking = Booking(
            id: id, eventId: event.id, eventSessionId: session.id, reference: free ? reference() : nil,
            buyerName: body.buyerName, buyerEmail: body.buyerEmail, status: free ? "CONFIRMED" : "PENDING_PAYMENT",
            currency: fees.currency, subtotalMinor: fees.subtotalMinor, bookingFeeMinor: fees.bookingFeeMinor,
            paymentFeeMinor: fees.paymentFeeMinor, discountMinor: fees.discountMinor, customerFeeMinor: fees.customerFeeMinor,
            totalMinor: fees.totalMinor, holdExpiresAt: holdExpiresAt, confirmedAt: free ? now : nil, cancelledAt: nil,
            createdAt: now, event: .init(title: event.title, slug: event.slug), eventSession: .init(startsAt: session.startsAt),
            counts: .init(tickets: body.items.reduce(0) { $0 + $1.quantity }))
        bookings[id] = HeldBooking(booking: booking, sessionId: session.id, items: body.items, fees: fees)
        for seat in body.items.flatMap({ $0.seatIds ?? [] }) { heldSeats[seat] = id }
        if free { try issue(bookingId: id, now: now) }

        let created = CreatedBooking(id: id, status: booking.status, currency: fees.currency, holdExpiresAt: holdExpiresAt,
                                     fees: fees, paymentMethod: body.paymentMethod,
                                     payment: free ? nil : .init(id: "pay-\(id)", status: "REQUIRES_PAYMENT"))
        byIdempotencyKey[idempotencyKey] = created
        save()
        return created
    }

    func booking(id: String, now: Date = .now) throws -> Booking {
        expireHolds(now: now)
        guard let held = bookings[id] else {
            throw APIError.server(status: 404, code: "NOT_FOUND", message: "Booking not found.")
        }
        return held.booking
    }

    func allBookings() -> [Booking] {
        bookings.values.map(\.booking).sorted { $0.createdAt > $1.createdAt }
    }

    func startPayment(bookingId: String, now: Date = .now) throws -> PaymentStart {
        let booking = try booking(id: bookingId, now: now)
        guard booking.status == "PENDING_PAYMENT" else {
            throw APIError.server(status: 409, code: "BOOKING_NOT_PAYABLE",
                                  message: booking.status == "EXPIRED" ? "Your hold has ended." : "This booking can't be paid.")
        }
        bookings[bookingId]?.paymentStarted = true
        save()
        return PaymentStart(providerRef: "mock_\(bookingId)", clientActionUrl: "mock://checkout/\(bookingId)",
                            status: "REQUIRES_PAYMENT", provider: "mock", razorpay: nil)
    }

    /// The simulated provider's "payment approved". Like a real provider, the result reaches the
    /// booking later, through the (simulated) webhook — the app learns of it only by polling.
    func providerApproved(bookingId: String) {
        let delay = confirmationDelay
        Task {
            try? await Task.sleep(for: delay)
            try? await self.confirm(bookingId: bookingId)
        }
    }

    func cancel(bookingId: String, now: Date = .now) throws {
        let booking = try booking(id: bookingId, now: now)
        guard booking.status == "PENDING_PAYMENT" else {
            throw APIError.server(status: 409, code: "BOOKING_NOT_CANCELLABLE", message: "Paid bookings are refunded, not cancelled.")
        }
        setStatus(bookingId, "CANCELLED", cancelledAt: now)
        release(bookingId)
        save()
    }

    // MARK: Server-side transitions

    private func confirm(bookingId: String, now: Date = .now) throws {
        expireHolds(now: now)
        guard let held = bookings[bookingId], held.booking.status == "PENDING_PAYMENT" else { return }
        for item in held.items {
            soldByType[item.ticketTypeId, default: 0] += item.quantity
            for seat in item.seatIds ?? [] { soldSeats.insert(seat); heldSeats[seat] = nil }
        }
        var booking = held.booking
        booking = Booking(id: booking.id, eventId: booking.eventId, eventSessionId: booking.eventSessionId, reference: reference(),
                          buyerName: booking.buyerName, buyerEmail: booking.buyerEmail, status: "CONFIRMED",
                          currency: booking.currency, subtotalMinor: booking.subtotalMinor, bookingFeeMinor: booking.bookingFeeMinor,
                          paymentFeeMinor: booking.paymentFeeMinor, discountMinor: booking.discountMinor,
                          customerFeeMinor: booking.customerFeeMinor, totalMinor: booking.totalMinor, holdExpiresAt: nil,
                          confirmedAt: now, cancelledAt: nil, createdAt: booking.createdAt, event: booking.event,
                          eventSession: booking.eventSession, counts: booking.counts)
        bookings[bookingId]?.booking = booking
        try issue(bookingId: bookingId, now: now)
        save()
    }

    private func issue(bookingId: String, now: Date) throws {
        guard let held = bookings[bookingId] else { return }
        let (event, session) = try session(held.sessionId)
        for item in held.items {
            let typeName = session.ticketTypes.first { $0.id == item.ticketTypeId }?.name ?? "Ticket"
            for index in 0..<item.quantity {
                sequence += 1
                let serial = "ETG-MOCK-\(String(format: "%04d", sequence))"
                let seat = item.seatIds.map { $0[index].split(separator: "-").last.map(String.init) } ?? nil
                issuedTickets.append(Ticket(
                    id: "tkt-mock-\(sequence)", serial: serial, status: "ACTIVE", holderName: held.booking.buyerName,
                    ticketType: typeName, event: .init(title: event.title, slug: event.slug), startsAt: session.startsAt,
                    qrToken: "MOCK.\(serial)", qrDataUrl: Self.qrDataURL("MOCK.\(serial)"), bookingId: bookingId,
                    bookingRef: bookings[bookingId]?.booking.reference, experienceType: event.experienceType,
                    seatLabel: seat, venueName: event.venue.name, screenName: nil, cinemaName: nil,
                    assignmentStatus: "UNASSIGNED", attendeeName: nil, ownedByViewer: true, assignedToViewer: false,
                    timezone: session.timeZone ?? event.timeZone, vendorBarcode: nil, vendorBarcodeFormat: nil, cachedPresentable: nil))
            }
        }
    }

    private func expireHolds(now: Date) {
        for (id, held) in bookings where held.booking.status == "PENDING_PAYMENT" {
            if let expiry = held.booking.holdExpiresAt, expiry <= now {
                setStatus(id, "EXPIRED", cancelledAt: nil)
                release(id)
                save()
            }
        }
    }

    private func release(_ bookingId: String) {
        for (seat, owner) in heldSeats where owner == bookingId { heldSeats[seat] = nil }
    }

    private func held(typeId: String) -> Int {
        bookings.values.filter { $0.booking.status == "PENDING_PAYMENT" }
            .flatMap(\.items).filter { $0.ticketTypeId == typeId && $0.seatIds == nil }.reduce(0) { $0 + $1.quantity }
    }

    private func setStatus(_ id: String, _ status: String, cancelledAt: Date?) {
        guard let b = bookings[id]?.booking else { return }
        bookings[id]?.booking = Booking(
            id: b.id, eventId: b.eventId, eventSessionId: b.eventSessionId, reference: b.reference, buyerName: b.buyerName,
            buyerEmail: b.buyerEmail, status: status, currency: b.currency, subtotalMinor: b.subtotalMinor,
            bookingFeeMinor: b.bookingFeeMinor, paymentFeeMinor: b.paymentFeeMinor, discountMinor: b.discountMinor,
            customerFeeMinor: b.customerFeeMinor, totalMinor: b.totalMinor, holdExpiresAt: b.holdExpiresAt,
            confirmedAt: b.confirmedAt, cancelledAt: cancelledAt, createdAt: b.createdAt, event: b.event,
            eventSession: b.eventSession, counts: b.counts)
    }

    private func reference() -> String {
        "ETG-MOCK-" + String(UUID().uuidString.prefix(6))
    }

    /// The simulated server renders the QR image, as tickets.service.ts does with `qrcode`.
    private static func qrDataURL(_ payload: String) -> String? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent),
              let png = UIImage(cgImage: cg).pngData() else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}

/// MOCK booking repository: the in-memory server above, with a small delay so loading states
/// are real. Writes need a signed-in session, like POST /bookings.
struct MockBookingRepository: BookingRepository {
    let server: MockCommerceServer
    let session: AuthSession
    var fixtures = FixtureStore()
    var latency: Duration = .milliseconds(400)

    func cities() async throws -> [City] {
        try await pause()
        return try fixtures.load("cities")
    }

    func seatMap(sessionId: String, section: String?) async throws -> SeatMap {
        try await pause()
        return try await server.seatMap(sessionId: sessionId)
    }

    func quote(_ body: QuoteBody) async throws -> Quote {
        try await pause()
        return try await server.quote(body)
    }

    func createBooking(_ body: CreateBookingBody, idempotencyKey: String) async throws -> CreatedBooking {
        try await signedIn()
        return try await server.createBooking(body, idempotencyKey: idempotencyKey)
    }

    func startPayment(bookingId: String) async throws -> PaymentStart {
        try await signedIn()
        return try await server.startPayment(bookingId: bookingId)
    }

    func booking(id: String) async throws -> Booking {
        try await signedIn()
        return try await server.booking(id: id)
    }

    func cancel(bookingId: String) async throws {
        try await signedIn()
        try await server.cancel(bookingId: bookingId)
    }

    private func pause() async throws {
        if latency > .zero { try await Task.sleep(for: latency) }
    }

    private func signedIn() async throws {
        try await pause()
        guard await session.accessToken() != nil else { throw APIError.unauthorized }
    }
}
