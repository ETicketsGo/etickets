import SwiftUI
import Observation

@MainActor
@Observable
final class HomeViewModel {
    private(set) var state: Loadable<DiscoveryFeed> = .idle
    private let catalog: any CatalogRepository

    init(catalog: any CatalogRepository) { self.catalog = catalog }

    func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await catalog.discovery())
        } catch {
            // Keep showing what we had on a failed refresh; only an empty screen shows the error.
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }
}

struct HomeView: View {
    @Environment(AppContainer.self) private var container
    @Environment(AppRouter.self) private var router
    @State private var model: HomeViewModel?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ETGSpace.xl) {
                header
                if let model {
                    LoadableView(state: model.state, retry: { Task { await model.load() } }) { feed in
                        sections(feed)
                    }
                }
            }
            .padding(.bottom, ETGSpace.xl)
        }
        .etgScreenBackground()
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await model?.load() }
        .task {
            if model == nil { model = HomeViewModel(catalog: container.catalog) }
            if model?.state.value == nil { await model?.load() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: ETGSpace.md) {
            HStack {
                BrandMark()
                Spacer()
                EnvironmentBadge(environment: container.configuration.environment)
            }
            Text("What's on")
                .font(ETGFont.display)
                .foregroundStyle(ETGColor.ink)
                .accessibilityAddTraits(.isHeader)
            Text("Movies, concerts and live events near you")
                .font(ETGFont.subheadline)
                .foregroundStyle(ETGColor.muted)
            Button { router.explore() } label: {
                HStack(spacing: ETGSpace.sm) {
                    Image(systemName: "magnifyingglass")
                    Text("Search events, movies, venues")
                    Spacer()
                }
                .font(ETGFont.body)
                .foregroundStyle(ETGColor.muted)
                .padding(.horizontal, ETGSpace.lg)
                .frame(minHeight: 48)
                .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.control))
                .overlay(RoundedRectangle(cornerRadius: ETGRadius.control).strokeBorder(ETGColor.rule))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search events, movies and venues")
            .padding(.top, ETGSpace.xs)
        }
        .padding(.horizontal, ETGSpace.gutter)
        .padding(.top, ETGSpace.sm)
    }

    @ViewBuilder
    private func sections(_ feed: DiscoveryFeed) -> some View {
        let base = container.configuration.apiBaseURL
        if !feed.nowShowing.isEmpty {
            shelf("Now showing", seeAll: { router.selectedTab = .movies }) {
                ForEach(feed.nowShowing) { movie in
                    NavigationLink(value: Route.movie(movie)) { MoviePosterCard(movie: movie) }
                        .buttonStyle(.plain)
                }
            }
        }
        if !feed.trendingEvents.isEmpty {
            shelf("Trending", seeAll: { router.explore() }) {
                ForEach(feed.trendingEvents) { event in
                    NavigationLink(value: Route.event(slug: event.slug)) { EventCard(event: event, imageBase: base) }
                        .buttonStyle(.plain)
                }
            }
        }
        if !feed.thisWeekend.isEmpty {
            shelf("This weekend", seeAll: nil) {
                ForEach(feed.thisWeekend) { event in
                    NavigationLink(value: Route.event(slug: event.slug)) {
                        EventCard(event: event, imageBase: base, width: 240)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        if !feed.categories.isEmpty {
            VStack(alignment: .leading, spacing: ETGSpace.md) {
                SectionHeader(title: "Browse by category")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: ETGSpace.sm) {
                        ForEach(feed.categories, id: \.self) { category in
                            FilterChip(title: Formatters.category(category), isSelected: false) {
                                router.explore(category: category)
                            }
                        }
                    }
                    .padding(.horizontal, ETGSpace.gutter)
                }
            }
        }
        if feed.nowShowing.isEmpty && feed.trendingEvents.isEmpty && feed.thisWeekend.isEmpty {
            EmptyStateView(
                systemImage: "calendar",
                title: "Nothing on yet",
                message: "New movies and events will appear here as organizers publish them.")
        }
    }

    private func shelf<Content: View>(
        _ title: String, seeAll: (() -> Void)?, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.md) {
            SectionHeader(title: title) {
                if let seeAll {
                    Button("See all", action: seeAll)
                        .font(ETGFont.subheadline.weight(.semibold))
                        .foregroundStyle(ETGColor.ink)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: ETGSpace.lg) { content() }
                    .padding(.horizontal, ETGSpace.gutter)
            }
        }
    }
}

#Preview {
    NavigationStack { HomeView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
