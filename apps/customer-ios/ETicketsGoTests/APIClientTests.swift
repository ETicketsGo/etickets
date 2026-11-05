import Foundation
import Testing
@testable import ETicketsGo

/// Records requests and replies with a canned response. No network.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    let status: Int
    let body: Data

    init(status: Int = 200, json: String = "{}") {
        self.status = status
        self.body = Data(json.utf8)
    }

    var requests: [URLRequest] { lock.withLock { _requests } }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock { _requests.append(request) }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (body, response)
    }
}

struct FixedToken: AccessTokenProviding {
    func accessToken() async -> String? { "test-token" }
    func refreshAfterUnauthorized(rejected: String) async -> Bool { false }
    func mayWriteInQA() async -> Bool { false }
}

@Suite("APIClient")
struct APIClientTests {
    let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!, allowsMutations: true)
    let prod = AppConfiguration(environment: .prod, apiBaseURL: URL(string: "https://api.eticketsgo.com/api")!, allowsMutations: true)

    @Test("Builds the URL under the /api prefix, with query items and headers")
    func buildsRequest() async throws {
        let client = APIClient(configuration: qa, transport: StubTransport())
        let request = try await client.makeRequest(CustomerAPI.events(EventQuery(text: "jazz", category: "live-music")))
        let url = try #require(request.url)
        #expect(url.path() == "/api/public/events")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items.contains(URLQueryItem(name: "q", value: "jazz")))
        #expect(items.contains(URLQueryItem(name: "category", value: "live-music")))
        #expect(items.contains(URLQueryItem(name: "pageSize", value: "20")))
        #expect(request.value(forHTTPHeaderField: "x-correlation-id") != nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("A write against PROD is refused before anything is sent")
    func blocksProdMutation() async {
        let transport = StubTransport()
        let client = APIClient(configuration: prod, transport: transport)
        let write = Endpoint<ServerErrorBody>(method: .post, path: "/bookings")
        await #expect(throws: APIError.mutationBlocked(.prod)) { try await client.send(write) }
        #expect(transport.requests.isEmpty)
    }

    @Test("Authenticated endpoints need a token and send it as a bearer")
    func bearerAuth() async throws {
        let anonymous = APIClient(configuration: qa, transport: StubTransport())
        await #expect(throws: APIError.unauthorized) { try await anonymous.makeRequest(CustomerAPI.tickets()) }

        let signedIn = APIClient(configuration: qa, transport: StubTransport(), tokens: FixedToken())
        let request = try await signedIn.makeRequest(CustomerAPI.tickets())
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
    }

    @Test("Maps the API's error body to a server error with its message")
    func mapsServerError() async {
        let body = #"{"code":"EVENT_NOT_FOUND","message":"That event is no longer available.","correlationId":"abc"}"#
        let client = APIClient(configuration: qa, transport: StubTransport(status: 404, json: body))
        await #expect(throws: APIError.server(status: 404, code: "EVENT_NOT_FOUND", message: "That event is no longer available.")) {
            try await client.send(CustomerAPI.event(slug: "gone"))
        }
    }

    @Test("401 maps to unauthorized")
    func mapsUnauthorized() async {
        let client = APIClient(configuration: qa, transport: StubTransport(status: 401), tokens: FixedToken())
        await #expect(throws: APIError.unauthorized) { try await client.send(CustomerAPI.tickets()) }
    }

    @Test("MOCK has no server to call")
    func mockHasNoServer() async {
        let client = APIClient(configuration: .mock, transport: StubTransport())
        await #expect(throws: APIError.notConfigured) { try await client.makeRequest(CustomerAPI.discovery()) }
    }
}
