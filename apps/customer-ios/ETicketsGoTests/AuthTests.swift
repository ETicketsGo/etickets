import Foundation
import Security
import Testing
@testable import ETicketsGo

/// Answers each request from a handler and records what was sent. No network.
final class RoutingTransport: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (status: Int, json: String)
    private let lock = NSLock()
    private var log: [URLRequest] = []
    private let handler: Handler
    private let delay: Duration

    init(delay: Duration = .zero, handler: @escaping Handler) {
        self.handler = handler
        self.delay = delay
    }

    var requests: [URLRequest] { lock.withLock { log } }
    func count(path: String) -> Int { requests.filter { $0.url?.path().hasSuffix(path) == true }.count }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock { log.append(request) }
        if delay > .zero { try await Task.sleep(for: delay) }
        let (status, json) = handler(request)
        return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

/// Counts refresh calls across concurrent callers.
actor Counter {
    private(set) var value = 0
    func increment() -> Int { value += 1; return value }
}

private let qaURL = URL(string: "https://api-qa.eticketsgo.com/api")!
private let meJSON = #"{"id":"u1","email":"tester@qa.eticketsgo.test","fullName":"QA Tester","roles":["CUSTOMER"],"organizationId":null,"lastBuyerRegion":null,"permissions":[]}"#
private let pairJSON = #"{"accessToken":"access-1","refreshToken":"refresh-1"}"#

private func qaConfig(accounts: [String] = ["tester@qa.eticketsgo.test", "t@qa.eticketsgo.test", "+15550100"]) -> AppConfiguration {
    AppConfiguration(environment: .qa, apiBaseURL: qaURL, allowsMutations: true, qaTestAccounts: accounts)
}

private func body(_ request: URLRequest) -> [String: Any] {
    (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
}

private func remote(
    _ config: AppConfiguration, store: any TokenStore = InMemoryTokenStore(), transport: RoutingTransport,
    refresher: AuthSession.Refresher? = nil
) -> (RemoteAuthService, AuthSession, APIClient) {
    let publicClient = APIClient(configuration: config, transport: transport)
    let session = AuthSession(store: store, configuration: config, refresher: refresher ?? { token in
        try await publicClient.send(AuthAPI.refresh(token))
    })
    let client = APIClient(configuration: config, transport: transport, tokens: session)
    return (RemoteAuthService(publicClient: publicClient, client: client, session: session, configuration: config), session, client)
}

// MARK: - Contract

@Suite("Auth contract (apps/api/src/auth/auth.controller.ts, packages/validation/src/auth.ts)")
struct AuthContractTests {
    @Test("Login posts exactly {email, password}: email normalised, no bearer, nothing in the URL")
    func loginRequest() async throws {
        let transport = RoutingTransport { req in req.url!.path().hasSuffix("/auth/me") ? (200, meJSON) : (201, pairJSON) }
        let (service, _, _) = remote(qaConfig(), transport: transport)
        _ = try await service.login(email: "  Tester@QA.eticketsgo.test ", password: "s3cret-Pass!")

        let login = try #require(transport.requests.first)
        #expect(login.httpMethod == "POST")
        #expect(login.url?.absoluteString == "https://api-qa.eticketsgo.com/api/auth/login")
        #expect(login.value(forHTTPHeaderField: "Authorization") == nil)
        let sent = body(login)
        #expect(Set(sent.keys) == ["email", "password"])
        #expect(sent["email"] as? String == "tester@qa.eticketsgo.test")
        #expect(login.url?.query == nil)

        let me = try #require(transport.requests.last)
        #expect(me.url?.path() == "/api/auth/me")
        #expect(me.value(forHTTPHeaderField: "Authorization") == "Bearer access-1")
    }

    @Test("Register omits unset optionals; phone verify and request-code send the controller's keys")
    func otherBodies() throws {
        let register = AuthAPI.register(RegisterBody(email: "a@b.co", password: "p", fullName: "A B", phone: nil, smsConsent: nil, country: nil))
        let registerKeys = Set((try JSONSerialization.jsonObject(with: register.body!) as! [String: Any]).keys)
        #expect(registerKeys == ["email", "password", "fullName"])

        let verify = AuthAPI.verifyPhoneCode(PhoneVerifyBody(phone: "+919000000001", code: "123456", fullName: nil))
        let verifyBody = try JSONSerialization.jsonObject(with: verify.body!) as! [String: Any]
        #expect(Set(verifyBody.keys) == ["phone", "code"])
        #expect(verify.path == "/auth/phone/verify" && verify.isAuthFlow)

        let request = AuthAPI.requestPhoneCode("+919000000001")
        #expect(Set((try JSONSerialization.jsonObject(with: request.body!) as! [String: Any]).keys) == ["phone"])

        for endpoint in [AuthAPI.logout("r").body, AuthAPI.refresh("r").body] {
            #expect((try JSONSerialization.jsonObject(with: endpoint!) as! [String: String]) == ["refreshToken": "r"])
        }
    }

    @Test("Decodes a token pair, the back-office MFA answer, phone verify and an enriched /auth/me")
    func decodesResponses() throws {
        #expect(try JSONDecoder.etg.decode(LoginResult.self, from: Data(pairJSON.utf8))
                == .tokens(TokenPair(accessToken: "access-1", refreshToken: "refresh-1")))
        let mfa = #"{"mfaRequired":true,"challengeToken":"c","methods":["totp"]}"#
        #expect(try JSONDecoder.etg.decode(LoginResult.self, from: Data(mfa.utf8)) == .mfaRequired)
        let phone = #"{"accessToken":"a","refreshToken":"r","isNewAccount":true}"#
        #expect(try JSONDecoder.etg.decode(PhoneVerifyResult.self, from: Data(phone.utf8)).isNewAccount == true)
        #expect(try JSONDecoder.etg.decode(AuthenticatedUser.self, from: Data(meJSON.utf8)).fullName == "QA Tester")
    }

    @Test("A wrong password surfaces the server's message, not a generic sign-in prompt")
    func invalidCredentials() async {
        let transport = RoutingTransport { _ in
            (401, #"{"code":"INVALID_CREDENTIALS","message":"Incorrect email or password.","correlationId":"x"}"#)
        }
        let (service, session, _) = remote(qaConfig(), transport: transport)
        await #expect(throws: APIError.server(status: 401, code: "INVALID_CREDENTIALS", message: "Incorrect email or password.")) {
            _ = try await service.login(email: "tester@qa.eticketsgo.test", password: "wrong")
        }
        #expect(await session.current == nil)
    }

    @Test("Validation failures map to per-field messages")
    func validationFields() async {
        let json = #"{"code":"VALIDATION_FAILED","message":"The request failed validation.","details":{"fields":{"password":["Use at least 10 characters."]}}}"#
        let transport = RoutingTransport { _ in (400, json) }
        let (service, _, _) = remote(qaConfig(), transport: transport)
        await #expect(throws: APIError.server(status: 400, code: "VALIDATION_FAILED", message: "The request failed validation.",
                                              fields: ["password": ["Use at least 10 characters."]])) {
            _ = try await service.register(RegistrationForm(fullName: "QA Tester", email: "t@qa.eticketsgo.test", password: "short"))
        }
    }

    @Test("A back-office MFA answer is refused and leaves no session")
    func mfaRefused() async {
        let transport = RoutingTransport { _ in (201, #"{"mfaRequired":true,"challengeToken":"c","methods":["totp"]}"#) }
        let (service, session, _) = remote(qaConfig(), transport: transport)
        await #expect(throws: AuthError.mfaRequired) { _ = try await service.login(email: "t@qa.eticketsgo.test", password: "p") }
        #expect(await session.current == nil)
    }
}

// MARK: - Security

@Suite("Auth security", .serialized)
struct AuthSecurityTests {
    @Test("Keychain item: this-device-only after first unlock, not synchronised, removed on clear")
    func keychainAttributes() throws {
        let store = KeychainTokenStore(service: "com.eticketsgo.tests.\(UUID().uuidString)")
        defer { store.clear() }
        let session = StoredSession(tokens: TokenPair(accessToken: "a", refreshToken: "r"), identity: "x@y.z", user: nil)
        try store.save(session)
        #expect(store.read() == session)

        let attributes = try #require(store.attributes())
        #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        let sync = attributes[kSecAttrSynchronizable as String]
        #expect(sync == nil || (sync as? NSNumber)?.boolValue == false)

        // Overwrite keeps one item.
        try store.save(StoredSession(tokens: TokenPair(accessToken: "b", refreshToken: "s"), identity: "x@y.z", user: nil))
        #expect(store.read()?.tokens.accessToken == "b")

        store.clear()
        #expect(store.read() == nil)
        #expect(store.attributes() == nil)
    }

    @Test("First launch of an install clears a session the Keychain kept from before; later launches keep it")
    func freshInstallClearsKeychain() throws {
        let defaults = try #require(UserDefaults(suiteName: "etg.tests.\(UUID().uuidString)"))
        let store = InMemoryTokenStore(StoredSession(tokens: TokenPair(accessToken: "a", refreshToken: "r"), identity: "x", user: nil))
        FreshInstallGuard.clearSessionIfNewInstall(store, defaults: defaults)
        #expect(store.read() == nil)

        try store.save(StoredSession(tokens: TokenPair(accessToken: "b", refreshToken: "s"), identity: "x", user: nil))
        FreshInstallGuard.clearSessionIfNewInstall(store, defaults: defaults)
        #expect(store.read() != nil)
    }

    @Test("Tokens never appear in descriptions or UserDefaults")
    func noLeaks() async throws {
        let pair = TokenPair(accessToken: "secret-access-123", refreshToken: "secret-refresh-456")
        #expect(!String(describing: pair).contains("secret"))
        #expect(!String(reflecting: pair).contains("secret"))
        let stored = StoredSession(tokens: pair, identity: "tester@qa.eticketsgo.test", user: nil)
        #expect(!String(describing: stored).contains("secret") && !String(describing: stored).contains("tester"))

        let container = await AppContainer.mock(latency: .zero)
        try await container.auth.login(email: MockAuthService.demoEmail, password: MockAuthService.demoPassword)
        let defaults = UserDefaults.standard.dictionaryRepresentation().values.map { "\($0)" }.joined()
        #expect(!defaults.contains("mock-access-") && !defaults.contains("mock-refresh-"))
    }

    @Test("Concurrent 401s share one refresh; every request retries with the new token")
    func singleFlightRefresh() async throws {
        let calls = Counter()
        let store = InMemoryTokenStore(StoredSession(
            tokens: TokenPair(accessToken: "old", refreshToken: "refresh-old"), identity: "t@qa.eticketsgo.test", user: nil))
        let transport = RoutingTransport(delay: .milliseconds(20)) { req in
            req.value(forHTTPHeaderField: "Authorization") == "Bearer new" ? (200, "[]") : (401, #"{"code":"UNAUTHORIZED"}"#)
        }
        let session = AuthSession(store: store, configuration: qaConfig()) { refreshToken in
            #expect(refreshToken == "refresh-old")
            _ = await calls.increment()
            try await Task.sleep(for: .milliseconds(50))
            return TokenPair(accessToken: "new", refreshToken: "refresh-new")
        }
        let client = APIClient(configuration: qaConfig(), transport: transport, tokens: session)

        try await withThrowingTaskGroup(of: [Ticket].self) { group in
            for _ in 0..<5 { group.addTask { try await client.send(CustomerAPI.tickets()) } }
            for try await result in group { #expect(result.isEmpty) }
        }
        #expect(await calls.value == 1)
        #expect(store.read()?.tokens == TokenPair(accessToken: "new", refreshToken: "refresh-new"))
    }

    @Test("A rejected refresh clears the session and reports it expired")
    func rejectedRefreshSignsOut() async throws {
        let store = InMemoryTokenStore(StoredSession(
            tokens: TokenPair(accessToken: "old", refreshToken: "revoked"), identity: "t@qa.eticketsgo.test", user: nil))
        let transport = RoutingTransport { req in
            req.url!.path().hasSuffix("/auth/refresh")
                ? (401, #"{"code":"INVALID_REFRESH_TOKEN","message":"Your session has expired. Please sign in again."}"#)
                : (401, "{}")
        }
        let (_, session, client) = remote(qaConfig(), store: store, transport: transport)
        var events = session.events.makeAsyncIterator()

        await #expect(throws: APIError.unauthorized) { _ = try await client.send(CustomerAPI.tickets()) }
        #expect(store.read() == nil)
        #expect(await events.next() == .expired)
        #expect(transport.count(path: "/auth/refresh") == 1)
        // The refresh call itself carried no bearer token.
        let refresh = try #require(transport.requests.first { $0.url!.path().hasSuffix("/auth/refresh") })
        #expect(refresh.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("A refresh that fails on the network keeps the session")
    func offlineRefreshKeepsSession() async {
        let original = StoredSession(tokens: TokenPair(accessToken: "old", refreshToken: "r"), identity: "t@qa.eticketsgo.test", user: nil)
        let store = InMemoryTokenStore(original)
        let transport = RoutingTransport { _ in (401, "{}") }
        let session = AuthSession(store: store, configuration: qaConfig()) { _ in throw APIError.transport(.notConnectedToInternet) }
        let client = APIClient(configuration: qaConfig(), transport: transport, tokens: session)
        await #expect(throws: APIError.unauthorized) { _ = try await client.send(CustomerAPI.tickets()) }
        #expect(store.read() == original)
    }

    @Test("Logout revokes the refresh token and ends the local session even when the server is unreachable")
    func logout() async throws {
        let store = InMemoryTokenStore(StoredSession(
            tokens: TokenPair(accessToken: "a", refreshToken: "refresh-to-revoke"), identity: "t@qa.eticketsgo.test", user: nil))
        let transport = RoutingTransport { _ in (503, "{}") }
        let (service, _, _) = remote(qaConfig(), store: store, transport: transport)
        await service.logout()
        #expect(store.read() == nil)
        let request = try #require(transport.requests.first)
        #expect(request.url?.path() == "/api/auth/logout")
        #expect(body(request)["refreshToken"] as? String == "refresh-to-revoke")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("QA: an identity off the allowlist is refused before anything is sent")
    func qaUnapprovedBlocked() async {
        let transport = RoutingTransport { _ in (201, pairJSON) }
        let (service, _, _) = remote(qaConfig(), transport: transport)
        await #expect(throws: AuthError.notPermittedInThisBuild) { _ = try await service.login(email: "real.customer@gmail.com", password: "p") }
        await #expect(throws: AuthError.notPermittedInThisBuild) { try await service.requestPhoneCode(phone: "+15550199") }
        await #expect(throws: AuthError.notPermittedInThisBuild) {
            _ = try await service.register(RegistrationForm(fullName: "X Y", email: "x@gmail.com", password: "long-enough-1"))
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("PROD: sign-in and sign-up are refused before anything is sent")
    func prodBlocked() async {
        let prod = AppConfiguration(environment: .prod, apiBaseURL: URL(string: "https://api.eticketsgo.com/api")!, allowsMutations: true,
                                    qaTestAccounts: ["t@qa.eticketsgo.test"])
        let transport = RoutingTransport { _ in (201, pairJSON) }
        let (service, _, _) = remote(prod, transport: transport)
        await #expect(throws: AuthError.notPermittedInThisBuild) { _ = try await service.login(email: "t@qa.eticketsgo.test", password: "p") }
        await #expect(throws: AuthError.notPermittedInThisBuild) { try await service.requestPhoneCode(phone: "+15550100") }
        #expect(transport.requests.isEmpty)
    }

    @Test("QA: non-auth writes need a signed-in approved test account")
    func qaWritesNeedApprovedSession() async throws {
        let write = Endpoint<IgnoredResponse>(method: .post, path: "/bookings/quote")
        let transport = RoutingTransport { _ in (200, "{}") }

        let unapproved = AuthSession(store: InMemoryTokenStore(StoredSession(
            tokens: TokenPair(accessToken: "a", refreshToken: "r"), identity: "someone@gmail.com", user: nil)),
            configuration: qaConfig()) { _ in throw APIError.unauthorized }
        let blocked = APIClient(configuration: qaConfig(), transport: transport, tokens: unapproved)
        await #expect(throws: APIError.mutationBlocked(.qa)) { _ = try await blocked.send(write) }
        await #expect(throws: APIError.mutationBlocked(.qa)) { _ = try await APIClient(configuration: qaConfig(), transport: transport).send(write) }
        #expect(transport.requests.isEmpty)

        let approved = AuthSession(store: InMemoryTokenStore(StoredSession(
            tokens: TokenPair(accessToken: "a", refreshToken: "r"), identity: "tester@qa.eticketsgo.test", user: nil)),
            configuration: qaConfig()) { _ in throw APIError.unauthorized }
        _ = try await APIClient(configuration: qaConfig(), transport: transport, tokens: approved).send(write)
        #expect(transport.requests.count == 1)
    }
}

// MARK: - Mock adapter and store

@Suite("Mock auth adapter and AuthStore")
@MainActor
struct MockAuthTests {
    @Test("Mock sign-in, wrong password, tickets gated on the session, sign-out")
    func mockFlow() async throws {
        let container = AppContainer.mock(latency: .zero)
        await container.auth.start()
        #expect(container.auth.state == .signedOut)
        await #expect(throws: APIError.unauthorized) { _ = try await container.tickets.tickets() }

        await #expect(throws: APIError.server(status: 401, code: "INVALID_CREDENTIALS", message: "Incorrect email or password.")) {
            try await container.auth.login(email: MockAuthService.demoEmail, password: "nope")
        }
        try await container.auth.login(email: "Demo.Customer@example.com ", password: MockAuthService.demoPassword)
        #expect(container.auth.user?.fullName == "Demo Customer")
        #expect(try await container.tickets.tickets().count == 4)

        await container.auth.logout()
        #expect(container.auth.state == .signedOut)
        await #expect(throws: APIError.unauthorized) { _ = try await container.tickets.tickets() }
    }

    @Test("Mock OTP: code 123456 signs in; anything else is refused")
    func mockOTP() async throws {
        let container = AppContainer.mock(latency: .zero)
        try await container.auth.requestPhoneCode(phone: "+919000000001")
        await #expect(throws: (any Error).self) { try await container.auth.verifyPhoneCode(phone: "+919000000001", code: "000000", fullName: nil) }
        try await container.auth.verifyPhoneCode(phone: "+919000000001", code: MockAuthService.demoOTP, fullName: "Asha")
        #expect(container.auth.user?.fullName == "Asha")
    }

    @Test("A session restored from storage is signed in at launch")
    func restore() async throws {
        let user = try FixtureStore().load("me", as: AuthenticatedUser.self)
        let store = InMemoryTokenStore(StoredSession(tokens: TokenPair(accessToken: "a", refreshToken: "r"), identity: user.email, user: user))
        let container = AppContainer.mock(store: store, latency: .zero)
        await container.auth.start()
        #expect(container.auth.state == .signedIn(user))
    }

    @Test("The session key changes from restoring to signed out, so screens reload")
    func sessionKey() async {
        let container = AppContainer.mock(latency: .zero)
        #expect(container.auth.sessionKey == "restoring")
        await container.auth.start()
        #expect(container.auth.sessionKey == "signed-out")
    }

    @Test("Sign-in form: well-formedness only; the server judges the rest")
    func formRules() {
        #expect(SignInViewModel.looksLikeEmail("a@b.co"))
        #expect(!SignInViewModel.looksLikeEmail("a@b"))
        #expect(SignInViewModel.looksLikePhone("+91 90000 00001"))
        #expect(!SignInViewModel.looksLikePhone("9000000001"))  // national number: country code required
    }
}
