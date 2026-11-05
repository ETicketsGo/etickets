import SwiftUI
import Observation

@MainActor
@Observable
final class ExploreViewModel {
    var searchText = ""
    var category: String?
    private(set) var categories: [String] = []
    private(set) var results: Loadable<[EventSummary]> = .idle
    private let catalog: any CatalogRepository

    init(catalog: any CatalogRepository) { self.catalog = catalog }

    /// What the result list depends on; the view reloads when it changes.
    var queryKey: EventQuery {
        let text = searchText.trimmingCharacters(in: .whitespaces)
        return EventQuery(text: text.isEmpty ? nil : text, category: category)
    }

    func loadCategories() async {
        guard categories.isEmpty else { return }
        categories = (try? await catalog.discovery().categories) ?? []
    }

    func search() async {
        results = .loading
        do {
            results = .loaded(try await catalog.events(queryKey).data)
        } catch is CancellationError {
            // A newer query replaced this one.
        } catch {
            results = .failed(error.userMessage)
        }
    }
}

struct ExploreView: View {
    @Environment(AppContainer.self) private var container
    @Environment(AppRouter.self) private var router
    @State private var model: ExploreViewModel?

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                LoadingStateView()
            }
        }
        .etgScreenBackground()
        .navigationTitle("Explore")
        .task {
            if model == nil { model = ExploreViewModel(catalog: container.catalog) }
            await model?.loadCategories()
        }
        .onChange(of: router.pendingExploreCategory, initial: true) { _, category in
            guard let category, let model else { return }
            model.category = category
            router.pendingExploreCategory = nil
        }
    }

    private func content(_ model: ExploreViewModel) -> some View {
        @Bindable var model = model
        return List {
            if !model.categories.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: ETGSpace.sm) {
                        FilterChip(title: "All", isSelected: model.category == nil) { model.category = nil }
                        ForEach(model.categories, id: \.self) { category in
                            FilterChip(title: Formatters.category(category), isSelected: model.category == category) {
                                model.category = model.category == category ? nil : category
                            }
                        }
                    }
                    .padding(.horizontal, ETGSpace.gutter)
                    .padding(.vertical, ETGSpace.xs)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            results(model)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .searchable(text: $model.searchText, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Events, venues, cities")
        .task(id: model.queryKey) {
            // Debounce typing; a newer key cancels this task before it fires.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await model.search()
        }
    }

    @ViewBuilder
    private func results(_ model: ExploreViewModel) -> some View {
        switch model.results {
        case .idle, .loading:
            LoadingStateView().listRowBackground(Color.clear).listRowSeparator(.hidden)
        case let .failed(message):
            ErrorStateView(message: message) { Task { await model.search() } }
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
        case let .loaded(events) where events.isEmpty:
            EmptyStateView(
                systemImage: "magnifyingglass",
                title: "No matches",
                message: "Try a different word or clear the category filter.")
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
        case let .loaded(events):
            ForEach(events) { event in
                NavigationLink(value: Route.event(slug: event.slug)) {
                    EventRow(event: event, imageBase: container.configuration.apiBaseURL)
                }
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(ETGColor.rule)
            }
        }
    }
}

#Preview {
    NavigationStack { ExploreView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
