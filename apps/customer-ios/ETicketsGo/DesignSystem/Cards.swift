import SwiftUI

/// An event or movie picture, or a branded placeholder when there is none (always the case
/// in MOCK, which makes no network requests).
struct ArtworkView: View {
    let url: URL?
    let title: String
    var systemImage = "sparkles"

    var body: some View {
        ZStack {
            placeholder
            if let url {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    }
                }
            }
        }
        .clipped()
        .accessibilityHidden(true)
    }

    private var placeholder: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: [ETGColor.imageFallback, Color(hex: 0x4A3B2A)],
                startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(ETGColor.gold.opacity(0.85))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Text(title.prefix(1))
                .font(.system(size: 72, weight: .black))
                .foregroundStyle(.white.opacity(0.06))
                .padding(.leading, ETGSpace.sm)
        }
    }
}

enum CategorySymbol {
    static func name(for category: String) -> String {
        switch category.lowercased() {
        case let c where c.contains("music") || c.contains("concert"): "music.note"
        case let c where c.contains("comedy"): "theatermasks"
        case let c where c.contains("theatre") || c.contains("theater"): "theatermask.and.paintbrush"
        case let c where c.contains("sport"): "sportscourt"
        case let c where c.contains("food"): "fork.knife"
        case let c where c.contains("workshop") || c.contains("art"): "paintpalette"
        case let c where c.contains("movie") || c.contains("cinema") || c.contains("film"): "film"
        default: "sparkles"
        }
    }
}

/// Wide event card for horizontal shelves and lists.
struct EventCard: View {
    let event: EventSummary
    var imageBase: URL?
    var width: CGFloat? = 280

    var body: some View {
        VStack(alignment: .leading, spacing: ETGSpace.sm) {
            ArtworkView(
                url: event.imageURL(for: .card, base: imageBase),
                title: event.title,
                systemImage: CategorySymbol.name(for: event.category))
                .aspectRatio(16 / 10, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: ETGRadius.card))
            Eyebrow(text: Formatters.category(event.category))
            Text(event.title)
                .font(ETGFont.headline)
                .foregroundStyle(ETGColor.ink)
                .lineLimit(2)
            VStack(alignment: .leading, spacing: 2) {
                if let date = event.nextSessionAt {
                    Text(Formatters.eventDate(date, timeZone: event.venue.timezone))
                }
                Text("\(event.venue.name) · \(event.venue.city)")
            }
            .font(ETGFont.subheadline)
            .foregroundStyle(ETGColor.muted)
            .lineLimit(1)
            if let price = Formatters.fromPrice(minor: event.fromPriceMinor, currency: event.currency) {
                Text(price).font(ETGFont.subheadline.weight(.semibold)).foregroundStyle(ETGColor.ink)
            }
        }
        .frame(width: width, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens event details")
    }
}

/// Compact row for search results and lists.
struct EventRow: View {
    let event: EventSummary
    var imageBase: URL?

    var body: some View {
        HStack(spacing: ETGSpace.md) {
            ArtworkView(
                url: event.imageURL(for: .thumb, base: imageBase),
                title: event.title,
                systemImage: CategorySymbol.name(for: event.category))
                .frame(width: 84, height: 84)
                .clipShape(RoundedRectangle(cornerRadius: ETGRadius.control))
            VStack(alignment: .leading, spacing: 3) {
                Eyebrow(text: Formatters.category(event.category))
                Text(event.title).font(ETGFont.headline).foregroundStyle(ETGColor.ink).lineLimit(2)
                if let date = event.nextSessionAt {
                    Text(Formatters.eventDate(date, timeZone: event.venue.timezone)).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                }
                Text(event.venue.name).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Poster card for movies (2:3).
struct MoviePosterCard: View {
    let movie: MovieSummary
    var width: CGFloat? = 150

    var body: some View {
        VStack(alignment: .leading, spacing: ETGSpace.sm) {
            ArtworkView(url: movie.posterUrl.flatMap(URL.init(string:)), title: movie.title, systemImage: "film")
                .aspectRatio(2 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: ETGRadius.control))
            Text(movie.title).font(ETGFont.headline).foregroundStyle(ETGColor.ink).lineLimit(2)
            HStack(spacing: ETGSpace.sm) {
                if let certificate = movie.certificate { Pill(text: certificate) }
                if let language = movie.language {
                    Text(language).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted).lineLimit(1)
                }
            }
        }
        .frame(width: width, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

#Preview("Cards") {
    let feed = try! FixtureStore().load("discovery", as: DiscoveryFeed.self)
    return ScrollView {
        VStack(alignment: .leading, spacing: ETGSpace.xl) {
            EventCard(event: feed.trendingEvents[0])
            EventRow(event: feed.trendingEvents[1])
            MoviePosterCard(movie: feed.nowShowing[0])
        }
        .padding()
    }
    .background(ETGColor.canvas)
}
