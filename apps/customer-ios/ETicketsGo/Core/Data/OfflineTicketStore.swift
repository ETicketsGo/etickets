import CryptoKit
import Foundation

/// The wallet as last fetched while signed in, for showing tickets with no connection.
/// Read-only: nothing is ever sent from it.
struct CachedWallet: Codable, Equatable, Sendable {
    /// Bumped when the shape changes, so an old file is discarded rather than misread.
    static let currentVersion = 1

    let version: Int
    let userId: String
    let syncedAt: Date
    let tickets: [Ticket]
}

/// Offline tickets, per signed-in user. Same rules as the Expo app's ticket cache
/// (apps/customer-mobile/src/services/ticket-cache.ts):
/// - only upcoming tickets are kept, and never the signed `qrToken` (the screen needs only the
///   server-rendered image);
/// - a copy older than 7 days is not shown;
/// - everything is removed at sign-out, when the server ends the session, and on a fresh install.
protocol OfflineTicketStore: Sendable {
    func save(_ tickets: [Ticket], userId: String, now: Date) throws
    func load(userId: String, now: Date) -> CachedWallet?
    func clear()
}

enum OfflineTicketPolicy {
    static let maxAge: TimeInterval = 7 * 24 * 3600
    /// A ticket stays "upcoming" until a few hours after it starts — it is needed at the door.
    static let graceAfterStart: TimeInterval = 6 * 3600

    static func keep(_ tickets: [Ticket], now: Date) -> [Ticket] {
        tickets.filter { $0.startsAt >= now.addingTimeInterval(-graceAfterStart) }.map { $0.offlineCopy() }
    }

    static func isUsable(_ wallet: CachedWallet, userId: String, now: Date) -> Bool {
        wallet.version == CachedWallet.currentVersion
            && wallet.userId == userId
            && now.timeIntervalSince(wallet.syncedAt) <= maxAge
            && wallet.syncedAt <= now.addingTimeInterval(60)
    }
}

/// One file per user in Application Support, named by a hash of the user id.
/// `completeFileProtection`: unreadable while the device is locked. Excluded from backups.
struct FileOfflineTicketStore: OfflineTicketStore {
    let directory: URL

    init(environment: AppEnvironment) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = base.appendingPathComponent("OfflineTickets-\(environment.rawValue)", isDirectory: true)
    }

    init(directory: URL) { self.directory = directory }

    func save(_ tickets: [Ticket], userId: String, now: Date) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)

        let wallet = CachedWallet(
            version: CachedWallet.currentVersion, userId: userId, syncedAt: now,
            tickets: OfflineTicketPolicy.keep(tickets, now: now))
        let data = try JSONEncoder().encode(wallet)
        try data.write(to: file(for: userId), options: [.atomic, .completeFileProtection])
    }

    func load(userId: String, now: Date) -> CachedWallet? {
        let url = file(for: userId)
        guard let data = try? Data(contentsOf: url),
              let wallet = try? JSONDecoder().decode(CachedWallet.self, from: data)
        else { return nil }
        guard OfflineTicketPolicy.isUsable(wallet, userId: userId, now: now) else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return wallet
    }

    func clear() {
        try? FileManager.default.removeItem(at: directory)
    }

    func file(for userId: String) -> URL {
        let digest = SHA256.hash(data: Data(userId.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(digest).json")
    }
}

/// For previews and tests.
final class InMemoryOfflineTicketStore: OfflineTicketStore, @unchecked Sendable {
    private let lock = NSLock()
    private var wallets: [String: CachedWallet] = [:]

    func save(_ tickets: [Ticket], userId: String, now: Date) throws {
        let wallet = CachedWallet(
            version: CachedWallet.currentVersion, userId: userId, syncedAt: now,
            tickets: OfflineTicketPolicy.keep(tickets, now: now))
        lock.withLock { wallets[userId] = wallet }
    }

    func load(userId: String, now: Date) -> CachedWallet? {
        lock.withLock {
            guard let wallet = wallets[userId], OfflineTicketPolicy.isUsable(wallet, userId: userId, now: now) else { return nil }
            return wallet
        }
    }

    func clear() { lock.withLock { wallets = [:] } }
}
