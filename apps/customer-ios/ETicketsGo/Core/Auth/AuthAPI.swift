import Foundation

// Request and response bodies for apps/api/src/auth/auth.controller.ts. Keys and rules follow
// packages/validation/src/auth.ts (loginSchema, registerSchema, refreshSchema) and the
// controller's phone schemas. Password strength is the server's to judge (password-policy.ts);
// the app checks only what it must to send a well-formed request.

struct LoginBody: Encodable, Sendable {
    let email: String
    let password: String
}

struct RegisterBody: Encodable, Sendable {
    let email: String
    let password: String
    let fullName: String
    let phone: String?
    /// Consent to be texted about one's own bookings. Never inferred from `phone`.
    let smsConsent: Bool?
    let country: String?
}

struct RefreshBody: Encodable, Sendable {
    let refreshToken: String
}

struct PhoneCodeRequestBody: Encodable, Sendable {
    let phone: String
}

struct PhoneVerifyBody: Encodable, Sendable {
    let phone: String
    let code: String
    /// Sign-up only; applied to an account that has no name yet.
    let fullName: String?
}

/// POST /auth/login and /auth/register answer with a token pair. A back-office account that
/// must pass MFA gets `{ mfaRequired, challengeToken, methods }` instead (shared-types api.ts);
/// the customer app does not complete MFA and sends those accounts to the web console.
enum LoginResult: Decodable, Sendable, Equatable {
    case tokens(TokenPair)
    case mfaRequired

    private enum Keys: String, CodingKey { case mfaRequired }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if (try? container.decode(Bool.self, forKey: .mfaRequired)) == true {
            self = .mfaRequired
        } else {
            self = .tokens(try TokenPair(from: decoder))
        }
    }
}

/// POST /auth/phone/verify: the token pair plus whether the number created a new account.
struct PhoneVerifyResult: Decodable, Sendable {
    let accessToken: String
    let refreshToken: String
    let isNewAccount: Bool?

    var tokens: TokenPair { TokenPair(accessToken: accessToken, refreshToken: refreshToken) }
}

enum AuthAPI {
    static func login(_ body: LoginBody) -> Endpoint<LoginResult> {
        Endpoint(method: .post, path: "/auth/login", body: encode(body), isAuthFlow: true)
    }

    static func register(_ body: RegisterBody) -> Endpoint<LoginResult> {
        Endpoint(method: .post, path: "/auth/register", body: encode(body), isAuthFlow: true)
    }

    static func refresh(_ refreshToken: String) -> Endpoint<TokenPair> {
        Endpoint(method: .post, path: "/auth/refresh", body: encode(RefreshBody(refreshToken: refreshToken)), isAuthFlow: true)
    }

    static func logout(_ refreshToken: String) -> Endpoint<IgnoredResponse> {
        Endpoint(method: .post, path: "/auth/logout", body: encode(RefreshBody(refreshToken: refreshToken)), isAuthFlow: true)
    }

    static func requestPhoneCode(_ phone: String) -> Endpoint<IgnoredResponse> {
        Endpoint(method: .post, path: "/auth/phone/request-code", body: encode(PhoneCodeRequestBody(phone: phone)), isAuthFlow: true)
    }

    static func verifyPhoneCode(_ body: PhoneVerifyBody) -> Endpoint<PhoneVerifyResult> {
        Endpoint(method: .post, path: "/auth/phone/verify", body: encode(body), isAuthFlow: true)
    }

    private static func encode<T: Encodable>(_ value: T) -> Data? {
        try? JSONEncoder.etg.encode(value)
    }
}
