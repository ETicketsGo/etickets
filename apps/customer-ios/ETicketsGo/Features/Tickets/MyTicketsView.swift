import SwiftUI
import UIKit
import Observation

@MainActor
@Observable
final class MyTicketsViewModel {
    enum Content: Sendable {
        case signedOut
        /// `offlineSince` is set when this is the saved copy, shown because the server could
        /// not be reached.
        case tickets(upcoming: [Ticket], past: [Ticket], offlineSince: Date?)
    }

    private(set) var state: Loadable<Content> = .idle
    private let repository: any TicketsRepository
    private let offline: any OfflineTicketStore

    init(repository: any TicketsRepository, offline: any OfflineTicketStore) {
        self.repository = repository
        self.offline = offline
    }

    func load(userId: String?, now: Date = .now) async {
        if state.value == nil { state = .loading }
        do {
            let tickets = try await repository.tickets()
            if let userId { try? offline.save(tickets, userId: userId, now: now) }
            state = .loaded(Self.split(tickets, now: now, offlineSince: nil))
        } catch APIError.unauthorized {
            state = .loaded(.signedOut)
        } catch {
            // Unreachable server or no connection: the saved copy, if there is a usable one.
            if let userId, let wallet = offline.load(userId: userId, now: now) {
                state = .loaded(Self.split(wallet.tickets, now: now, offlineSince: wallet.syncedAt))
            } else if state.value == nil {
                state = .failed(error.userMessage)
            }
        }
    }

    /// Upcoming soonest-first, past most-recent-first. A ticket counts as upcoming until a
    /// few hours after it starts, so it stays at the top while the customer is at the door.
    nonisolated static func split(_ tickets: [Ticket], now: Date, offlineSince: Date? = nil) -> Content {
        let cutoff = now.addingTimeInterval(-OfflineTicketPolicy.graceAfterStart)
        let upcoming = tickets.filter { $0.startsAt >= cutoff }.sorted { $0.startsAt < $1.startsAt }
        let past = tickets.filter { $0.startsAt < cutoff }.sorted { $0.startsAt > $1.startsAt }
        return .tickets(upcoming: upcoming, past: past, offlineSince: offlineSince)
    }
}

struct MyTicketsView: View {
    @Environment(AppContainer.self) private var container
    @State private var model: MyTicketsViewModel?

    var body: some View {
        ScrollView {
            if let model {
                LoadableView(state: model.state, retry: { Task { await reload() } }) { content in
                    switch content {
                    case .signedOut:
                        EmptyStateView(systemImage: "person.crop.circle.badge.questionmark", title: "Sign in to see your tickets",
                                       message: "Your tickets are kept in your account, ready to show at the door.") {
                            Button("Sign in") { container.auth.isPresentingSignIn = true }
                                .buttonStyle(.etgPrimary)
                                .frame(maxWidth: 220)
                        }
                    case let .tickets(upcoming, past, _) where upcoming.isEmpty && past.isEmpty:
                        EmptyStateView(systemImage: "ticket", title: "No tickets yet",
                                       message: "Tickets you book appear here, ready to show at the door.")
                    case let .tickets(upcoming, past, offlineSince):
                        list(upcoming: upcoming, past: past, offlineSince: offlineSince)
                    }
                }
            }
        }
        .etgScreenBackground()
        .navigationTitle("My Tickets")
        .refreshable { await reload() }
        // Reload whenever who is signed in changes: sign-in, sign-out, or an expired session.
        .task(id: container.auth.sessionKey) {
            if model == nil { model = MyTicketsViewModel(repository: container.tickets, offline: container.offlineTickets) }
            guard container.auth.state != .restoring else { return }
            await reload()
        }
    }

    private func reload() async {
        await model?.load(userId: container.auth.user?.id)
    }

    private func list(upcoming: [Ticket], past: [Ticket], offlineSince: Date?) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.xl) {
            if let offlineSince { OfflineNotice(syncedAt: offlineSince) }
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

/// "You're offline. Showing tickets saved 2 hours ago."
struct OfflineNotice: View {
    let syncedAt: Date

    var body: some View {
        Label {
            Text("You're offline. Showing tickets saved \(syncedAt.formatted(.relative(presentation: .named))).")
        } icon: {
            Image(systemName: "wifi.slash")
        }
        .font(ETGFont.subheadline)
        .foregroundStyle(ETGColor.inkSecondary)
        .padding(ETGSpace.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ETGColor.sunken, in: RoundedRectangle(cornerRadius: ETGRadius.control))
        .padding(.horizontal, ETGSpace.gutter)
        .accessibilityElement(children: .combine)
    }
}

/// A ticket stub: gold day/month block, details, and the seat when there is one.
struct TicketCard: View {
    let ticket: Ticket

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 2) {
                Text(Self.stub(ticket).day).font(.system(.title2, weight: .bold))
                Text(Self.stub(ticket).month.uppercased())
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
                Text(Formatters.eventDate(ticket.startsAt, timeZone: ticket.timezone))
                    .font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                Text(TicketDetailView.place(ticket)).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted).lineLimit(1)
                HStack(spacing: ETGSpace.sm) {
                    Pill(text: ticket.ticketType)
                    if let seat = ticket.seatLabel { Pill(text: "Seat \(seat)", tint: ETGColor.ink) }
                    if let status = Self.statusLabel(ticket) { Pill(text: status, tint: ETGColor.muted) }
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

    /// A short label for anything other than a usable ticket.
    nonisolated static func statusLabel(_ ticket: Ticket) -> String? {
        switch TicketCodeView.presentation(for: ticket) {
        case .transferred: "Transferred"
        case .void: ticket.status.uppercased() == "REFUNDED" ? "Refunded" : "Cancelled"
        case .checkedIn: "Used"
        case .code, .ended, .vendorCode, .unavailable: nil
        }
    }

    /// Day and month for the stub, in the ticket's own zone.
    static func stub(_ ticket: Ticket) -> (day: String, month: String) {
        var style = Date.FormatStyle()
        style.timeZone = Formatters.venueZone(ticket.timezone)
        return (ticket.startsAt.formatted(style.day()), ticket.startsAt.formatted(style.month(.abbreviated)))
    }
}

// MARK: - Ticket detail

@MainActor
@Observable
final class TicketDetailViewModel {
    private(set) var ticket: Ticket
    /// True while showing the copy passed in (from the list or the offline save) because the
    /// fresh fetch failed.
    private(set) var isSavedCopy = false
    private let repository: any TicketsRepository

    init(ticket: Ticket, repository: any TicketsRepository) {
        self.ticket = ticket
        self.repository = repository
    }

    /// GET /tickets/:id: the server's current answer — status, holder, and whether this
    /// viewer may present it (a transfer since the list loaded withdraws the code).
    func refresh() async {
        do {
            ticket = try await repository.ticket(id: ticket.id)
            isSavedCopy = false
        } catch {
            isSavedCopy = true
        }
    }
}

struct TicketDetailView: View {
    @Environment(AppContainer.self) private var container
    @State private var model: TicketDetailViewModel?
    private let initial: Ticket

    init(ticket: Ticket) { initial = ticket }

    var body: some View {
        let ticket = model?.ticket ?? initial
        ScrollView {
            VStack(spacing: ETGSpace.xl) {
                VStack(spacing: ETGSpace.sm) {
                    Eyebrow(text: ticket.ticketType)
                    Text(ticket.event.title).font(ETGFont.title).multilineTextAlignment(.center)
                    Text(Formatters.eventDate(ticket.startsAt, timeZone: ticket.timezone))
                        .font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                }
                .foregroundStyle(ETGColor.ink)

                TicketCodeView(ticket: ticket)
                    .frame(width: 260, height: 260)
                    .padding(ETGSpace.lg)
                    .background(.white, in: RoundedRectangle(cornerRadius: ETGRadius.card))
                    .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))

                if model?.isSavedCopy == true {
                    Label("Showing the copy saved on this phone.", systemImage: "wifi.slash")
                        .font(ETGFont.caption).foregroundStyle(ETGColor.muted)
                }

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
        .task {
            if model == nil { model = TicketDetailViewModel(ticket: initial, repository: container.tickets) }
            await model?.refresh()
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

/// What the gate sees. Only the server-rendered image, and only when the server lets this
/// viewer present the ticket; the app never draws a code itself.
struct TicketCodeView: View {
    let ticket: Ticket

    enum Presentation: Equatable {
        case code
        case transferred
        /// CANCELLED, REFUNDED or VOID: never a code, whatever else the response carries.
        case void(String)
        case checkedIn
        case ended
        case vendorCode
        case unavailable
    }

    /// TicketStatus (schema.prisma): ACTIVE, TRANSFERRED, CHECKED_IN, CANCELLED, REFUNDED, VOID.
    /// Status is checked before anything else: a refunded ticket must not show a code even if an
    /// image arrives with it.
    nonisolated static func presentation(for ticket: Ticket, now: Date = .now) -> Presentation {
        switch ticket.status.uppercased() {
        case "CANCELLED": return .void("This ticket was cancelled and can't be used for entry.")
        case "REFUNDED": return .void("This ticket was refunded and can't be used for entry.")
        case "VOID": return .void("This ticket is no longer valid.")
        case "TRANSFERRED": return .transferred
        case "CHECKED_IN": return .checkedIn
        default: break
        }
        guard ticket.isPresentable else { return .transferred }
        if ticket.startsAt < now.addingTimeInterval(-OfflineTicketPolicy.graceAfterStart) { return .ended }
        if TicketDetailView.image(fromDataURL: ticket.qrDataUrl) != nil { return .code }
        if ticket.vendorBarcode != nil, (ticket.vendorBarcodeFormat ?? "QR") != "QR" { return .vendorCode }
        return .unavailable
    }

    var body: some View {
        switch Self.presentation(for: ticket) {
        case .code:
            if let image = TicketDetailView.image(fromDataURL: ticket.qrDataUrl) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("Entry code for \(ticket.event.title). Show this at the door.")
            }
        case .transferred:
            message("arrow.right.circle", "This ticket has been transferred. Only its current holder can show it at the door.")
        case let .void(text):
            message("xmark.circle", text)
        case .checkedIn:
            message("checkmark.seal", "Already used for entry. Enjoy the show!")
        case .ended:
            message("clock.badge.checkmark", "This event has ended.")
        case .vendorCode:
            message("barcode", "This venue uses its own barcode, which can't be shown here yet. Show your booking reference at the door.")
        case .unavailable:
            message("qrcode", "This ticket's code isn't available. Show your booking reference at the door.")
        }
    }

    private func message(_ symbol: String, _ text: String) -> some View {
        VStack(spacing: ETGSpace.sm) {
            Image(systemName: symbol).font(.system(size: 44, weight: .light)).accessibilityHidden(true)
            Text(text).font(ETGFont.subheadline).multilineTextAlignment(.center)
        }
        .foregroundStyle(Color(hex: 0x6A6359))
        .accessibilityElement(children: .combine)
    }
}

#Preview("My Tickets") {
    NavigationStack { MyTicketsView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
