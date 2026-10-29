import SwiftUI
import Observation

enum AppTab: String, Hashable {
    case home, explore, movies, tickets, profile
}

/// Pushed destinations, shared by every tab's NavigationStack.
enum Route: Hashable {
    case event(slug: String)
    case movie(MovieSummary)
    case ticket(Ticket)
}

/// Cross-tab navigation: switching tabs, and opening Explore with a category chosen on Home.
@MainActor
@Observable
final class AppRouter {
    var selectedTab: AppTab = .home
    /// Each tab's navigation stack, so links (and later, deep links) can push onto it.
    var paths: [AppTab: [Route]] = [:]
    /// Set by Home; consumed once by Explore.
    var pendingExploreCategory: String?

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        #if DEBUG
        // Debug builds only: `-ETGTab movies` and `-ETGEvent <slug>` open a screen at launch,
        // for screenshots and UI checks without tapping.
        if let tab = Self.value(after: "-ETGTab", in: arguments).flatMap(AppTab.init(rawValue:)) {
            selectedTab = tab
        }
        if let slug = Self.value(after: "-ETGEvent", in: arguments) {
            paths[selectedTab] = [.event(slug: slug)]
        }
        #endif
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    func explore(category: String? = nil) {
        pendingExploreCategory = category
        selectedTab = .explore
    }
}

struct RootTabView: View {
    @Environment(AppRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.selectedTab) {
            tab(.home, "Home", "house") { HomeView() }
            tab(.explore, "Explore", "magnifyingglass") { ExploreView() }
            tab(.movies, "Movies", "film") { MoviesView() }
            tab(.tickets, "Tickets", "ticket") { MyTicketsView() }
            tab(.profile, "Profile", "person.crop.circle") { ProfileView() }
        }
        .tint(ETGColor.ink)
    }

    private func tab<Content: View>(
        _ tab: AppTab, _ title: String, _ symbol: String, @ViewBuilder content: () -> Content
    ) -> some View {
        NavigationStack(path: Binding(
            get: { router.paths[tab, default: []] },
            set: { router.paths[tab] = $0 }
        )) {
            content()
                .navigationDestination(for: Route.self) { RouteDestination(route: $0) }
        }
        .tabItem { Label(title, systemImage: symbol) }
        .tag(tab)
    }
}

struct RouteDestination: View {
    let route: Route

    var body: some View {
        switch route {
        case let .event(slug): EventDetailView(slug: slug)
        case let .movie(movie): MovieDetailView(movie: movie)
        case let .ticket(ticket): TicketDetailView(ticket: ticket)
        }
    }
}

extension View {
    /// The ivory canvas behind a whole screen, including under the bars.
    func etgScreenBackground() -> some View {
        background(ETGColor.canvas.ignoresSafeArea())
    }
}
