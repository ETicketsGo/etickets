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

    /// "Sat, 7 Nov, 7:30 PM" in the venue's zone — the time printed on the ticket, wherever the
    /// customer is. When that differs from the device's zone, the zone is named ("7:30 PM IST").
    static func eventDate(_ date: Date, timeZone: String?, locale: Locale = .current, deviceZone: TimeZone = .current) -> String {
        let zone = venueZone(timeZone, deviceZone: deviceZone)
        var text = date.formatted(style(zone, locale).weekday(.abbreviated).day().month(.abbreviated).hour().minute())
        if let suffix = zoneSuffix(zone, at: date, locale: locale, deviceZone: deviceZone) { text += " \(suffix)" }
        return text
    }

    static func dayAndTime(_ date: Date, timeZone: String?, locale: Locale = .current, deviceZone: TimeZone = .current) -> (day: String, time: String) {
        let zone = venueZone(timeZone, deviceZone: deviceZone)
        var time = date.formatted(style(zone, locale).hour().minute())
        if let suffix = zoneSuffix(zone, at: date, locale: locale, deviceZone: deviceZone) { time += " \(suffix)" }
        return (date.formatted(style(zone, locale).weekday(.abbreviated).day().month(.abbreviated)), time)
    }

    static func time(_ date: Date, timeZone: String?, locale: Locale = .current, deviceZone: TimeZone = .current) -> String {
        dayAndTime(date, timeZone: timeZone, locale: locale, deviceZone: deviceZone).time
    }

    /// The venue's zone, or the device's when the API sent none or an unknown identifier.
    static func venueZone(_ identifier: String?, deviceZone: TimeZone = .current) -> TimeZone {
        identifier.flatMap(TimeZone.init(identifier:)) ?? deviceZone
    }

    private static func style(_ zone: TimeZone, _ locale: Locale) -> Date.FormatStyle {
        var style = Date.FormatStyle(locale: locale)
        style.timeZone = zone
        return style
    }

    private static func zoneSuffix(_ zone: TimeZone, at date: Date, locale: Locale, deviceZone: TimeZone) -> String? {
        guard zone.secondsFromGMT(for: date) != deviceZone.secondsFromGMT(for: date) else { return nil }
        return zone.localizedName(for: zone.isDaylightSavingTime(for: date) ? .shortDaylightSaving : .shortStandard, locale: locale)
            ?? zone.abbreviation(for: date)
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
