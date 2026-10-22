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
    private var listener: Task<Void, Never>?

    init(service: any AuthService, session: AuthSession) {
        self.service = service
        self.session = session
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
            listener = Task { [weak self] in
                for await event in events where event == .expired {
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
        state = .signedOut
    }

    private func didSignIn() {
        sessionExpired = false
        isPresentingSignIn = false
    }
}
