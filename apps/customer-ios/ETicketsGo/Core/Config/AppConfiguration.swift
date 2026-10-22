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
    /// QA only: the identities allowed to write (sign in, sign up, and anything after).
    /// Exact email addresses or E.164 phone numbers. No patterns: a wildcard could admit
    /// accounts nobody approved.
    var qaTestAccounts: [String] = []

    /// Reads are always allowed; writes only against QA, and only when the build opted in.
    /// PROD is read-only whatever the build settings say, so a misconfigured xcconfig cannot
    /// create a real booking, a real account or a real session.
    func permits(_ method: HTTPMethod) -> Bool {
        if method.isSafe { return true }
        switch environment {
        case .qa: return allowsMutations
        case .mock, .prod: return false
        }
    }

    /// Whether this identity may write. MOCK writes nothing real, so anyone may; QA requires
    /// the identity to be on the approved list; PROD allows nobody in this phase.
    func isApprovedTestAccount(_ identity: String) -> Bool {
        switch environment {
        case .mock: return true
        case .prod: return false
        case .qa:
            let id = Self.normalised(identity)
            guard !id.isEmpty else { return false }
            return qaTestAccounts.contains { entry in
                let approved = Self.normalised(entry)
                return !approved.isEmpty && !approved.contains("*") && approved == id
            }
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
        let accounts = (info["ETGQATestAccounts"] as? String ?? "")
            .split(whereSeparator: { $0 == " " || $0 == "," })
            .map(String.init)
        return AppConfiguration(
            environment: environment, apiBaseURL: url, allowsMutations: allows,
            qaTestAccounts: environment == .qa ? accounts : [])
    }

    static func load(from bundle: Bundle = .main) -> AppConfiguration {
        load(from: bundle.infoDictionary ?? [:])
    }

    static let mock = AppConfiguration(environment: .mock, apiBaseURL: nil, allowsMutations: false)

    /// Lower-cased, and phone formatting removed so "+91 98765 43210" matches "+919876543210".
    private static func normalised(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespaces).lowercased()
        guard trimmed.first == "+" || trimmed.first?.isNumber == true else { return trimmed }
        return trimmed.filter { $0 == "+" || $0 == "*" || $0.isNumber }
    }
}
