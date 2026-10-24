import Foundation

enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"

    var isSafe: Bool { self == .get }
}

/// One API call: where it goes and what it decodes to. Built by `CustomerAPI`.
struct Endpoint<Response: Decodable & Sendable>: Sendable {
    var method: HTTPMethod = .get
    var path: String
    var query: [URLQueryItem] = []
    var body: Data?
    var requiresAuth = false
}

/// The API's error body, produced by the global AllExceptionsFilter
/// (apps/api/src/common/all-exceptions.filter.ts; `ApiError` in packages/shared-types).
struct ServerErrorBody: Decodable, Sendable {
    let code: String?
    let message: String?
    let correlationId: String?
}

enum APIError: Error, Equatable, Sendable {
    case notConfigured
    case mutationBlocked(AppEnvironment)
    case unauthorized
    case server(status: Int, code: String?, message: String?)
    case decoding(String)
    case transport(URLError.Code)
    case invalidResponse

    /// Safe to show a customer. The server's own message is shown as-is, as the Expo app does.
    var userMessage: String {
        switch self {
        case .notConfigured: return "This build has no server configured."
        case .mutationBlocked: return "This action is disabled in this build."
        case .unauthorized: return "Please sign in to continue."
        case let .server(_, _, message): return message ?? "Something went wrong. Please try again."
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

/// Supplies the bearer token. Phase 1 has no sign-in, so the default has none; Phase 2
/// backs this with the Keychain and the /auth/refresh rotation.
protocol AccessTokenProviding: Sendable {
    func accessToken() async -> String?
}

struct NoAccessToken: AccessTokenProviding {
    func accessToken() async -> String? { nil }
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

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch let error as URLError {
            throw APIError.transport(error.code)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }

        switch http.statusCode {
        case 200..<300:
            do {
                return try JSONDecoder.etg.decode(Response.self, from: data)
            } catch {
                throw APIError.decoding(String(describing: error))
            }
        case 401:
            throw APIError.unauthorized
        default:
            let body = try? JSONDecoder.etg.decode(ServerErrorBody.self, from: data)
            throw APIError.server(status: http.statusCode, code: body?.code, message: body?.message)
        }
    }

    func makeRequest<Response>(_ endpoint: Endpoint<Response>) async throws -> URLRequest {
        guard configuration.permits(endpoint.method) else {
            throw APIError.mutationBlocked(configuration.environment)
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
        if endpoint.requiresAuth {
            guard let token = await tokens.accessToken() else { throw APIError.unauthorized }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
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

private enum ISO8601 {
    nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    nonisolated(unsafe) static let plain = ISO8601DateFormatter()
}
