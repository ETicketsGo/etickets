import Foundation

// Booking and checkout wire models. Every money value here is the SERVER's answer, in minor
// units; the app displays these and never computes a price, fee, tax or discount itself.
// Sources (apps/api on main): pricing/fee-calculator.ts `FeeCalcResult`,
// pricing/tax-calculator.ts `TaxLine`, bookings.service.ts create/quote responses,
// shows.service.ts seat map, payments/provider `CreatePaymentResult`.

struct TaxLine: Codable, Hashable, Sendable {
    let label: String
    let rateBasisPoints: Int
    let baseMinor: Int
    let amountMinor: Int
    let basis: String?
    let inclusive: Bool?
}

/// `FeeCalcResult`: the server's breakdown for a selection or a booking.
struct FeeBreakdown: Codable, Hashable, Sendable {
    let currency: String
    let subtotalMinor: Int
    let discountMinor: Int
    let netSubtotalMinor: Int
    let bookingFeeMinor: Int
    let paymentFeeMinor: Int
    /// What the customer pays in fees (depends on the event's fee mode).
    let customerFeeMinor: Int
    let taxLines: [TaxLine]
    let taxMinor: Int
    let maintenanceMinor: Int?
    let totalMinor: Int
}

/// POST /bookings/quote → `{ fees, coupon }`. Public and side-effect free: holds nothing and
/// does not check availability, so it is an estimate; POST /bookings is the source of truth.
struct Quote: Codable, Hashable, Sendable {
    struct Coupon: Codable, Hashable, Sendable {
        let code: String?
        let applied: Bool
    }

    let fees: FeeBreakdown
    let coupon: Coupon
}

/// One line of a selection (packages/validation/src/booking.ts). For reserved seating,
/// `seatIds.count == quantity`.
struct BookingItem: Codable, Hashable, Sendable {
    let ticketTypeId: String
    let quantity: Int
    var seatIds: [String]?
}

struct QuoteBody: Encodable, Sendable {
    let eventSessionId: String
    let items: [BookingItem]
    let couponCode: String?
}

enum PaymentMethod: String, Codable, Sendable, CaseIterable {
    /// Card / UPI / wallet through the provider's checkout, chosen by the server per currency.
    case online = "ONLINE"
    /// Reserve now, pay at the venue — only where the event accepts cash.
    case cash = "CASH"
}

/// `createBookingSchema`.
struct CreateBookingBody: Encodable, Sendable {
    let eventSessionId: String
    let items: [BookingItem]
    let buyerName: String
    let buyerEmail: String
    let paymentMethod: PaymentMethod
    let couponCode: String?
}

/// POST /bookings response.
struct CreatedBooking: Codable, Hashable, Sendable {
    struct PaymentRef: Codable, Hashable, Sendable {
        let id: String?
        let status: String?
    }

    let id: String
    let status: String
    let currency: String
    let holdExpiresAt: Date?
    let fees: FeeBreakdown
    let paymentMethod: PaymentMethod
    let payment: PaymentRef?
}

/// POST /bookings/:id/pay. `clientActionUrl` is a hosted checkout URL (Stripe, PayPal, Square),
/// a relative mock path, or — for Razorpay — the order id, with the details in `razorpay`.
struct PaymentStart: Codable, Hashable, Sendable {
    struct Razorpay: Codable, Hashable, Sendable {
        let keyId: String
        let orderId: String
        let amountMinor: Int
        let currency: String
    }

    let providerRef: String?
    let clientActionUrl: String?
    let status: String
    let provider: String?
    let razorpay: Razorpay?
}

/// What the app can do with a PaymentStart. Decided from the server's response alone.
enum PaymentHandoff: Equatable, Sendable {
    /// A provider-hosted page, opened in an authentication session.
    case hostedPage(URL)
    /// MOCK only: the in-app simulated provider page.
    case simulated(bookingId: String)
    /// Razorpay Standard Checkout needs the native SDK or a server-hosted page; neither exists
    /// for the app yet (see docs/phase-3-checkout-design.md §10-A).
    case unsupported(reason: String)

    static func from(_ start: PaymentStart, bookingId: String, environment: AppEnvironment) -> PaymentHandoff {
        if start.razorpay != nil || start.provider == "razorpay" {
            return .unsupported(reason: "Paying with UPI or cards in India from the app is coming soon. Your seats are held — you can complete payment on eticketsgo.com.")
        }
        guard let action = start.clientActionUrl else {
            return .unsupported(reason: "The payment provider didn't return a checkout page.")
        }
        if environment == .mock, action.hasPrefix("mock://") { return .simulated(bookingId: bookingId) }
        if let url = URL(string: action), url.scheme == "https" { return .hostedPage(url) }
        return .unsupported(reason: "This payment method isn't available in the app yet.")
    }
}

// MARK: - Seat map (GET /public/shows/:sessionId/seats)

struct SeatMap: Codable, Hashable, Sendable {
    struct Category: Codable, Hashable, Sendable, Identifiable {
        let id: String
        let ticketTypeId: String
        let name: String
        let colorHex: String?
        let priceMinor: Int
    }

    struct Seat: Codable, Hashable, Sendable, Identifiable {
        let id: String
        let label: String
        let colIndex: Int
        let categoryId: String?
        let kind: String
        /// AVAILABLE, HELD, SOLD or BLOCKED. Only AVAILABLE may be chosen.
        let status: String

        var isSelectable: Bool { status == "AVAILABLE" && kind == "SEAT" }
    }

    struct Row: Codable, Hashable, Sendable {
        let label: String
        let seats: [Seat]
    }

    struct Section: Codable, Hashable, Sendable, Identifiable {
        let id: String
        let name: String
        /// Present in `view: "seats"`; absent in `view: "overview"`, where the customer picks a
        /// section first.
        let rows: [Row]?
        let availableCount: Int?
        let totalCount: Int?
    }

    let view: String
    let sessionId: String
    let sections: [Section]
    let categories: [Category]?
}

/// GET /public/location/cities
struct City: Codable, Hashable, Sendable, Identifiable {
    let city: String
    let country: String
    let countryCode: String?
    let eventCount: Int?

    var id: String { "\(city)|\(country)" }
}
