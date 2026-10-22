import SwiftUI
import Observation

@MainActor
@Observable
final class EventDetailViewModel {
    let slug: String
    private(set) var state: Loadable<EventDetail> = .idle
    private let catalog: any CatalogRepository

    init(slug: String, catalog: any CatalogRepository) {
        self.slug = slug
        self.catalog = catalog
    }

    func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await catalog.event(slug: slug))
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    /// Cheapest ticket across the event's sessions, for the summary line. Display only —
    /// the price charged is always the server's quote.
    static func lowestPrice(_ event: EventDetail) -> (minor: Int, currency: String)? {
        event.sessions.flatMap(\.ticketTypes).min { $0.priceMinor < $1.priceMinor }
            .map { ($0.priceMinor, $0.currency) }
    }

    static func upcomingSessions(_ event: EventDetail, now: Date = .now) -> [EventSession] {
        event.sessions.filter { $0.endsAt > now }.sorted { $0.startsAt < $1.startsAt }
    }
}

struct EventDetailView: View {
    let slug: String
    @Environment(AppContainer.self) private var container
    @State private var model: EventDetailViewModel?

    var body: some View {
        Group {
            if let model {
                LoadableView(state: model.state, retry: { Task { await model.load() } }) { event in
                    content(event)
                }
            } else {
                LoadingStateView()
            }
        }
        .etgScreenBackground()
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil { model = EventDetailViewModel(slug: slug, catalog: container.catalog) }
            if model?.state.value == nil { await model?.load() }
        }
    }

    private func content(_ event: EventDetail) -> some View {
        let sessions = EventDetailViewModel.upcomingSessions(event)
        return ScrollView {
            VStack(alignment: .leading, spacing: ETGSpace.xl) {
                ArtworkView(
                    url: event.imageURL(for: .banner, base: container.configuration.apiBaseURL),
                    title: event.title,
                    systemImage: CategorySymbol.name(for: event.category))
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: ETGRadius.card))

                VStack(alignment: .leading, spacing: ETGSpace.sm) {
                    Eyebrow(text: Formatters.category(event.category))
                    Text(event.title).font(ETGFont.title).foregroundStyle(ETGColor.ink)
                        .accessibilityAddTraits(.isHeader)
                    Label("\(event.venue.name), \(event.venue.city)", systemImage: "mappin.and.ellipse")
                    if let address = event.venue.address {
                        Text(address).padding(.leading, 28)
                    }
                    Label("By \(event.organizer.name)", systemImage: "person.2")
                }
                .font(ETGFont.subheadline)
                .foregroundStyle(ETGColor.inkSecondary)

                if let description = event.description, !description.isEmpty {
                    detailSection("About") {
                        Text(description).font(ETGFont.body).foregroundStyle(ETGColor.inkSecondary)
                    }
                }

                detailSection("Dates and tickets") {
                    if sessions.isEmpty {
                        Text("No upcoming dates.").font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                    }
                    ForEach(sessions) { session in SessionCard(session: session) }
                }

                if let policy = event.refundPolicy, !policy.isEmpty {
                    detailSection("Refund policy") {
                        Text(policy).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                    }
                }
            }
            .padding(.horizontal, ETGSpace.gutter)
            .padding(.vertical, ETGSpace.md)
        }
        // safeAreaInset keeps the bar above the home indicator and lets the scroll content
        // end above it, so nothing hides behind the bar.
        .safeAreaInset(edge: .bottom) { bookingBar(event) }
    }

    private func bookingBar(_ event: EventDetail) -> some View {
        VStack(spacing: ETGSpace.sm) {
            if let lowest = EventDetailViewModel.lowestPrice(event),
               let price = Formatters.fromPrice(minor: lowest.minor, currency: lowest.currency) {
                Text(price).font(ETGFont.subheadline.weight(.semibold)).foregroundStyle(ETGColor.ink)
            }
            // Phase 1 stops before checkout: holds, pricing and payment are server flows
            // that land in Phase 2.
            Button("Booking opens in the next release") {}
                .buttonStyle(.etgPrimary)
                .disabled(true)
                .accessibilityHint("Ticket booking is not available in this build")
        }
        .padding(.horizontal, ETGSpace.gutter)
        .padding(.top, ETGSpace.md)
        .padding(.bottom, ETGSpace.sm)
        .background(ETGColor.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(ETGColor.rule).frame(height: 1) }
    }

    private func detailSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.md) {
            Text(title).font(ETGFont.section).foregroundStyle(ETGColor.ink).accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

struct SessionCard: View {
    let session: EventSession

    var body: some View {
        VStack(alignment: .leading, spacing: ETGSpace.sm) {
            let when = Formatters.dayAndTime(session.startsAt)
            HStack {
                Text(when.day).font(ETGFont.headline)
                Text(when.time).font(ETGFont.headline.monospacedDigit()).foregroundStyle(ETGColor.muted)
                Spacer()
                if session.seatBased == true { Pill(text: "Reserved seating") }
            }
            .foregroundStyle(ETGColor.ink)
            ForEach(session.ticketTypes) { type in
                HStack {
                    Text(type.name).font(ETGFont.subheadline).foregroundStyle(ETGColor.inkSecondary)
                    Spacer()
                    if type.available == 0 {
                        Text("Sold out").font(ETGFont.caption.weight(.semibold)).foregroundStyle(ETGColor.critical)
                    } else {
                        Text(type.priceMinor == 0 ? "Free" : Formatters.money(minor: type.priceMinor, currency: type.currency))
                            .font(ETGFont.subheadline.weight(.semibold))
                            .foregroundStyle(ETGColor.ink)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(ETGSpace.lg)
        .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))
        .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))
    }
}

#Preview {
    NavigationStack { EventDetailView(slug: "monsoon-jazz-nights-hyderabad") }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
