import Foundation

// Refund requests, as the customer sees them (apps/api/src/refunds). The SERVER decides every
// case: whether a booking may be refunded, which tickets, how much, and when. The app shows the
// window the event declares, sends the request, and shows what the server answered. It never
// computes an amount and never marks anything refunded itself. Mirrors the Android app
// (customer-mobile src/features/bookings/refunds.ts).

/// One refund on a booking. `amountMinor` is the server's figure once it has one.
struct Refund: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let status: String
    let amountMinor: Int?
    let currency: String?
    let reason: String?
    let createdAt: Date

    /// Still being worked on: a further request would be refused by the server.
    var isOpen: Bool { ["REQUESTED", "APPROVED", "PROCESSING"].contains(status.uppercased()) }

    /// Words for the state, so the screen never shows a raw enum.
    var statusLabel: String {
        switch status.uppercased() {
        case "REQUESTED": "Requested, waiting for the organizer"
        case "APPROVED": "Approved, being sent back"
        case "PROCESSING": "On its way to you"
        case "COMPLETED": "Refunded"
        case "REJECTED": "Not approved"
        case "FAILED": "Could not be sent. We are looking into it"
        default: status
        }
    }
}

struct RefundRequestBody: Encodable, Sendable {
    let bookingId: String
    let reason: String
}

/// Whether to OFFER a refund request, from the event's own terms: refunds enabled, and more
/// than `refundCutoffHours` before the start. Only a paid booking can be refunded. The server
/// checks again and may still refuse (a transferred ticket, a refund already open).
enum RefundWindow: Equatable, Sendable {
    case open(closesAt: Date)
    case closed(closedAt: Date)
    case notOffered
    case notApplicable

    static func of(_ booking: Booking, now: Date = .now) -> RefundWindow {
        let status = booking.status.uppercased()
        guard status == "CONFIRMED" || status == "PARTIALLY_REFUNDED" else { return .notApplicable }
        guard booking.event.refundsEnabled == true else { return .notOffered }
        let closes = booking.eventSession.startsAt.addingTimeInterval(-Double(max(0, booking.event.refundCutoffHours ?? 0)) * 3600)
        return now < closes ? .open(closesAt: closes) : .closed(closedAt: closes)
    }
}

/// The server's `reason` rule: 3 to 500 characters once trimmed.
func validRefundReason(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return (3...500).contains(trimmed.count) ? trimmed : nil
}
