import SwiftUI
import Observation

/// Ticket choice → server quote → reserve. The view model sends the customer's selection and
/// shows the server's answers; it computes no prices. The steppers' caps are display hints
/// (min(available, maxPerOrder)); the server enforces the real limits when the hold is made.
@MainActor
@Observable
final class TicketSelectionViewModel {
    let event: EventDetail
    var sessionId: String { didSet { if oldValue != sessionId { resetSelection() } } }
    private(set) var quantities: [String: Int] = [:]
    private(set) var seats: [SeatMap.Seat] = []          // chosen seats, in tap order
    private(set) var seatMap: Loadable<SeatMap> = .idle
    private(set) var quote: Loadable<Quote> = .idle
    var paymentMethod: PaymentMethod = .online
    private(set) var isReserving = false
    private(set) var reserveError: String?
    private(set) var reserved: CreatedBooking?

    /// One per attempt; reused on retry so a resent request cannot create a second booking.
    private var idempotencyKey = UUID().uuidString
    private let repository: any BookingRepository
    private let configuration: AppConfiguration

    init(event: EventDetail, sessionId: String? = nil, repository: any BookingRepository, configuration: AppConfiguration) {
        self.event = event
        self.sessionId = sessionId ?? EventDetailViewModel.upcomingSessions(event).first?.id ?? event.sessions.first?.id ?? ""
        self.repository = repository
        self.configuration = configuration
    }

    var session: EventSession? { event.sessions.first { $0.id == sessionId } }
    var isSeated: Bool { session?.seatBased == true }
    var acceptsCash: Bool { event.cashAccepted == true }
    var bookingEnabled: Bool { configuration.bookingWritesPermitted }

    var items: [BookingItem] {
        if isSeated, case let .loaded(map) = seatMap {
            let categories = Dictionary(uniqueKeysWithValues: (map.categories ?? []).map { ($0.id, $0.ticketTypeId) })
            let grouped = Dictionary(grouping: seats) { categories[$0.categoryId ?? ""] ?? "" }
            return grouped.filter { !$0.key.isEmpty }.sorted { $0.key < $1.key }
                .map { BookingItem(ticketTypeId: $0.key, quantity: $0.value.count, seatIds: $0.value.map(\.id)) }
        }
        return quantities.filter { $0.value > 0 }.sorted { $0.key < $1.key }
            .map { BookingItem(ticketTypeId: $0.key, quantity: $0.value, seatIds: nil) }
    }

    var ticketCount: Int { items.reduce(0) { $0 + $1.quantity } }

    /// Display cap only; the server decides at reservation time.
    func cap(_ type: TicketTypeOption) -> Int { max(0, min(type.available, type.maxPerOrder)) }

    func quantity(_ type: TicketTypeOption) -> Int { quantities[type.id] ?? 0 }

    func setQuantity(_ type: TicketTypeOption, _ value: Int) {
        quantities[type.id] = min(max(0, value), cap(type))
        selectionChanged()
    }

    func toggle(_ seat: SeatMap.Seat) {
        guard seat.isSelectable else { return }
        if let index = seats.firstIndex(of: seat) { seats.remove(at: index) } else if seats.count < 10 { seats.append(seat) }
        selectionChanged()
    }

    func isSelected(_ seat: SeatMap.Seat) -> Bool { seats.contains(seat) }

    func loadSeatMap() async {
        guard isSeated else { return }
        seatMap = .loading
        do {
            seatMap = .loaded(try await repository.seatMap(sessionId: sessionId, section: nil))
        } catch {
            seatMap = .failed(error.userMessage)
        }
    }

    /// POST /bookings/quote for the current selection. Debounced by the caller.
    func refreshQuote() async {
        let items = self.items
        guard !items.isEmpty else { quote = .idle; return }
        quote = .loading
        do {
            let result = try await repository.quote(QuoteBody(eventSessionId: sessionId, items: items, couponCode: nil))
            guard items == self.items else { return }   // selection moved on while we waited
            quote = .loaded(result)
        } catch is CancellationError {
        } catch {
            quote = .failed(error.userMessage)
        }
    }

    /// POST /bookings. Disabled while in flight, so a double tap cannot send twice; the
    /// idempotency key makes a network retry safe as well.
    func reserve(buyer: AuthenticatedUser) async {
        guard !isReserving, !items.isEmpty else { return }
        isReserving = true
        reserveError = nil
        defer { isReserving = false }
        do {
            reserved = try await repository.createBooking(
                CreateBookingBody(eventSessionId: sessionId, items: items, buyerName: buyer.fullName,
                                  buyerEmail: buyer.email, paymentMethod: paymentMethod, couponCode: nil),
                idempotencyKey: idempotencyKey)
            idempotencyKey = UUID().uuidString
        } catch let APIError.server(status, code, message, _) where status == 409 {
            // Someone took a seat or the last tickets first: re-read availability.
            reserveError = message ?? "Some of those tickets were just taken. Please choose again."
            idempotencyKey = UUID().uuidString
            if code == "BOOKING_INVENTORY_UNAVAILABLE", isSeated {
                seats = []
                await loadSeatMap()
            }
            quote = .idle
        } catch let error as BookingError {
            reserveError = error.userMessage
        } catch {
            // Network or server failure: keep the same key, so "Try again" cannot double-book.
            reserveError = error.userMessage
        }
    }

    func clearReservation() { reserved = nil }

    private func selectionChanged() {
        reserveError = nil
        idempotencyKey = UUID().uuidString
    }

    private func resetSelection() {
        quantities = [:]
        seats = []
        quote = .idle
        seatMap = .idle
        selectionChanged()
    }
}

struct TicketSelectionView: View {
    @Environment(AppContainer.self) private var container
    @Environment(AppRouter.self) private var router
    @State private var model: TicketSelectionViewModel?
    let event: EventDetail
    var preselectedSessionId: String?

    var body: some View {
        Group {
            if let model { content(model) } else { LoadingStateView() }
        }
        .etgScreenBackground()
        .navigationTitle("Choose tickets")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                model = TicketSelectionViewModel(event: event, sessionId: preselectedSessionId,
                                                 repository: container.booking, configuration: container.configuration)
            }
        }
    }

    private func content(_ model: TicketSelectionViewModel) -> some View {
        @Bindable var model = model
        return ScrollView {
            VStack(alignment: .leading, spacing: ETGSpace.xl) {
                VStack(alignment: .leading, spacing: ETGSpace.xs) {
                    Eyebrow(text: Formatters.category(event.category))
                    Text(event.title).font(ETGFont.title).foregroundStyle(ETGColor.ink)
                    Text("\(event.venue.name), \(event.venue.city)").font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                }

                sessionPicker(model)

                if model.isSeated {
                    SeatPicker(model: model, currency: model.session?.ticketTypes.first?.currency ?? "INR")
                } else {
                    ticketTypes(model)
                }

                if !model.items.isEmpty {
                    VStack(alignment: .leading, spacing: ETGSpace.md) {
                        Text("Summary").font(ETGFont.section).foregroundStyle(ETGColor.ink).accessibilityAddTraits(.isHeader)
                        LoadableView(state: model.quote, retry: { Task { await model.refreshQuote() } }) { quote in
                            FeeSummaryView(fees: quote.fees, note: "Estimated. Your total is confirmed when you reserve.")
                        }
                    }
                }

                if model.acceptsCash {
                    Picker("Payment", selection: $model.paymentMethod) {
                        Text("Pay online").tag(PaymentMethod.online)
                        Text("Pay at venue").tag(PaymentMethod.cash)
                    }
                    .pickerStyle(.segmented)
                }
            }
            .padding(ETGSpace.gutter)
        }
        .safeAreaInset(edge: .bottom) { reserveBar(model) }
        // Re-quote whenever the selection changes, after the customer pauses.
        .task(id: model.items) {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await model.refreshQuote()
        }
        .task(id: model.sessionId) { await model.loadSeatMap() }
        .fullScreenCover(item: Binding(get: { model.reserved.map(ReservedBooking.init) }, set: { if $0 == nil { model.clearReservation() } })) { reserved in
            NavigationStack {
                CheckoutView(created: reserved.booking, title: event.title) { outcome in
                    model.clearReservation()
                    if outcome == .confirmed {
                        router.paths[router.selectedTab] = []
                        router.selectedTab = .tickets
                    }
                }
            }
            .environment(container)
            .environment(router)
        }
    }

    private func sessionPicker(_ model: TicketSelectionViewModel) -> some View {
        let sessions = EventDetailViewModel.upcomingSessions(event)
        return VStack(alignment: .leading, spacing: ETGSpace.sm) {
            Text("Date and time").font(ETGFont.headline).foregroundStyle(ETGColor.ink)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: ETGSpace.sm) {
                    ForEach(sessions) { session in
                        let when = Formatters.dayAndTime(session.startsAt, timeZone: session.timeZone ?? event.timeZone)
                        FilterChip(title: "\(when.day) · \(when.time)", isSelected: session.id == model.sessionId) {
                            model.sessionId = session.id
                        }
                    }
                }
            }
        }
    }

    private func ticketTypes(_ model: TicketSelectionViewModel) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.md) {
            Text("Tickets").font(ETGFont.headline).foregroundStyle(ETGColor.ink)
            ForEach(model.session?.ticketTypes ?? []) { type in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(type.name).font(ETGFont.headline).foregroundStyle(ETGColor.ink)
                        Text(type.priceMinor == 0 ? "Free" : Formatters.money(minor: type.priceMinor, currency: type.currency))
                            .font(ETGFont.subheadline).foregroundStyle(ETGColor.inkSecondary)
                        if model.cap(type) == 0 {
                            Text("Sold out").font(ETGFont.caption.weight(.semibold)).foregroundStyle(ETGColor.critical)
                        } else if type.available <= 10 {
                            Text("Only \(type.available) left").font(ETGFont.caption).foregroundStyle(ETGColor.goldText)
                        }
                    }
                    Spacer()
                    QuantityStepper(value: model.quantity(type), maximum: model.cap(type), label: type.name) {
                        model.setQuantity(type, $0)
                    }
                }
                .padding(ETGSpace.lg)
                .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))
                .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))
            }
        }
    }

    private func reserveBar(_ model: TicketSelectionViewModel) -> some View {
        VStack(spacing: ETGSpace.sm) {
            if let error = model.reserveError {
                Text(error).font(ETGFont.subheadline).foregroundStyle(ETGColor.critical).multilineTextAlignment(.center)
            }
            // Booking switched off for this build comes first: asking someone to sign in to do
            // something the build can't do anyway leads nowhere.
            if !model.bookingEnabled {
                Text("Booking is switched off in this build. Prices and availability shown are live.")
                    .font(ETGFont.caption).foregroundStyle(ETGColor.muted).multilineTextAlignment(.center)
                Button("Reserve tickets") {}.buttonStyle(.etgPrimary).disabled(true)
            } else if container.auth.user == nil {
                Button("Sign in to book") { container.auth.isPresentingSignIn = true }
                    .buttonStyle(.etgPrimary)
            } else {
                Button {
                    guard let user = container.auth.user else { return }
                    Task { await model.reserve(buyer: user) }
                } label: {
                    HStack(spacing: ETGSpace.sm) {
                        if model.isReserving { ProgressView().tint(ETGColor.onAction) }
                        Text(model.ticketCount == 0 ? "Choose tickets" : "Reserve \(model.ticketCount) \(model.ticketCount == 1 ? "ticket" : "tickets")")
                    }
                }
                .buttonStyle(.etgPrimary)
                .disabled(model.ticketCount == 0 || model.isReserving || model.quote.value == nil)
                .accessibilityIdentifier("booking.reserve")
            }
        }
        .padding(.horizontal, ETGSpace.gutter)
        .padding(.top, ETGSpace.md)
        .padding(.bottom, ETGSpace.sm)
        .background(ETGColor.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(ETGColor.rule).frame(height: 1) }
    }
}

/// Identifiable wrapper so a reservation can drive a full-screen cover.
struct ReservedBooking: Identifiable {
    let booking: CreatedBooking
    var id: String { booking.id }
}

struct QuantityStepper: View {
    let value: Int
    let maximum: Int
    let label: String
    let onChange: (Int) -> Void

    var body: some View {
        HStack(spacing: ETGSpace.md) {
            stepButton("minus", enabled: value > 0) { onChange(value - 1) }
                .accessibilityLabel("Remove one \(label)")
            Text("\(value)").font(ETGFont.headline.monospacedDigit()).frame(minWidth: 24)
                .foregroundStyle(ETGColor.ink)
                .accessibilityLabel("\(value) \(label)")
            stepButton("plus", enabled: value < maximum) { onChange(value + 1) }
                .accessibilityLabel("Add one \(label)")
        }
    }

    private func stepButton(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(.body, weight: .semibold))
                .frame(width: 40, height: 40)
                .foregroundStyle(enabled ? ETGColor.ink : ETGColor.ruleStrong)
                .overlay(Circle().strokeBorder(enabled ? ETGColor.ink : ETGColor.rule))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// The server's breakdown, line for line. No arithmetic: every number shown is a field of the
/// response.
struct FeeSummaryView: View {
    let fees: FeeBreakdown
    var note: String?

    var body: some View {
        VStack(spacing: ETGSpace.sm) {
            line("Tickets", fees.subtotalMinor)
            if fees.discountMinor > 0 { line("Discount", -fees.discountMinor) }
            if fees.customerFeeMinor > 0 { line("Booking & payment fees", fees.customerFeeMinor) }
            ForEach(fees.taxLines, id: \.self) { tax in line(tax.label, tax.amountMinor) }
            if let maintenance = fees.maintenanceMinor, maintenance > 0 { line("Maintenance charge", maintenance) }
            Divider().overlay(ETGColor.rule)
            line("Total", fees.totalMinor, emphasised: true)
            if let note {
                Text(note).font(ETGFont.caption).foregroundStyle(ETGColor.muted).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(ETGSpace.lg)
        .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))
        .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))
    }

    private func line(_ label: String, _ minor: Int, emphasised: Bool = false) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(minor == 0 && label == "Tickets" ? "Free" : Formatters.money(minor: minor, currency: fees.currency))
                .monospacedDigit()
        }
        .font(emphasised ? ETGFont.headline : ETGFont.subheadline)
        .foregroundStyle(emphasised ? ETGColor.ink : ETGColor.inkSecondary)
        .accessibilityElement(children: .combine)
    }
}

/// Reserved seating from GET /public/shows/:id/seats. Only AVAILABLE seats can be chosen.
struct SeatPicker: View {
    let model: TicketSelectionViewModel
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: ETGSpace.md) {
            Text("Seats").font(ETGFont.headline).foregroundStyle(ETGColor.ink)
            LoadableView(state: model.seatMap, retry: { Task { await model.loadSeatMap() } }) { map in
                VStack(alignment: .leading, spacing: ETGSpace.md) {
                    Text("SCREEN").font(ETGFont.eyebrow).tracking(2).foregroundStyle(ETGColor.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .overlay(alignment: .bottom) { Capsule().fill(ETGColor.ruleStrong).frame(height: 3) }
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(map.sections) { section in
                                ForEach(section.rows ?? [], id: \.label) { row in
                                    HStack(spacing: 6) {
                                        Text(row.label).font(ETGFont.caption.weight(.semibold)).foregroundStyle(ETGColor.muted)
                                            .frame(width: 16)
                                        ForEach(row.seats) { seat in seatButton(seat, row: row.label, map: map) }
                                    }
                                }
                            }
                        }
                    }
                    legend(map)
                    if map.sections.contains(where: { $0.rows == nil }) {
                        Text("This venue lists seats by section. Section choice arrives in a later release.")
                            .font(ETGFont.caption).foregroundStyle(ETGColor.muted)
                    }
                }
            }
        }
    }

    private func seatButton(_ seat: SeatMap.Seat, row: String, map: SeatMap) -> some View {
        let selected = model.isSelected(seat)
        let premium = map.categories?.first { $0.id == seat.categoryId }?.colorHex != nil
        return Button { model.toggle(seat) } label: {
            RoundedRectangle(cornerRadius: 5)
                .fill(selected ? ETGColor.gold : seat.isSelectable ? (premium ? ETGColor.sunken : ETGColor.surface) : ETGColor.rule)
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(seat.isSelectable ? ETGColor.ruleStrong : .clear))
                .overlay(seat.isSelectable ? nil : Image(systemName: "xmark").font(.system(size: 8)).foregroundStyle(ETGColor.muted))
                .frame(width: 26, height: 26)
        }
        .buttonStyle(.plain)
        .disabled(!seat.isSelectable)
        .accessibilityLabel("Row \(row), seat \(seat.label)")
        .accessibilityValue(selected ? "Selected" : seat.isSelectable ? "Available" : "Unavailable")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func legend(_ map: SeatMap) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.xs) {
            HStack(spacing: ETGSpace.lg) {
                swatch(ETGColor.surface, "Available")
                swatch(ETGColor.gold, "Selected")
                swatch(ETGColor.rule, "Taken")
            }
            ForEach(map.categories ?? []) { category in
                Text("\(category.name) · \(Formatters.money(minor: category.priceMinor, currency: currency))")
                    .font(ETGFont.caption).foregroundStyle(ETGColor.muted)
            }
        }
        .font(ETGFont.caption)
    }

    private func swatch(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 3).fill(color).frame(width: 12, height: 12)
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ETGColor.ruleStrong))
            Text(label).foregroundStyle(ETGColor.muted)
        }
    }
}
