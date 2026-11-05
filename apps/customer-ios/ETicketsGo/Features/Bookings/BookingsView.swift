import SwiftUI
import Observation

@MainActor
@Observable
final class BookingsViewModel {
    private(set) var state: Loadable<[Booking]> = .idle
    private let repository: any TicketsRepository

    init(repository: any TicketsRepository) { self.repository = repository }

    func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await repository.bookings())
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }
}

/// Booking history (GET /bookings). Read-only.
struct BookingsView: View {
    @Environment(AppContainer.self) private var container
    @State private var model: BookingsViewModel?

    var body: some View {
        ScrollView {
            if let model {
                LoadableView(state: model.state, retry: { Task { await model.load() } }) { bookings in
                    if bookings.isEmpty {
                        EmptyStateView(systemImage: "doc.text", title: "No bookings yet",
                                       message: "Bookings you make appear here with their receipts and tickets.")
                    } else {
                        LazyVStack(spacing: ETGSpace.md) {
                            ForEach(bookings) { booking in
                                NavigationLink(value: Route.booking(booking)) { BookingRow(booking: booking) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(ETGSpace.gutter)
                    }
                }
            }
        }
        .etgScreenBackground()
        .navigationTitle("Bookings")
        .refreshable { await model?.load() }
        .task {
            if model == nil { model = BookingsViewModel(repository: container.tickets) }
            if model?.state.value == nil { await model?.load() }
        }
    }
}

struct BookingRow: View {
    let booking: Booking

    var body: some View {
        HStack(alignment: .top, spacing: ETGSpace.md) {
            VStack(alignment: .leading, spacing: 4) {
                Text(booking.event.title).font(ETGFont.headline).foregroundStyle(ETGColor.ink).lineLimit(2)
                Text(booking.eventSession.startsAt.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).year()))
                    .font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                HStack(spacing: ETGSpace.sm) {
                    BookingStatusPill(status: booking.status)
                    Text("\(booking.ticketCount) \(booking.ticketCount == 1 ? "ticket" : "tickets")")
                        .font(ETGFont.caption).foregroundStyle(ETGColor.muted)
                }
            }
            Spacer()
            Text(Formatters.money(minor: booking.totalMinor, currency: booking.currency))
                .font(ETGFont.subheadline.weight(.semibold)).foregroundStyle(ETGColor.ink)
        }
        .padding(ETGSpace.lg)
        .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))
        .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))
        .accessibilityElement(children: .combine)
    }
}

/// The booking's status in words. Unknown values are shown as the server sent them.
struct BookingStatusPill: View {
    let status: String

    var body: some View {
        let (label, tint) = Self.describe(status)
        Pill(text: label, tint: tint)
    }

    static func describe(_ status: String) -> (String, Color) {
        switch status.uppercased() {
        case "CONFIRMED", "PAID": ("Confirmed", ETGColor.success)
        case "PENDING", "HELD", "AWAITING_PAYMENT": ("Pending", ETGColor.goldText)
        case "CANCELLED", "CANCELED", "EXPIRED": ("Cancelled", ETGColor.muted)
        case "REFUNDED", "PARTIALLY_REFUNDED": ("Refunded", ETGColor.muted)
        default: (Formatters.category(status.lowercased()), ETGColor.muted)
        }
    }
}

// MARK: - Booking detail

@MainActor
@Observable
final class BookingDetailViewModel {
    private(set) var booking: Booking
    private(set) var tickets: Loadable<[Ticket]> = .idle
    private let repository: any TicketsRepository

    init(booking: Booking, repository: any TicketsRepository) {
        self.booking = booking
        self.repository = repository
    }

    func load() async {
        if tickets.value == nil { tickets = .loading }
        if let fresh = try? await repository.booking(id: booking.id) { booking = fresh }
        do {
            let id = booking.id
            tickets = .loaded(try await repository.tickets().filter { $0.bookingId == id })
        } catch {
            if tickets.value == nil { tickets = .failed(error.userMessage) }
        }
    }
}

struct BookingDetailView: View {
    @Environment(AppContainer.self) private var container
    @State private var model: BookingDetailViewModel?
    private let initial: Booking

    init(booking: Booking) { initial = booking }

    var body: some View {
        let booking = model?.booking ?? initial
        ScrollView {
            VStack(alignment: .leading, spacing: ETGSpace.xl) {
                VStack(alignment: .leading, spacing: ETGSpace.sm) {
                    BookingStatusPill(status: booking.status)
                    Text(booking.event.title).font(ETGFont.title).foregroundStyle(ETGColor.ink)
                    Text(booking.eventSession.startsAt.formatted(.dateTime.weekday(.wide).day().month(.wide).year().hour().minute()))
                        .font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                    if let reference = booking.reference {
                        Text("Reference \(reference)").font(ETGFont.subheadline.weight(.semibold)).foregroundStyle(ETGColor.inkSecondary)
                            .textSelection(.enabled)
                    }
                }

                VStack(spacing: ETGSpace.sm) {
                    line("Tickets", booking.subtotalMinor, booking.currency)
                    if booking.customerFeeMinor > 0 { line("Booking fee", booking.customerFeeMinor, booking.currency) }
                    if booking.discountMinor > 0 { line("Discount", -booking.discountMinor, booking.currency) }
                    Divider().overlay(ETGColor.rule)
                    line("Total paid", booking.totalMinor, booking.currency, emphasised: true)
                }
                .padding(ETGSpace.lg)
                .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))

                VStack(alignment: .leading, spacing: ETGSpace.md) {
                    Text("Tickets").font(ETGFont.section).foregroundStyle(ETGColor.ink).accessibilityAddTraits(.isHeader)
                    if let model {
                        LoadableView(state: model.tickets, retry: { Task { await model.load() } }) { tickets in
                            if tickets.isEmpty {
                                Text("No tickets on this booking yet.").font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                            }
                            ForEach(tickets) { ticket in
                                NavigationLink(value: Route.ticket(ticket)) { TicketCard(ticket: ticket) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .padding(ETGSpace.gutter)
        }
        .etgScreenBackground()
        .navigationTitle("Booking")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil { model = BookingDetailViewModel(booking: initial, repository: container.tickets) }
            await model?.load()
        }
    }

    private func line(_ label: String, _ minor: Int, _ currency: String, emphasised: Bool = false) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(Formatters.money(minor: minor, currency: currency))
        }
        .font(emphasised ? ETGFont.headline : ETGFont.subheadline)
        .foregroundStyle(emphasised ? ETGColor.ink : ETGColor.inkSecondary)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Bookings") {
    NavigationStack { BookingsView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
