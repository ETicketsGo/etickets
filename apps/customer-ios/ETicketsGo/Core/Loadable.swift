import Foundation

/// The lifecycle of one screen's data. Every view model exposes its content as one of these,
/// so loading, empty and error presentation is uniform across the app.
enum Loadable<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    var value: Value? {
        if case let .loaded(value) = self { return value }
        return nil
    }

    var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }
}

extension Error {
    /// A message safe to put on screen.
    var userMessage: String {
        (self as? APIError)?.userMessage ?? "Something went wrong. Please try again."
    }
}
