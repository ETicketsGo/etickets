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
    private(set) var refunds: Loadable<[Refund]> = .idle
    /// True while a refund request is in flight: a second tap sends nothing.
    private(set) var isRequestingRefund = false
    private(set) var refundError: String?
    private let repository: any TicketsRepository

    init(booking: Booking, repository: any TicketsRepository) {
        self.booking = booking
        self.repository = repository
    }

    var refundWindow: RefundWindow { RefundWindow.of(booking) }

    /// Offer a request only inside the event's window and when nothing is already open.
    var canRequestRefund: Bool {
        guard case .open = refundWindow, let refunds = refunds.value else { return false }
        return !refunds.contains(where: \.isOpen) && !isRequestingRefund
    }

    /// POST /refunds, then re-read the booking and its refunds: the server's answer is what shows.
    @discardableResult
    func requestRefund(reason: String) async -> Bool {
        guard !isRequestingRefund, let reason = validRefundReason(reason) else { return false }
        isRequestingRefund = true
        refundError = nil
        defer { isRequestingRefund = false }
        do {
            try await repository.requestRefund(bookingId: booking.id, reason: reason)
        } catch {
            refundError = error.userMessage
            await loadRefunds()
            return false
        }
        if let fresh = try? await repository.booking(id: booking.id) { booking = fresh }
        await loadRefunds()
        return true
    }

    func loadRefunds() async {
        guard booking.status.uppercased() != "PENDING_PAYMENT" else { refunds = .loaded([]); return }
        if refunds.value == nil { refunds = .loading }
        do {
            refunds = .loaded(try await repository.refunds(bookingId: booking.id))
        } catch {
            if refunds.value == nil { refunds = .failed(error.userMessage) }
        }
    }

    func load() async {
        if tickets.value == nil { tickets = .loading }
        if let fresh = try? await repository.booking(id: booking.id) { booking = fresh }
        await loadRefunds()
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
    @Environment(AppRouter.self) private var router
    @State private var model: BookingDetailViewModel?
    @State private var resuming: ReservedBooking?
    @State private var askingRefund = false
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
                    if Self.canResume(booking) {
                        Button("Continue checkout") { resuming = ReservedBooking(booking: Self.resumable(booking)) }
                            .buttonStyle(.etgPrimary)
                            .padding(.top, ETGSpace.sm)
                            .accessibilityIdentifier("booking.resume")
                    }
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

                if let model, booking.status != "PENDING_PAYMENT" {
                    RefundSection(model: model, askingRefund: $askingRefund)
                }

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
        .sheet(isPresented: $askingRefund) {
            if let model { RefundRequestSheet(model: model) }
        }
        .fullScreenCover(item: $resuming, onDismiss: { Task { await model?.load() } }) { reserved in
            NavigationStack {
                CheckoutView(created: reserved.booking, title: booking.event.title) { outcome in
                    if outcome == .confirmed { router.paths[router.selectedTab] = []; router.selectedTab = .tickets }
                }
            }
            .environment(container)
            .environment(router)
        }
    }

    /// An interrupted checkout: still pending and the server's hold has time left.
    static func canResume(_ booking: Booking, now: Date = .now) -> Bool {
        booking.status == "PENDING_PAYMENT" && (booking.holdExpiresAt.map { $0 > now } ?? false)
    }

    /// The checkout screen's input, from the booking's own server-side amounts.
    static func resumable(_ booking: Booking) -> CreatedBooking {
        CreatedBooking(
            id: booking.id, status: booking.status, currency: booking.currency, holdExpiresAt: booking.holdExpiresAt,
            fees: FeeBreakdown(currency: booking.currency, subtotalMinor: booking.subtotalMinor, discountMinor: booking.discountMinor,
                               netSubtotalMinor: booking.subtotalMinor, bookingFeeMinor: booking.bookingFeeMinor,
                               paymentFeeMinor: booking.paymentFeeMinor, customerFeeMinor: booking.customerFeeMinor, taxLines: [],
                               taxMinor: 0, maintenanceMinor: nil, totalMinor: booking.totalMinor, isItemised: false),
            paymentMethod: .online, payment: nil)
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

// MARK: - Refunds

/// The booking's refunds and, when the event's terms allow it, the way to ask for one. Every
/// figure and status is the server's.
struct RefundSection: View {
    let model: BookingDetailViewModel
    @Binding var askingRefund: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: ETGSpace.md) {
            Text("Refunds").font(ETGFont.section).foregroundStyle(ETGColor.ink).accessibilityAddTraits(.isHeader)
            LoadableView(state: model.refunds, retry: { Task { await model.loadRefunds() } }) { refunds in
                ForEach(refunds) { refund in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(refund.statusLabel).font(ETGFont.subheadline.weight(.semibold)).foregroundStyle(ETGColor.ink)
                            Text("Requested \(refund.createdAt.formatted(date: .abbreviated, time: .omitted))")
                                .font(ETGFont.caption).foregroundStyle(ETGColor.muted)
                        }
                        Spacer()
                        if let amount = refund.amountMinor {
                            Text(Formatters.money(minor: amount, currency: refund.currency ?? model.booking.currency))
                                .font(ETGFont.subheadline).foregroundStyle(ETGColor.inkSecondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("refund.row")
                }
                windowText
                if model.canRequestRefund {
                    Button("Request a refund") { askingRefund = true }
                        .buttonStyle(.etgSecondary)
                        .accessibilityIdentifier("refund.request")
                }
            }
            if let policy = model.booking.event.refundPolicy, !policy.isEmpty {
                Text(policy).font(ETGFont.caption).foregroundStyle(ETGColor.muted)
            }
        }
        .padding(ETGSpace.lg)
        .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))
    }

    @ViewBuilder private var windowText: some View {
        let refunds = model.refunds.value ?? []
        switch model.refundWindow {
        case let .open(closesAt) where !refunds.contains(where: \.isOpen):
            Text("You can ask for a refund until \(closesAt.formatted(date: .abbreviated, time: .shortened)). The organizer decides, and the amount is confirmed when it is processed.")
                .font(ETGFont.subheadline).foregroundStyle(ETGColor.inkSecondary)
        case .open:
            Text("Your refund request is being handled. You will see its progress here.")
                .font(ETGFont.subheadline).foregroundStyle(ETGColor.inkSecondary)
        case .closed:
            if refunds.isEmpty {
                Text("Refund requests for this event have closed.").font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
            }
        case .notOffered:
            if refunds.isEmpty {
                Text("This event does not offer refunds.").font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
            }
        case .notApplicable:
            EmptyView()
        }
    }
}

/// Reason and confirmation. The server requires a reason (3 to 500 characters).
struct RefundRequestSheet: View {
    let model: BookingDetailViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Ask the organizer to refund this booking (\(Formatters.money(minor: model.booking.totalMinor, currency: model.booking.currency)) paid). They decide, and the amount you get back is confirmed when the refund is processed.")
                        .font(ETGFont.subheadline).foregroundStyle(ETGColor.inkSecondary)
                }
                Section {
                    TextField("Why are you asking for a refund?", text: $reason, axis: .vertical)
                        .lineLimit(3...6)
                        .accessibilityIdentifier("refund.reason")
                } footer: {
                    if let error = model.refundError {
                        Text(error).foregroundStyle(ETGColor.critical)
                    } else {
                        Text("At least 3 characters.")
                    }
                }
                Section {
                    Button {
                        Task { if await model.requestRefund(reason: reason) { dismiss() } }
                    } label: {
                        if model.isRequestingRefund { ProgressView().frame(maxWidth: .infinity) } else {
                            Text("Send refund request").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(validRefundReason(reason) == nil || model.isRequestingRefund)
                    .accessibilityIdentifier("refund.submit")
                }
            }
            .navigationTitle("Request a refund")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.isRequestingRefund) }
            }
            .interactiveDismissDisabled(model.isRequestingRefund)
        }
    }
}
