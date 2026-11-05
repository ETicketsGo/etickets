import Foundation
import Observation

/// The customer's chosen city, which scopes Home and Explore (the API's `city` parameter).
/// A preference, not a secret: kept in UserDefaults.
@MainActor
@Observable
final class CityStore {
    private static let key = "etg.city.v1"
    private let defaults: UserDefaults

    private(set) var selected: City?
    var isPresentingPicker = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        selected = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(City.self, from: $0) }
    }

    func choose(_ city: City?) {
        selected = city
        if let city, let data = try? JSONEncoder().encode(city) {
            defaults.set(data, forKey: Self.key)
        } else {
            defaults.removeObject(forKey: Self.key)
        }
        isPresentingPicker = false
    }
}
