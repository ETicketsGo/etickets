import Foundation

/// Owns the signed-in session: the stored tokens, their renewal, and ending them.
///
/// Refresh rules (matching the Expo client, apps/customer-mobile/src/services/api-client.ts):
/// - Single-flight: however many requests hit 401 together, one POST /auth/refresh runs and
///   they all wait for it. The API rotates refresh tokens and treats a replayed one as theft
///   (auth.service.ts burns the whole token family), so two parallel refreshes would sign the
///   customer out.
/// - Tokens are cleared only when the server rejects the refresh. A network failure keeps
///   them: being offline is not a reason to lose a session.
actor AuthSession: AccessTokenProviding {
    enum Event: Sendable, Equatable {
        /// The server rejected the session (expired, revoked or replayed refresh token).
        case expired
    }

    typealias Refresher = @Sendable (_ refreshToken: String) async throws -> TokenPair

    private let store: any TokenStore
    private let configuration: AppConfiguration
    private let refresher: Refresher
    private var inFlight: Task<Bool, Never>?
    private let continuation: AsyncStream<Event>.Continuation
    nonisolated let events: AsyncStream<Event>

    /// `refresher` calls POST /auth/refresh through a client that carries no bearer token.
    init(store: any TokenStore, configuration: AppConfiguration, refresher: @escaping Refresher) {
        self.store = store
        self.configuration = configuration
        self.refresher = refresher
        (events, continuation) = AsyncStream.makeStream(of: Event.self)
    }

    var current: StoredSession? { store.read() }

    func begin(tokens: TokenPair, identity: String, user: AuthenticatedUser?) throws {
        try store.save(StoredSession(tokens: tokens, identity: identity, user: user))
    }

    func updateUser(_ user: AuthenticatedUser) {
        guard var session = store.read() else { return }
        session.user = user
        try? store.save(session)
    }

    func end() {
        inFlight?.cancel()
        inFlight = nil
        store.clear()
    }

    // MARK: AccessTokenProviding

    func accessToken() -> String? { store.read()?.tokens.accessToken }

    func mayWriteInQA() -> Bool {
        guard let identity = store.read()?.identity else { return false }
        return configuration.isApprovedTestAccount(identity)
    }

    func refreshAfterUnauthorized(rejected: String) async -> Bool {
        // Another request already refreshed while this one was in flight.
        if let current = store.read()?.tokens.accessToken, current != rejected { return true }
        if let inFlight { return await inFlight.value }

        let task = Task { await self.performRefresh() }
        inFlight = task
        let refreshed = await task.value
        inFlight = nil
        return refreshed
    }

    private func performRefresh() async -> Bool {
        guard let session = store.read() else { return false }
        do {
            let tokens = try await refresher(session.tokens.refreshToken)
            try store.save(StoredSession(tokens: tokens, identity: session.identity, user: session.user))
            return true
        } catch let APIError.server(status, _, _, _) where status == 401 || status == 400 {
            store.clear()
            continuation.yield(.expired)
            return false
        } catch {
            return false
        }
    }
}
