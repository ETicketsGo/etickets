import SwiftUI
import Observation

@MainActor
@Observable
final class MoviesViewModel {
    private(set) var state: Loadable<[MovieSummary]> = .idle
    private let catalog: any CatalogRepository

    init(catalog: any CatalogRepository) { self.catalog = catalog }

    /// The "now showing" list from /public/discovery — the one movie listing whose response
    /// contract the inventory confirmed. (GET /public/movies exists; its shape is unverified.)
    func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await catalog.discovery().nowShowing)
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }
}

struct MoviesView: View {
    @Environment(AppContainer.self) private var container
    @State private var model: MoviesViewModel?

    private let columns = [GridItem(.flexible(), spacing: ETGSpace.lg), GridItem(.flexible(), spacing: ETGSpace.lg)]

    var body: some View {
        ScrollView {
            if let model {
                LoadableView(state: model.state, retry: { Task { await model.load() } }) { movies in
                    if movies.isEmpty {
                        EmptyStateView(systemImage: "film", title: "No movies showing",
                                       message: "Check back soon for new releases.")
                    } else {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: ETGSpace.xl) {
                            ForEach(movies) { movie in
                                NavigationLink(value: Route.movie(movie)) { MoviePosterCard(movie: movie, width: nil) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, ETGSpace.gutter)
                        .padding(.vertical, ETGSpace.md)
                    }
                }
            }
        }
        .etgScreenBackground()
        .navigationTitle("Movies")
        .refreshable { await model?.load() }
        .task {
            if model == nil { model = MoviesViewModel(catalog: container.catalog) }
            if model?.state.value == nil { await model?.load() }
        }
    }
}

// MARK: - Movie detail and showtimes

@MainActor
@Observable
final class MovieDetailViewModel {
    let summary: MovieSummary
    private(set) var state: Loadable<MovieShows> = .idle
    private let catalog: any CatalogRepository

    init(summary: MovieSummary, catalog: any CatalogRepository) {
        self.summary = summary
        self.catalog = catalog
    }

    func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await catalog.movieShows(slug: summary.slug))
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    /// Shows grouped by their calendar day in the cinema's zone (a 10:30 PM IST show is that
    /// day's last show even for a customer reading in another zone), in order.
    nonisolated static func days(_ shows: [MovieShow], deviceZone: TimeZone = .current) -> [(day: Date, shows: [MovieShow])] {
        Dictionary(grouping: shows) { show in
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = Formatters.venueZone(show.timeZone, deviceZone: deviceZone)
            return calendar.startOfDay(for: show.startsAt)
        }
        .map { (day: $0.key, shows: $0.value.sorted { $0.startsAt < $1.startsAt }) }
        .sorted { $0.day < $1.day }
    }
}

struct MovieDetailView: View {
    let movie: MovieSummary
    @Environment(AppContainer.self) private var container
    @State private var model: MovieDetailViewModel?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ETGSpace.lg) {
                HStack(alignment: .top, spacing: ETGSpace.lg) {
                    ArtworkView(url: movie.posterUrl.flatMap(URL.init(string:)), title: movie.title, systemImage: "film")
                        .frame(width: 120, height: 180)
                        .clipShape(RoundedRectangle(cornerRadius: ETGRadius.control))
                    VStack(alignment: .leading, spacing: ETGSpace.sm) {
                        Text(movie.title).font(ETGFont.title).foregroundStyle(ETGColor.ink)
                        HStack {
                            if let certificate = movie.certificate { Pill(text: certificate) }
                            if let runtime = Formatters.runtime(movie.runtimeMinutes) {
                                Text(runtime).foregroundStyle(ETGColor.muted)
                            }
                        }
                        .font(ETGFont.subheadline)
                        if !movie.genres.isEmpty {
                            Text(movie.genres.joined(separator: " · ")).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                        }
                    }
                }
                .padding(.horizontal, ETGSpace.gutter)

                if let model {
                    LoadableView(state: model.state, retry: { Task { await model.load() } }) { shows in
                        showtimes(shows)
                    }
                }
            }
            .padding(.vertical, ETGSpace.md)
        }
        .etgScreenBackground()
        .navigationTitle(movie.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil { model = MovieDetailViewModel(summary: movie, catalog: container.catalog) }
            if model?.state.value == nil { await model?.load() }
        }
    }

    @ViewBuilder
    private func showtimes(_ data: MovieShows) -> some View {
        if let synopsis = data.movie.synopsis {
            Text(synopsis)
                .font(ETGFont.body)
                .foregroundStyle(ETGColor.inkSecondary)
                .padding(.horizontal, ETGSpace.gutter)
        }
        SectionHeader(title: "Showtimes")
        if data.shows.isEmpty {
            EmptyStateView(systemImage: "calendar.badge.clock", title: "No upcoming shows",
                           message: "Showtimes appear here when cinemas schedule them.")
        }
        ForEach(MovieDetailViewModel.days(data.shows), id: \.day) { group in
            VStack(alignment: .leading, spacing: ETGSpace.sm) {
                Text(Formatters.dayAndTime(group.day, timeZone: group.shows.first?.timeZone).day)
                    .font(ETGFont.headline).foregroundStyle(ETGColor.ink)
                ForEach(group.shows) { show in
                    NavigationLink(value: Route.event(slug: show.eventSlug)) { ShowtimeRow(show: show) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, ETGSpace.gutter)
        }
    }
}

struct ShowtimeRow: View {
    let show: MovieShow

    var body: some View {
        HStack(spacing: ETGSpace.md) {
            Text(Formatters.time(show.startsAt, timeZone: show.timeZone))
                .font(ETGFont.headline.monospacedDigit())
                .foregroundStyle(ETGColor.ink)
                .frame(minWidth: 72, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(show.cinema?.name ?? show.venue.name).font(ETGFont.subheadline.weight(.semibold))
                Text([show.screen?.name, show.format, show.language].compactMap { $0 }.joined(separator: " · "))
                    .font(ETGFont.caption)
                    .foregroundStyle(ETGColor.muted)
            }
            .foregroundStyle(ETGColor.ink)
            Spacer()
            if let price = Formatters.fromPrice(minor: show.fromPriceMinor, currency: show.currency) {
                Text(price).font(ETGFont.caption.weight(.semibold)).foregroundStyle(ETGColor.inkSecondary)
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(ETGColor.muted)
        }
        .padding(ETGSpace.md)
        .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.control))
        .overlay(RoundedRectangle(cornerRadius: ETGRadius.control).strokeBorder(ETGColor.rule))
        .accessibilityElement(children: .combine)
    }
}

#Preview("Movies") {
    NavigationStack { MoviesView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
