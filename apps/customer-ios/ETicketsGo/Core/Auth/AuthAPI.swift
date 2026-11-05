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

/// GET /users/me: the fields a customer edits (users.service.ts `profile`). `email` is nil for a
/// phone-only account.
struct UserProfile: Decodable, Equatable, Sendable {
    let fullName: String
    let email: String?
    let countryOfResidence: String?
}

/// PATCH /users/me (users.controller.ts `updateProfileSchema`). Both fields are always sent;
/// a cleared country goes as an explicit `null`, which is how the server clears it.
struct UpdateProfileBody: Encodable, Sendable {
    let fullName: String
    let countryOfResidence: String?

    private enum Keys: String, CodingKey { case fullName, countryOfResidence }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(fullName, forKey: .fullName)
        if let countryOfResidence {
            try container.encode(countryOfResidence, forKey: .countryOfResidence)
        } else {
            try container.encodeNil(forKey: .countryOfResidence)
        }
    }
}

/// Where a customer may say they live: the platform's markets (packages/shared-types markets.ts,
/// `RESIDENCE_COUNTRIES`). Optional and never inferred. The server validates the code.
enum ResidenceCountry {
    static let all: [(code: String, name: String)] = [
        ("IN", "India"), ("US", "United States"), ("CA", "Canada"), ("GB", "United Kingdom"),
        ("AE", "United Arab Emirates"), ("SG", "Singapore"), ("AU", "Australia"), ("NZ", "New Zealand"),
    ]
}

/// DELETE /users/me (apps/api/src/users/users.controller.ts `deleteAccountSchema`).
struct DeleteAccountBody: Encodable, Sendable {
    let reason: String?
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

    static func profile() -> Endpoint<UserProfile> {
        Endpoint(path: "/users/me", requiresAuth: true)
    }

    static func updateProfile(_ body: UpdateProfileBody) -> Endpoint<UserProfile> {
        Endpoint(method: .patch, path: "/users/me", body: encode(body), requiresAuth: true)
    }

    /// Irreversible. Idempotent on the server; the session is revoked with the account.
    static func deleteAccount(reason: String? = nil) -> Endpoint<IgnoredResponse> {
        Endpoint(method: .delete, path: "/users/me", body: encode(DeleteAccountBody(reason: reason)), requiresAuth: true)
    }

    private static func encode<T: Encodable>(_ value: T) -> Data? {
        try? JSONEncoder.etg.encode(value)
    }
}
