import Foundation

enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"

    var isSafe: Bool { self == .get }
}

/// One API call: where it goes and what it decodes to. Built by `CustomerAPI` / `AuthAPI`.
struct Endpoint<Response: Decodable & Sendable>: Sendable {
    var method: HTTPMethod = .get
    var path: String
    var query: [URLQueryItem] = []
    var body: Data?
    var requiresAuth = false
    /// Sign-in, sign-up, OTP, refresh and logout. Never sends a bearer token and never
    /// triggers a refresh; its own 401s (wrong password, expired refresh) surface as server
    /// errors with the server's message. QA approval for these is checked by the auth service,
    /// which knows the identity being used.
    var isAuthFlow = false
}

/// The API's error body, produced by the global AllExceptionsFilter
/// (apps/api/src/common/all-exceptions.filter.ts; `ApiError` in packages/shared-types).
/// Validation failures carry `details.fields`: field name → messages (common/zod-validation.pipe.ts).
struct ServerErrorBody: Decodable, Sendable {
    struct Details: Decodable, Sendable {
        let fields: [String: [String]]?
    }

    let code: String?
    let message: String?
    let correlationId: String?
    let details: Details?
}

/// Accepts any JSON body. For endpoints whose response the app does not use.
struct IgnoredResponse: Decodable, Sendable {
    init(from decoder: Decoder) throws {}
}

enum APIError: Error, Equatable, Sendable {
    case notConfigured
    case mutationBlocked(AppEnvironment)
    case unauthorized
    case server(status: Int, code: String?, message: String?, fields: [String: [String]] = [:])
    case decoding(String)
    case transport(URLError.Code)
    case invalidResponse

    /// Safe to show a customer. The server's own message is shown as-is, as the Expo app does.
    var userMessage: String {
        switch self {
        case .notConfigured: return "This build has no server configured."
        case .mutationBlocked: return "This action is disabled in this build."
        case .unauthorized: return "Please sign in to continue."
        case let .server(status, _, message, _):
            if status == 429 { return message ?? "Too many attempts. Please wait a minute and try again." }
            return message ?? "Something went wrong. Please try again."
        case .transport(.notConnectedToInternet): return "You're offline. Check your connection."
        case .transport, .invalidResponse, .decoding:
            return "We couldn't reach ETicketsGo. Please try again."
        }
    }
}

protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, URLResponse)
}

struct URLSessionTransport: HTTPTransport {
    var session: URLSession = .shared

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}

/// Supplies and renews the bearer token. `AuthSession` is the real one.
protocol AccessTokenProviding: Sendable {
    func accessToken() async -> String?
    /// Called once when a request made with `rejected` came back 401. Returns true when a
    /// fresh token is available and the request should be retried.
    func refreshAfterUnauthorized(rejected: String) async -> Bool
    /// QA: whether the signed-in identity is an approved test account.
    func mayWriteInQA() async -> Bool
}

struct NoAccessToken: AccessTokenProviding {
    func accessToken() async -> String? { nil }
    func refreshAfterUnauthorized(rejected: String) async -> Bool { false }
    func mayWriteInQA() async -> Bool { false }
}

final class APIClient: Sendable {
    let configuration: AppConfiguration
    private let transport: any HTTPTransport
    private let tokens: any AccessTokenProviding

    init(
        configuration: AppConfiguration,
        transport: any HTTPTransport = URLSessionTransport(),
        tokens: any AccessTokenProviding = NoAccessToken()
    ) {
        self.configuration = configuration
        self.transport = transport
        self.tokens = tokens
    }

    func send<Response>(_ endpoint: Endpoint<Response>) async throws -> Response {
        let request = try await makeRequest(endpoint)
        let (data, http) = try await perform(request)

        // One refresh-and-retry for an expired access token, as the Expo client does. Many
        // requests failing together share one refresh (AuthSession is single-flight).
        if http.statusCode == 401, endpoint.requiresAuth, !endpoint.isAuthFlow,
           let used = Self.bearer(in: request) {
            guard await tokens.refreshAfterUnauthorized(rejected: used) else { throw APIError.unauthorized }
            let retry = try await makeRequest(endpoint)
            let (retryData, retryHTTP) = try await perform(retry)
            return try decode(endpoint, data: retryData, http: retryHTTP)
        }
        return try decode(endpoint, data: data, http: http)
    }

    func makeRequest<Response>(_ endpoint: Endpoint<Response>) async throws -> URLRequest {
        if !endpoint.method.isSafe {
            guard configuration.permits(endpoint.method) else {
                throw APIError.mutationBlocked(configuration.environment)
            }
            if configuration.environment == .qa, !endpoint.isAuthFlow, !(await tokens.mayWriteInQA()) {
                throw APIError.mutationBlocked(.qa)
            }
        }
        guard let base = configuration.apiBaseURL,
              var components = URLComponents(string: base.absoluteString + endpoint.path)
        else { throw APIError.notConfigured }
        if !endpoint.query.isEmpty { components.queryItems = endpoint.query }
        guard let url = components.url else { throw APIError.notConfigured }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Echoed by the API's correlation-id middleware; ties a support report to server logs.
        request.setValue(UUID().uuidString, forHTTPHeaderField: "x-correlation-id")
        if let body = endpoint.body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if endpoint.requiresAuth, !endpoint.isAuthFlow {
            guard let token = await tokens.accessToken() else { throw APIError.unauthorized }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await transport.send(request)
            guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
            return (data, http)
        } catch let error as URLError {
            throw APIError.transport(error.code)
        }
    }

    private func decode<Response>(_ endpoint: Endpoint<Response>, data: Data, http: HTTPURLResponse) throws -> Response {
        switch http.statusCode {
        case 200..<300:
            do {
                return try JSONDecoder.etg.decode(Response.self, from: data)
            } catch {
                throw APIError.decoding(String(describing: error))
            }
        case 401 where !endpoint.isAuthFlow:
            throw APIError.unauthorized
        default:
            let body = try? JSONDecoder.etg.decode(ServerErrorBody.self, from: data)
            throw APIError.server(
                status: http.statusCode, code: body?.code, message: body?.message,
                fields: body?.details?.fields ?? [:])
        }
    }

    private static func bearer(in request: URLRequest) -> String? {
        guard let header = request.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Bearer ")
        else { return nil }
        return String(header.dropFirst("Bearer ".count))
    }
}

extension JSONDecoder {
    /// The API sends ISO-8601 dates, with or without fractional seconds.
    static var etg: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = ISO8601.withFraction.date(from: string) ?? ISO8601.plain.date(from: string) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Not an ISO-8601 date: \(string)")
        }
        return decoder
    }
}

extension JSONEncoder {
    /// Request bodies. Keys are the API's own (camelCase); nil optionals are omitted.
    static var etg: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

private enum ISO8601 {
    nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    nonisolated(unsafe) static let plain = ISO8601DateFormatter()
}
