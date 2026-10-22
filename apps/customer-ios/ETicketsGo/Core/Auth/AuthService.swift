import Foundation

enum AuthError: Error, Equatable, Sendable {
    /// QA: the identity is not on the approved test-account list. PROD: sign-in is disabled.
    case notPermittedInThisBuild
    /// Back-office account that must complete MFA; the customer app does not support it.
    case mfaRequired

    var userMessage: String {
        switch self {
        case .notPermittedInThisBuild:
            return "Sign-in isn't available for this account in this build."
        case .mfaRequired:
            return "This account uses two-step verification. Please sign in on the web console."
        }
    }
}

struct RegistrationForm: Sendable, Equatable {
    var fullName: String
    var email: String
    var password: String
    var phone: String?
    var smsConsent: Bool?
    var country: String?
}

/// Everything the UI needs from authentication. One implementation talks to the API; the mock
/// follows the same rules against fixtures.
protocol AuthService: Sendable {
    /// The session found at launch, if any; refreshed from /auth/me when reachable.
    func restore() async -> AuthenticatedUser?
    func login(email: String, password: String) async throws -> AuthenticatedUser
    func register(_ form: RegistrationForm) async throws -> AuthenticatedUser
    func requestPhoneCode(phone: String) async throws
    func verifyPhoneCode(phone: String, code: String, fullName: String?) async throws -> AuthenticatedUser
    /// Revokes the refresh token when the server can be reached; always ends the local session.
    func logout() async
}

extension AuthService {
    /// Trims and lower-cases an email as `emailSchema` does, so the identity the QA rule sees
    /// is the one the server stores.
    static func normalisedEmail(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct RemoteAuthService: AuthService {
    /// Sends no bearer token: auth-flow requests only.
    let publicClient: APIClient
    /// Bearer-authenticated, with refresh. For /auth/me.
    let client: APIClient
    let session: AuthSession
    let configuration: AppConfiguration

    func restore() async -> AuthenticatedUser? {
        guard let stored = await session.current else { return nil }
        do {
            let user = try await client.send(CustomerAPI.me())
            await session.updateUser(user)
            return user
        } catch APIError.unauthorized {
            // The refresh was rejected too (AuthSession has already cleared the tokens).
            await session.end()
            return nil
        } catch {
            // Offline or the server is down: stay signed in with the cached profile.
            return stored.user
        }
    }

    func login(email: String, password: String) async throws -> AuthenticatedUser {
        let email = Self.normalisedEmail(email)
        try requireApproved(email)
        let result = try await publicClient.send(AuthAPI.login(LoginBody(email: email, password: password)))
        return try await begin(result, identity: email)
    }

    func register(_ form: RegistrationForm) async throws -> AuthenticatedUser {
        let email = Self.normalisedEmail(form.email)
        try requireApproved(email)
        let body = RegisterBody(
            email: email, password: form.password,
            fullName: form.fullName.trimmingCharacters(in: .whitespaces),
            phone: form.phone, smsConsent: form.smsConsent, country: form.country)
        let result = try await publicClient.send(AuthAPI.register(body))
        return try await begin(result, identity: email)
    }

    func requestPhoneCode(phone: String) async throws {
        try requireApproved(phone)
        _ = try await publicClient.send(AuthAPI.requestPhoneCode(phone))
    }

    func verifyPhoneCode(phone: String, code: String, fullName: String?) async throws -> AuthenticatedUser {
        try requireApproved(phone)
        let result = try await publicClient.send(
            AuthAPI.verifyPhoneCode(PhoneVerifyBody(phone: phone, code: code, fullName: fullName)))
        return try await begin(.tokens(result.tokens), identity: phone)
    }

    func logout() async {
        if let refresh = await session.current?.tokens.refreshToken {
            // Best effort: an unreachable server must not keep someone signed in on this device.
            _ = try? await publicClient.send(AuthAPI.logout(refresh))
        }
        await session.end()
    }

    private func begin(_ result: LoginResult, identity: String) async throws -> AuthenticatedUser {
        guard case let .tokens(tokens) = result else { throw AuthError.mfaRequired }
        try await session.begin(tokens: tokens, identity: identity, user: nil)
        do {
            let user = try await client.send(CustomerAPI.me())
            await session.updateUser(user)
            return user
        } catch {
            await session.end()
            throw error
        }
    }

    /// QA: only approved test accounts may sign in or sign up. PROD: nobody, this phase.
    /// Checked before anything is sent, so an unapproved identity never reaches the server.
    private func requireApproved(_ identity: String) throws {
        guard configuration.permits(.post), configuration.isApprovedTestAccount(identity) else {
            throw AuthError.notPermittedInThisBuild
        }
    }
}

/// MOCK authentication: the same flow and the same error shapes as the API, with no network.
///
/// - Email: `demo.customer@example.com` with password `Tickets-Demo-2026` signs in. Any other
///   password gets the API's INVALID_CREDENTIALS response.
/// - Sign-up: succeeds for any new address. The demo address gets a field error, as a duplicate
///   would. Passwords under 10 characters get the API's VALIDATION_FAILED shape.
/// - Phone: any number gets a code; the code is always 123456.
struct MockAuthService: AuthService {
    static let demoEmail = "demo.customer@example.com"
    static let demoPassword = "Tickets-Demo-2026"
    static let demoOTP = "123456"

    let session: AuthSession
    var fixtures = FixtureStore()
    var latency: Duration = .milliseconds(400)

    func restore() async -> AuthenticatedUser? {
        await session.current?.user
    }

    func login(email: String, password: String) async throws -> AuthenticatedUser {
        try await pause()
        let email = Self.normalisedEmail(email)
        guard email == Self.demoEmail, password == Self.demoPassword else {
            throw APIError.server(status: 401, code: "INVALID_CREDENTIALS", message: "Incorrect email or password.")
        }
        return try await begin(identity: email, user: fixtures.load("me"))
    }

    func register(_ form: RegistrationForm) async throws -> AuthenticatedUser {
        try await pause()
        let email = Self.normalisedEmail(form.email)
        var fields: [String: [String]] = [:]
        if email == Self.demoEmail { fields["email"] = ["An account already exists with this email."] }
        if form.password.count < 10 { fields["password"] = ["Use at least 10 characters."] }
        guard fields.isEmpty else {
            throw APIError.server(status: 400, code: "VALIDATION_FAILED", message: "The request failed validation.", fields: fields)
        }
        let user = AuthenticatedUser(
            id: "usr-\(UUID().uuidString.prefix(8))", email: email,
            fullName: form.fullName.trimmingCharacters(in: .whitespaces), roles: ["CUSTOMER"], organizationId: nil)
        return try await begin(identity: email, user: user)
    }

    func requestPhoneCode(phone: String) async throws {
        try await pause()
    }

    func verifyPhoneCode(phone: String, code: String, fullName: String?) async throws -> AuthenticatedUser {
        try await pause()
        guard code == Self.demoOTP else {
            throw APIError.server(status: 400, code: "INVALID_CODE", message: "That code isn't right. Check it and try again.")
        }
        let user = AuthenticatedUser(
            id: "usr-phone", email: "phone@phone.eticketsgo.invalid",
            fullName: fullName ?? "Mobile Customer", roles: ["CUSTOMER"], organizationId: nil)
        return try await begin(identity: phone, user: user)
    }

    func logout() async {
        await session.end()
    }

    private func begin(identity: String, user: AuthenticatedUser) async throws -> AuthenticatedUser {
        let tokens = TokenPair(accessToken: "mock-access-\(UUID().uuidString)", refreshToken: "mock-refresh-\(UUID().uuidString)")
        try await session.begin(tokens: tokens, identity: identity, user: user)
        return user
    }

    private func pause() async throws {
        if latency > .zero { try await Task.sleep(for: latency) }
    }
}
