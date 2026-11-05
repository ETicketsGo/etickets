import Foundation
import Observation

/// Composition root: picks the data sources for this build's environment once, at launch.
@MainActor
@Observable
final class AppContainer {
    let configuration: AppConfiguration
    let catalog: any CatalogRepository
    let tickets: any TicketsRepository
    let account: any AccountRepository

    init(
        configuration: AppConfiguration,
        catalog: any CatalogRepository,
        tickets: any TicketsRepository,
        account: any AccountRepository
    ) {
        self.configuration = configuration
        self.catalog = catalog
        self.tickets = tickets
        self.account = account
    }

    static func make(for configuration: AppConfiguration) -> AppContainer {
        switch configuration.environment {
        case .mock:
            return .mock(configuration: configuration)
        case .qa, .prod:
            let client = APIClient(configuration: configuration)
            return AppContainer(
                configuration: configuration,
                catalog: RemoteCatalogRepository(client: client),
                tickets: RemoteTicketsRepository(client: client),
                account: RemoteAccountRepository(client: client))
        }
    }

    static func mock(configuration: AppConfiguration = .mock, latency: Duration = .milliseconds(350)) -> AppContainer {
        AppContainer(
            configuration: configuration,
            catalog: MockCatalogRepository(latency: latency),
            tickets: MockTicketsRepository(latency: latency),
            account: MockAccountRepository())
    }

    /// For SwiftUI previews: fixtures, no delay.
    static var preview: AppContainer { .mock(latency: .zero) }
}
