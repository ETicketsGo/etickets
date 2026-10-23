import Foundation
import Observation

/// The checkout the customer was in the middle of, kept across app termination so it can be
/// resumed. Holds only identifiers and the server's hold expiry — no amounts the app would
/// trust, no payment data. What happens next is always decided by GET /bookings/:id.
struct PendingCheckout: Codable, Equatable, Sendable {
    let bookingId: String
    let userId: String
    let title: String
    var holdExpiresAt: Date?
    /// Set once the customer has been handed to the payment provider: from then on the booking
    /// may confirm at any moment, so recovery polls rather than offering to pay again.
    var paymentStartedAt: Date?
}

@MainActor
@Observable
final class PendingCheckoutStore {
    private static let key = "etg.pendingCheckout.v1"
    private let defaults: UserDefaults
    private(set) var current: PendingCheckout?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        current = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(PendingCheckout.self, from: $0) }
    }

    func record(_ checkout: PendingCheckout) {
        current = checkout
        persist()
    }

    func markPaymentStarted(bookingId: String, at date: Date = .now) {
        guard current?.bookingId == bookingId else { return }
        current?.paymentStartedAt = date
        persist()
    }

    func clear(bookingId: String? = nil) {
        guard bookingId == nil || current?.bookingId == bookingId else { return }
        current = nil
        defaults.removeObject(forKey: Self.key)
    }

    /// Only the signed-in customer's own checkout is ever offered.
    func pending(for userId: String?) -> PendingCheckout? {
        guard let userId, current?.userId == userId else { return nil }
        return current
    }

    private func persist() {
        if let current, let data = try? JSONEncoder().encode(current) {
            defaults.set(data, forKey: Self.key)
        }
    }
}

/// A payment-return link: `https://<web host>/checkout/success?booking=<id>&session_id=…`,
/// `/checkout/cancel?booking=<id>`, or the app's own `<scheme>://checkout/return?booking=<id>`.
/// It identifies the booking to look at. It is NEVER evidence of payment: the app only ever
/// asks the server.
struct PaymentReturn: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case success, cancel }

    let bookingId: String
    let kind: Kind

    static func parse(_ url: URL, appScheme: String?, webHost: String?) -> PaymentReturn? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let isApp = appScheme != nil && components.scheme == appScheme
        let isWeb = components.scheme == "https" && webHost != nil && components.host == webHost
        guard isApp || isWeb else { return nil }
        // Website paths may carry a locale prefix (/en/checkout/success).
        let parts = (isApp ? [components.host ?? ""] + url.pathComponents : url.pathComponents).filter { $0 != "/" }
        guard let index = parts.firstIndex(of: "checkout"), parts.indices.contains(index + 1) else { return nil }
        let kind: Kind
        switch parts[index + 1] {
        case "success", "return": kind = .success
        case "cancel": kind = .cancel
        default: return nil
        }
        guard let booking = components.queryItems?.first(where: { $0.name == "booking" })?.value,
              !booking.isEmpty, booking.count <= 64,
              booking.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        else { return nil }
        return PaymentReturn(bookingId: booking, kind: kind)
    }
}
