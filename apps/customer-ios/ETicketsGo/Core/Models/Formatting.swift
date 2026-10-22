import Foundation

/// Display formatting. Money arrives as integer minor units plus an ISO currency code;
/// the device locale decides how it reads.
enum Formatters {
    static func money(minor: Int, currency: String, locale: Locale = .current) -> String {
        let digits = minorDigits(for: currency)
        let amount = Decimal(minor) / pow(10, digits)
        return amount.formatted(
            .currency(code: currency).locale(locale).precision(.fractionLength(0...digits)))
    }

    /// "From ₹350", or "Free" when the cheapest ticket costs nothing.
    static func fromPrice(minor: Int?, currency: String, locale: Locale = .current) -> String? {
        guard let minor else { return nil }
        if minor == 0 { return "Free" }
        return "From \(money(minor: minor, currency: currency, locale: locale))"
    }

    static func eventDate(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    }

    static func dayAndTime(_ date: Date) -> (day: String, time: String) {
        (date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)),
         date.formatted(.dateTime.hour().minute()))
    }

    static func runtime(_ minutes: Int?) -> String? {
        guard let minutes, minutes > 0 else { return nil }
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }

    /// The API sends categories as slugs ("live-music"); show them as words.
    static func category(_ slug: String) -> String {
        slug.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ").capitalized
    }

    private static func minorDigits(for currency: String) -> Int {
        ["JPY", "KRW", "VND", "CLP"].contains(currency.uppercased()) ? 0 : 2
    }
}
