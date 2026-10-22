import Foundation

/// Which backend this build talks to. Set per build configuration (Config/*.xcconfig),
/// surfaced through Info.plist, and never chosen at runtime by the user.
enum AppEnvironment: String, Sendable, CaseIterable {
    /// Bundled fixtures only. No network access at all.
    case mock
    case qa
    case prod

    var displayName: String { rawValue.uppercased() }
}

struct AppConfiguration: Sendable, Equatable {
    let environment: AppEnvironment
    /// `nil` in MOCK. Includes the global `/api` prefix (apps/api/src/main.ts).
    let apiBaseURL: URL?
    /// The build's request to allow writes. Only QA honours it; see `permits(_:)`.
    let allowsMutations: Bool

    /// Phase 1 rule: reads are always allowed; writes only against QA, and only when the
    /// build opted in. PROD is read-only whatever the build settings say, so a misconfigured
    /// xcconfig cannot create a real booking or charge a real card.
    func permits(_ method: HTTPMethod) -> Bool {
        if method.isSafe { return true }
        switch environment {
        case .qa: return allowsMutations
        case .mock, .prod: return false
        }
    }

    /// Reads the values Config/Info.plist carries from the xcconfig. Anything missing or
    /// unrecognised falls back to MOCK — the one environment that cannot touch a server.
    static func load(from info: [String: Any]) -> AppConfiguration {
        let environment = (info["ETGEnvironment"] as? String)
            .flatMap { AppEnvironment(rawValue: $0.lowercased()) } ?? .mock
        guard environment != .mock else { return .mock }

        let urlString = (info["ETGAPIBaseURL"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        guard let url = URL(string: urlString), url.scheme == "https", url.host != nil else {
            return .mock
        }
        let allows = (info["ETGAllowMutations"] as? String)?.uppercased() == "YES"
        return AppConfiguration(environment: environment, apiBaseURL: url, allowsMutations: allows)
    }

    static func load(from bundle: Bundle = .main) -> AppConfiguration {
        load(from: bundle.infoDictionary ?? [:])
    }

    static let mock = AppConfiguration(environment: .mock, apiBaseURL: nil, allowsMutations: false)
}
