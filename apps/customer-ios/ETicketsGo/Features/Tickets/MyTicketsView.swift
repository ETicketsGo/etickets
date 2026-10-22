import SwiftUI
import UIKit
import Observation

@MainActor
@Observable
final class MyTicketsViewModel {
    enum Content: Sendable {
        case signedOut
        case tickets(upcoming: [Ticket], past: [Ticket])
    }

    private(set) var state: Loadable<Content> = .idle
    private let repository: any TicketsRepository

    init(repository: any TicketsRepository) { self.repository = repository }

    func load(now: Date = .now) async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(Self.split(try await repository.tickets(), now: now))
        } catch APIError.unauthorized {
            state = .loaded(.signedOut)
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    /// Upcoming soonest-first, past most-recent-first. A ticket counts as upcoming until a
    /// few hours after it starts, so it stays at the top while the customer is at the door.
    nonisolated static func split(_ tickets: [Ticket], now: Date) -> Content {
        let cutoff = now.addingTimeInterval(-6 * 3600)
        let upcoming = tickets.filter { $0.startsAt >= cutoff }.sorted { $0.startsAt < $1.startsAt }
        let past = tickets.filter { $0.startsAt < cutoff }.sorted { $0.startsAt > $1.startsAt }
        return .tickets(upcoming: upcoming, past: past)
    }
}

struct MyTicketsView: View {
    @Environment(AppContainer.self) private var container
    @State private var model: MyTicketsViewModel?

    var body: some View {
        ScrollView {
            if let model {
                LoadableView(state: model.state, retry: { Task { await model.load() } }) { content in
                    switch content {
                    case .signedOut:
                        EmptyStateView(systemImage: "person.crop.circle.badge.questionmark", title: "Sign in to see your tickets",
                                       message: "Sign-in arrives in the next release.")
                    case let .tickets(upcoming, past) where upcoming.isEmpty && past.isEmpty:
                        EmptyStateView(systemImage: "ticket", title: "No tickets yet",
                                       message: "Tickets you book appear here, ready to show at the door.")
                    case let .tickets(upcoming, past):
                        list(upcoming: upcoming, past: past)
                    }
                }
            }
        }
        .etgScreenBackground()
        .navigationTitle("My Tickets")
        .refreshable { await model?.load() }
        .task {
            if model == nil { model = MyTicketsViewModel(repository: container.tickets) }
            if model?.state.value == nil { await model?.load() }
        }
    }

    private func list(upcoming: [Ticket], past: [Ticket]) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.xl) {
            if !upcoming.isEmpty { group("Upcoming", upcoming) }
            if !past.isEmpty { group("Past", past).opacity(0.75) }
        }
        .padding(.vertical, ETGSpace.md)
    }

    private func group(_ title: String, _ tickets: [Ticket]) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.md) {
            SectionHeader(title: title)
            ForEach(tickets) { ticket in
                NavigationLink(value: Route.ticket(ticket)) { TicketCard(ticket: ticket) }
                    .buttonStyle(.plain)
                    .padding(.horizontal, ETGSpace.gutter)
            }
        }
    }
}

/// A ticket stub: gold day/month block, details, and the seat when there is one.
struct TicketCard: View {
    let ticket: Ticket

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 2) {
                Text(ticket.startsAt.formatted(.dateTime.day())).font(.system(.title2, weight: .bold))
                Text(ticket.startsAt.formatted(.dateTime.month(.abbreviated)).uppercased())
                    .font(ETGFont.eyebrow).tracking(0.8)
            }
            .foregroundStyle(ETGColor.goldText)
            .frame(width: 72)
            .frame(maxHeight: .infinity)
            .background(ETGColor.sunken)
            .overlay(alignment: .trailing) {
                Rectangle().fill(ETGColor.ruleStrong).frame(width: 1)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(ticket.event.title).font(ETGFont.headline).foregroundStyle(ETGColor.ink).lineLimit(2)
                Text(ticket.startsAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))
                    .font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                Text(TicketDetailView.place(ticket)).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted).lineLimit(1)
                HStack(spacing: ETGSpace.sm) {
                    Pill(text: ticket.ticketType)
                    if let seat = ticket.seatLabel { Pill(text: "Seat \(seat)", tint: ETGColor.ink) }
                }
                .padding(.top, 2)
            }
            .padding(ETGSpace.md)
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(ETGColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: ETGRadius.card))
        .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows the ticket's entry code")
    }
}

struct TicketDetailView: View {
    let ticket: Ticket

    var body: some View {
        ScrollView {
            VStack(spacing: ETGSpace.xl) {
                VStack(spacing: ETGSpace.sm) {
                    Eyebrow(text: ticket.ticketType)
                    Text(ticket.event.title).font(ETGFont.title).multilineTextAlignment(.center)
                    Text(Formatters.eventDate(ticket.startsAt)).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                }
                .foregroundStyle(ETGColor.ink)

                code
                    .frame(width: 260, height: 260)
                    .padding(ETGSpace.lg)
                    .background(.white, in: RoundedRectangle(cornerRadius: ETGRadius.card))
                    .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))

                VStack(spacing: ETGSpace.md) {
                    detail("Where", Self.place(ticket))
                    if let seat = ticket.seatLabel { detail("Seat", seat) }
                    if let holder = ticket.attendeeName ?? ticket.holderName { detail("Name", holder) }
                    if let reference = ticket.bookingRef { detail("Booking", reference) }
                    detail("Ticket", ticket.serial)
                }
                .padding(ETGSpace.lg)
                .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))
            }
            .padding(ETGSpace.gutter)
        }
        .etgScreenBackground()
        .navigationTitle("Ticket")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The server-rendered code, or an explanation. The app never generates a code itself:
    /// what is presentable (our token or a vendor barcode) is the server's decision.
    @ViewBuilder
    private var code: some View {
        if let image = Self.image(fromDataURL: ticket.qrDataUrl) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .accessibilityLabel("Entry code for \(ticket.event.title)")
        } else {
            VStack(spacing: ETGSpace.sm) {
                Image(systemName: "qrcode").font(.system(size: 44, weight: .light))
                Text("This ticket's code isn't available on this device.")
                    .font(ETGFont.subheadline)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(Color(hex: 0x6A6359))
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
            Spacer()
            Text(value).font(ETGFont.subheadline.weight(.semibold)).foregroundStyle(ETGColor.ink)
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }

    nonisolated static func place(_ ticket: Ticket) -> String {
        [ticket.cinemaName ?? ticket.venueName, ticket.screenName].compactMap { $0 }.joined(separator: " · ")
    }

    /// Decodes `data:image/png;base64,...`. Returns nil for anything else.
    nonisolated static func image(fromDataURL string: String?) -> UIImage? {
        guard let string, string.hasPrefix("data:image/"),
              let comma = string.firstIndex(of: ","),
              string[..<comma].hasSuffix(";base64"),
              let data = Data(base64Encoded: String(string[string.index(after: comma)...]))
        else { return nil }
        return UIImage(data: data)
    }
}

#Preview("My Tickets") {
    NavigationStack { MyTicketsView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
