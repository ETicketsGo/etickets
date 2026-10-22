import Foundation
import Security

/// The access/refresh pair from POST /auth/login, /auth/register, /auth/phone/verify and
/// /auth/refresh (auth.service.ts `issueTokens`). Access tokens live 15 minutes by default,
/// refresh tokens 30 days, and every refresh rotates the refresh token.
struct TokenPair: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    let accessToken: String
    let refreshToken: String

    // Never print a token: not in logs, not in a crash report, not in the debugger summary.
    var description: String { "TokenPair(<redacted>)" }
    var debugDescription: String { description }
}

/// What is kept between launches. The identity is the email or phone the customer signed in
/// with — needed to apply the QA test-account rule after a relaunch. `user` is a cached copy
/// so a relaunch can show who is signed in before /auth/me answers.
struct StoredSession: Codable, Equatable, Sendable, CustomStringConvertible {
    let tokens: TokenPair
    let identity: String
    var user: AuthenticatedUser?

    var description: String { "StoredSession(identity: <redacted>, tokens: <redacted>)" }
}

protocol TokenStore: Sendable {
    func read() -> StoredSession?
    func save(_ session: StoredSession) throws
    func clear()
}

enum TokenStoreError: Error, Equatable {
    case keychain(OSStatus)
}

/// Keychain-backed session storage.
///
/// - One generic-password item holds the whole session, so the pair can never be half-written.
/// - `AfterFirstUnlockThisDeviceOnly`: readable by background refreshes after the first unlock,
///   never included in backups or migrated to another device.
/// - Not synchronizable: never leaves the device through iCloud Keychain.
/// - Nothing about the session is written to UserDefaults, files or logs.
struct KeychainTokenStore: TokenStore {
    let service: String
    let account = "session"

    init(environment: AppEnvironment) {
        service = "com.eticketsgo.customer.native.auth.\(environment.rawValue)"
    }

    init(service: String) { self.service = service }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }

    func read() -> StoredSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data
        else { return nil }
        return try? JSONDecoder().decode(StoredSession.self, from: data)
    }

    func save(_ session: StoredSession) throws {
        let data = try JSONEncoder().encode(session)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(baseQuery.merging(attributes) { $1 } as CFDictionary, nil)
            guard added == errSecSuccess else { throw TokenStoreError.keychain(added) }
        } else if status != errSecSuccess {
            throw TokenStoreError.keychain(status)
        }
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    /// The stored item's protection attributes, for the security tests.
    func attributes() -> [String: Any]? {
        var query = baseQuery
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? [String: Any]
    }
}

/// iOS keeps Keychain items after an app is deleted. Without this, reinstalling the app — or
/// a phone passed to someone else who installs it — would come back signed in as the previous
/// customer. On the first launch of an install, any stored session is removed. Only a flag is
/// kept in UserDefaults (which, unlike the Keychain, is deleted with the app); never a token.
enum FreshInstallGuard {
    static let markerKey = "etg.installMarker.v1"

    static func clearSessionIfNewInstall(_ store: any TokenStore, defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: markerKey) else { return }
        store.clear()
        defaults.set(true, forKey: markerKey)
    }
}

/// For previews and tests.
final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var session: StoredSession?

    init(_ session: StoredSession? = nil) { self.session = session }

    func read() -> StoredSession? { lock.withLock { session } }
    func save(_ session: StoredSession) throws { lock.withLock { self.session = session } }
    func clear() { lock.withLock { session = nil } }
}
