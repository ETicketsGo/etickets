import Foundation
import Observation

/// Composition root: picks the data sources for this build's environment once, at launch.
@MainActor
@Observable
final class AppContainer {
    let configuration: AppConfiguration
    let catalog: any CatalogRepository
    let tickets: any TicketsRepository
    let offlineTickets: any OfflineTicketStore
    let auth: AuthStore
    let booking: any BookingRepository
    let city = CityStore()
    let pendingCheckout = PendingCheckoutStore()
    /// MOCK only: the in-memory commerce server, so the simulated provider page can approve.
    let mockCommerce: MockCommerceServer?

    init(
        configuration: AppConfiguration,
        catalog: any CatalogRepository,
        tickets: any TicketsRepository,
        offlineTickets: any OfflineTicketStore,
        auth: AuthStore,
        booking: any BookingRepository,
        mockCommerce: MockCommerceServer? = nil
    ) {
        self.configuration = configuration
        self.catalog = catalog
        self.tickets = tickets
        self.offlineTickets = offlineTickets
        self.auth = auth
        self.booking = booking
        self.mockCommerce = mockCommerce
    }

    static func make(for configuration: AppConfiguration) -> AppContainer {
        let store = KeychainTokenStore(environment: configuration.environment)
        let offline = FileOfflineTicketStore(environment: configuration.environment)
        FreshInstallGuard.clearSessionIfNewInstall(store)
        switch configuration.environment {
        case .mock:
            #if DEBUG
            // Debug MOCK builds only: `-ETGResetSession` starts signed out with nothing saved, so
            // each UI test is independent; `-ETGMockSignedIn` starts with the demo customer signed in.
            if ProcessInfo.processInfo.arguments.contains("-ETGResetSession") {
                store.clear(); offline.clear()
                PendingCheckoutStore().clear()
                MockCommerceServer.discardSavedState()
            }
            if ProcessInfo.processInfo.arguments.contains("-ETGMockSignedIn"),
               let user = try? FixtureStore().load("me", as: AuthenticatedUser.self) {
                try? store.save(StoredSession(
                    tokens: TokenPair(accessToken: "mock-access-debug", refreshToken: "mock-refresh-debug"),
                    identity: user.email, user: user))
            }
            #endif
            return .mock(configuration: configuration, store: store, offline: offline)
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
                offlineTickets: offline,
                auth: AuthStore(service: service, session: session, offlineTickets: offline),
                booking: RemoteBookingRepository(client: client))
        }
    }

    static func mock(
        configuration: AppConfiguration = .mock,
        store: any TokenStore = InMemoryTokenStore(),
        offline: any OfflineTicketStore = InMemoryOfflineTicketStore(),
        latency: Duration = .milliseconds(350)
    ) -> AppContainer {
        let session = AuthSession(store: store, configuration: configuration) { _ in
            TokenPair(accessToken: "mock-access-\(UUID().uuidString)", refreshToken: "mock-refresh-\(UUID().uuidString)")
        }
        let arguments = ProcessInfo.processInfo.arguments
        #if DEBUG
        // Debug MOCK only: `-ETGMockHoldSeconds 20` shortens holds to demonstrate expiry;
        // `-ETGMockFailFirst` makes the first catalog call fail, to exercise error and retry.
        let holdSeconds = arguments.firstIndex(of: "-ETGMockHoldSeconds").flatMap { i in
            arguments.indices.contains(i + 1) ? TimeInterval(arguments[i + 1]) : nil } ?? 600
        let failFirst = arguments.contains("-ETGMockFailFirst")
        // `-ETGMockOfflineAfterFirstLoad`: the wallet loads once, then the "network" drops.
        let offlineAfter: Int? = arguments.contains("-ETGMockOfflineAfterFirstLoad") ? 1 : nil
        #else
        let offlineAfter: Int? = nil
        let holdSeconds: TimeInterval = 600
        let failFirst = false
        #endif
        // The running app keeps its simulated bookings across launches, so an interrupted
        // checkout can be resumed after the app is terminated; tests and previews don't.
        let commerce = MockCommerceServer(holdDuration: holdSeconds, confirmationDelay: latency == .zero ? .milliseconds(10) : .seconds(3),
                                          persists: latency != .zero)
        return AppContainer(
            configuration: configuration,
            catalog: MockCatalogRepository(latency: latency, failOnce: FailOnce(armed: failFirst)),
            tickets: MockTicketsRepository(session: session, latency: latency, server: commerce, network: GoesOffline(after: offlineAfter)),
            offlineTickets: offline,
            auth: AuthStore(service: MockAuthService(session: session, latency: latency), session: session, offlineTickets: offline),
            booking: MockBookingRepository(server: commerce, session: session, latency: latency),
            mockCommerce: commerce)
    }

    /// For SwiftUI previews: fixtures, no delay, signed out.
    static var preview: AppContainer { .mock(latency: .zero) }
}
