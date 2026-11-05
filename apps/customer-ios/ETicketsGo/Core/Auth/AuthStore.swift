import Foundation
import Observation

/// The signed-in state the UI observes. Screens react to `state`; the sign-in sheet calls the
/// actions and shows their errors.
@MainActor
@Observable
final class AuthStore {
    enum State: Equatable, Sendable {
        case restoring
        case signedOut
        case signedIn(AuthenticatedUser)
    }

    private(set) var state: State = .restoring
    /// Set when the server ended the session, so the UI can say why the customer is signed out.
    private(set) var sessionExpired = false
    var isPresentingSignIn = false

    private let service: any AuthService
    private let session: AuthSession
    /// Removed whenever the session ends, so a signed-out phone holds no tickets.
    private let offlineTickets: any OfflineTicketStore
    private var listener: Task<Void, Never>?

    init(service: any AuthService, session: AuthSession, offlineTickets: any OfflineTicketStore = InMemoryOfflineTicketStore()) {
        self.service = service
        self.session = session
        self.offlineTickets = offlineTickets
    }

    /// Changes whenever who is signed in changes — including restoring → signed out, which
    /// `user` alone cannot tell apart. Screens key their reloads on it.
    var sessionKey: String {
        switch state {
        case .restoring: "restoring"
        case .signedOut: "signed-out"
        case let .signedIn(user): "user:\(user.id)"
        }
    }

    var user: AuthenticatedUser? {
        if case let .signedIn(user) = state { return user }
        return nil
    }

    func start() async {
        if listener == nil {
            let events = session.events
            let offline = offlineTickets
            listener = Task { [weak self] in
                for await event in events where event == .expired {
                    offline.clear()
                    self?.state = .signedOut
                    self?.sessionExpired = true
                }
            }
        }
        guard state == .restoring else { return }
        state = await service.restore().map(State.signedIn) ?? .signedOut
    }

    func login(email: String, password: String) async throws {
        state = .signedIn(try await service.login(email: email, password: password))
        didSignIn()
    }

    func register(_ form: RegistrationForm) async throws {
        state = .signedIn(try await service.register(form))
        didSignIn()
    }

    func requestPhoneCode(phone: String) async throws {
        try await service.requestPhoneCode(phone: phone)
    }

    func verifyPhoneCode(phone: String, code: String, fullName: String?) async throws {
        state = .signedIn(try await service.verifyPhoneCode(phone: phone, code: code, fullName: fullName))
        didSignIn()
    }

    func logout() async {
        await service.logout()
        offlineTickets.clear()
        state = .signedOut
    }

    func profile() async throws -> UserProfile {
        try await service.profile()
    }

    func updateProfile(fullName: String, countryOfResidence: String?) async throws {
        state = .signedIn(try await service.updateProfile(fullName: fullName, countryOfResidence: countryOfResidence))
    }

    /// On success nothing of the account is left on this phone: session, offline tickets and
    /// the checkout awaiting recovery are all removed.
    func deleteAccount(pendingCheckout: PendingCheckoutStore? = nil) async -> AccountDeletionOutcome {
        let outcome = await service.deleteAccount()
        if outcome == .deleted {
            offlineTickets.clear()
            pendingCheckout?.clear()
            sessionExpired = false
            state = .signedOut
        }
        return outcome
    }

    private func didSignIn() {
        sessionExpired = false
        isPresentingSignIn = false
    }
}
