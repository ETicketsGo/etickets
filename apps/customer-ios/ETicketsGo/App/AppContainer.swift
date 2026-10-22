import Foundation
import Observation

/// Composition root: picks the data sources for this build's environment once, at launch.
@MainActor
@Observable
final class AppContainer {
    let configuration: AppConfiguration
    let catalog: any CatalogRepository
    let tickets: any TicketsRepository
    let auth: AuthStore

    init(
        configuration: AppConfiguration,
        catalog: any CatalogRepository,
        tickets: any TicketsRepository,
        auth: AuthStore
    ) {
        self.configuration = configuration
        self.catalog = catalog
        self.tickets = tickets
        self.auth = auth
    }

    static func make(for configuration: AppConfiguration) -> AppContainer {
        let store = KeychainTokenStore(environment: configuration.environment)
        FreshInstallGuard.clearSessionIfNewInstall(store)
        switch configuration.environment {
        case .mock:
            #if DEBUG
            // Debug MOCK builds only: `-ETGMockSignedIn` starts with the demo customer signed in.
            if ProcessInfo.processInfo.arguments.contains("-ETGMockSignedIn"),
               let user = try? FixtureStore().load("me", as: AuthenticatedUser.self) {
                try? store.save(StoredSession(
                    tokens: TokenPair(accessToken: "mock-access-debug", refreshToken: "mock-refresh-debug"),
                    identity: user.email, user: user))
            }
            #endif
            return .mock(configuration: configuration, store: store)
        case .qa, .prod:
            // Two clients: auth-flow calls (and the refresh itself) go out with no bearer token;
            // everything else carries the session's token and refreshes it on a 401.
            let publicClient = APIClient(configuration: configuration)
            let session = AuthSession(store: store, configuration: configuration) { refreshToken in
                try await publicClient.send(AuthAPI.refresh(refreshToken))
            }
            let client = APIClient(configuration: configuration, tokens: session)
            let service = RemoteAuthService(
                publicClient: publicClient, client: client, session: session, configuration: configuration)
            return AppContainer(
                configuration: configuration,
                catalog: RemoteCatalogRepository(client: client),
                tickets: RemoteTicketsRepository(client: client),
                auth: AuthStore(service: service, session: session))
        }
    }

    static func mock(
        configuration: AppConfiguration = .mock,
        store: any TokenStore = InMemoryTokenStore(),
        latency: Duration = .milliseconds(350)
    ) -> AppContainer {
        let session = AuthSession(store: store, configuration: configuration) { _ in
            TokenPair(accessToken: "mock-access-\(UUID().uuidString)", refreshToken: "mock-refresh-\(UUID().uuidString)")
        }
        return AppContainer(
            configuration: configuration,
            catalog: MockCatalogRepository(latency: latency),
            tickets: MockTicketsRepository(session: session, latency: latency),
            auth: AuthStore(service: MockAuthService(session: session, latency: latency), session: session))
    }

    /// For SwiftUI previews: fixtures, no delay, signed out.
    static var preview: AppContainer { .mock(latency: .zero) }
}
