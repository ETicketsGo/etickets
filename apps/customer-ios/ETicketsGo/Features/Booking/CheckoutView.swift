import AuthenticationServices
import SwiftUI
import Observation

/// The hold → pay → confirm part of the journey.
///
/// - The hold countdown runs from the server's `holdExpiresAt`.
/// - "Pay" asks the server how to pay (POST /bookings/:id/pay) and hands off to the provider.
/// - Coming back from the provider proves nothing: the booking is CONFIRMED only when the
///   server says so (a verified webhook), so the app polls GET /bookings/:id on a bounded
///   schedule and never issues or assumes tickets.
@MainActor
@Observable
final class CheckoutViewModel {
    enum Phase: Equatable {
        case held
        case startingPayment
        case awaitingProvider(PaymentHandoff)
        case confirming(attempt: Int)
        case stillPending          // the poll budget ran out; the booking may yet confirm
        case confirmed(reference: String?)
        case expired
        case cancelled
        case unsupported(String)
    }

    enum Outcome: Equatable { case confirmed, closed }

    let bookingId: String
    let fees: FeeBreakdown
    let paymentMethod: PaymentMethod
    private(set) var holdExpiresAt: Date?
    private(set) var phase: Phase = .held
    private(set) var error: String?
    private(set) var isCancelling = false

    private let repository: any BookingRepository
    private let environment: AppEnvironment
    /// Seconds between polls: quick at first (webhooks usually land in seconds), then slower,
    /// for about three minutes in total.
    static let pollSchedule: [Double] = Array(repeating: 2, count: 15) + Array(repeating: 5, count: 30)

    init(created: CreatedBooking, repository: any BookingRepository, environment: AppEnvironment) {
        bookingId = created.id
        fees = created.fees
        paymentMethod = created.paymentMethod
        holdExpiresAt = created.holdExpiresAt
        self.repository = repository
        self.environment = environment
        if created.status == "CONFIRMED" { phase = .confirmed(reference: nil) }
    }

    func remaining(at now: Date) -> TimeInterval? {
        holdExpiresAt.map { max(0, $0.timeIntervalSince(now)) }
    }

    /// The countdown reached zero: ask the server rather than assuming.
    func holdTimedOut() async {
        guard phase == .held else { return }
        await refresh()
        if phase == .held { phase = .expired }
    }

    func pay() async {
        guard phase == .held || phase == .stillPending else { return }
        error = nil
        phase = .startingPayment
        do {
            let start = try await repository.startPayment(bookingId: bookingId)
            let handoff = PaymentHandoff.from(start, bookingId: bookingId, environment: environment)
            if case let .unsupported(reason) = handoff {
                phase = .unsupported(reason)
            } else {
                phase = .awaitingProvider(handoff)
            }
        } catch let APIError.server(_, code, message, _) where code == "BOOKING_NOT_PAYABLE" {
            error = message
            await refresh()
        } catch {
            self.error = error.userMessage
            phase = .held
        }
    }

    /// The provider page closed, however it closed. Only the server's status counts.
    func providerFinished() async {
        await poll()
    }

    func poll() async {
        for (attempt, delay) in Self.pollSchedule.enumerated() {
            phase = .confirming(attempt: attempt + 1)
            if await refresh() { return }
            try? await Task.sleep(for: .seconds(delay))
            if Task.isCancelled { return }
        }
        phase = .stillPending
    }

    /// Re-reads the booking. Returns true once it is in a final state.
    @discardableResult
    func refresh() async -> Bool {
        do {
            let booking = try await repository.booking(id: bookingId)
            holdExpiresAt = booking.holdExpiresAt
            switch booking.status {
            case "CONFIRMED": phase = .confirmed(reference: booking.reference); return true
            case "EXPIRED": phase = .expired; return true
            case "CANCELLED": phase = .cancelled; return true
            default: return false
            }
        } catch {
            return false
        }
    }

    func cancel() async {
        guard !isCancelling else { return }
        isCancelling = true
        defer { isCancelling = false }
        do {
            try await repository.cancel(bookingId: bookingId)
            phase = .cancelled
        } catch {
            self.error = error.userMessage
            await refresh()
        }
    }
}

struct CheckoutView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var model: CheckoutViewModel?
    @State private var presentingSimulatedProvider = false
    @State private var confirmingCancel = false
    let created: CreatedBooking
    let title: String
    let onFinish: (CheckoutViewModel.Outcome) -> Void

    var body: some View {
        Group {
            if let model { content(model) } else { LoadingStateView() }
        }
        .etgScreenBackground()
        .navigationTitle("Checkout")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { close() }
            }
        }
        .task {
            if model == nil {
                model = CheckoutViewModel(created: created, repository: container.booking,
                                          environment: container.configuration.environment)
            }
        }
    }

    private func close() {
        if case .confirmed = model?.phase { onFinish(.confirmed) } else { onFinish(.closed) }
        dismiss()
    }

    @ViewBuilder
    private func content(_ model: CheckoutViewModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ETGSpace.xl) {
                if container.configuration.environment == .mock { SimulationBanner() }
                Text(title).font(ETGFont.title).foregroundStyle(ETGColor.ink)
                phaseView(model)
                FeeSummaryView(fees: model.fees, note: "Charged by the payment provider at the amount above. Prices are set by ETicketsGo, not this device.")
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.circle").font(ETGFont.subheadline).foregroundStyle(ETGColor.critical)
                }
            }
            .padding(ETGSpace.gutter)
        }
        .safeAreaInset(edge: .bottom) {
            // No bar at all while waiting on the provider or confirming: an empty bar is a
            // blank white block over the content.
            if Self.hasActions(model.phase) { actions(model) }
        }
        .onChange(of: model.phase) { _, phase in
            guard case let .awaitingProvider(handoff) = phase else { return }
            switch handoff {
            case .simulated: presentingSimulatedProvider = true
            case let .hostedPage(url): Task { await openHosted(url, model) }
            case .unsupported: break
            }
        }
        .sheet(isPresented: $presentingSimulatedProvider, onDismiss: { Task { await model.providerFinished() } }) {
            SimulatedProviderView(amount: Formatters.money(minor: model.fees.totalMinor, currency: model.fees.currency)) { approved in
                if approved { Task { await container.mockCommerce?.providerApproved(bookingId: model.bookingId) } }
                presentingSimulatedProvider = false
            }
            .interactiveDismissDisabled()
        }
        .confirmationDialog("Release these tickets?", isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("Release tickets", role: .destructive) { Task { await model.cancel() } }
        } message: {
            Text("Your hold ends and the tickets go back on sale. Nothing has been charged.")
        }
    }

    static func hasActions(_ phase: CheckoutViewModel.Phase) -> Bool {
        switch phase {
        case .awaitingProvider, .confirming: false
        default: true
        }
    }

    private func openHosted(_ url: URL, _ model: CheckoutViewModel) async {
        // The provider's return URL points at the website today, so the session usually ends by
        // the customer closing it. Either way the next step is the same: ask the server.
        _ = try? await webAuthenticationSession.authenticate(using: url, callbackURLScheme: "etickets")
        await model.providerFinished()
    }

    @ViewBuilder
    private func phaseView(_ model: CheckoutViewModel) -> some View {
        switch model.phase {
        case .held, .startingPayment, .awaitingProvider:
            if model.paymentMethod == .cash {
                StatusCard(symbol: "banknote", title: "Reserved — pay at the venue", message: "Show your booking at the box office to pay and collect entry.")
            } else {
                HoldCountdown(model: model)
            }
        case let .confirming(attempt):
            StatusCard(symbol: "hourglass", title: "Confirming your payment…",
                       message: "Waiting for the payment provider to confirm. This usually takes a few seconds.", progress: true)
                .accessibilityValue("Check \(attempt)")
        case .stillPending:
            StatusCard(symbol: "clock.arrow.circlepath", title: "Still confirming",
                       message: "We haven't heard back from the payment provider yet. If you paid, your tickets will appear in My Tickets once it confirms — you won't be charged twice.")
        case let .confirmed(reference):
            StatusCard(symbol: "checkmark.seal.fill", title: "You're going!",
                       message: reference.map { "Booking \($0). Your tickets are in My Tickets." } ?? "Your tickets are in My Tickets.", tint: ETGColor.success)
        case .expired:
            StatusCard(symbol: "timer", title: "Your hold has ended",
                       message: "The tickets went back on sale. Nothing was charged. You can choose again.", tint: ETGColor.critical)
        case .cancelled:
            StatusCard(symbol: "xmark.circle", title: "Tickets released", message: "Nothing was charged.")
        case let .unsupported(reason):
            StatusCard(symbol: "creditcard", title: "Pay on the website", message: reason)
        }
    }

    @ViewBuilder
    private func actions(_ model: CheckoutViewModel) -> some View {
        VStack(spacing: ETGSpace.sm) {
            switch model.phase {
            case .held, .startingPayment:
                if model.paymentMethod == .online {
                    Button {
                        Task { await model.pay() }
                    } label: {
                        HStack(spacing: ETGSpace.sm) {
                            if model.phase == .startingPayment { ProgressView().tint(ETGColor.onAction) }
                            Text("Pay \(Formatters.money(minor: model.fees.totalMinor, currency: model.fees.currency))")
                        }
                    }
                    .buttonStyle(.etgPrimary)
                    .disabled(model.phase == .startingPayment)
                    .accessibilityIdentifier("checkout.pay")
                    Button("Release tickets") { confirmingCancel = true }
                        .font(ETGFont.subheadline.weight(.semibold)).foregroundStyle(ETGColor.ink)
                        .disabled(model.isCancelling)
                } else {
                    Button("Done") { close() }.buttonStyle(.etgPrimary)
                }
            case .stillPending:
                Button("Check again") { Task { await model.poll() } }.buttonStyle(.etgPrimary)
            case .confirmed:
                Button("View my tickets") { close() }.buttonStyle(.etgPrimary).accessibilityIdentifier("checkout.viewTickets")
            case .expired, .cancelled, .unsupported:
                Button("Back to tickets") { close() }.buttonStyle(.etgPrimary)
            case .awaitingProvider, .confirming:
                EmptyView()
            }
        }
        .padding(.horizontal, ETGSpace.gutter)
        .padding(.top, ETGSpace.md)
        .padding(.bottom, ETGSpace.sm)
        .background(ETGColor.surface.ignoresSafeArea(edges: .bottom))
    }
}

/// The hold timer, from the server's `holdExpiresAt`. When it reaches zero the view asks the
/// server whether the hold really ended.
struct HoldCountdown: View {
    let model: CheckoutViewModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = model.remaining(at: context.date) ?? 0
            let low = remaining < 120
            HStack(spacing: ETGSpace.md) {
                Image(systemName: "timer").font(.title2).foregroundStyle(low ? ETGColor.critical : ETGColor.goldText)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tickets held for you").font(ETGFont.headline).foregroundStyle(ETGColor.ink)
                    Text("Complete payment within \(Self.format(remaining))")
                        .font(ETGFont.subheadline.monospacedDigit())
                        .foregroundStyle(low ? ETGColor.critical : ETGColor.inkSecondary)
                }
                Spacer()
            }
            .padding(ETGSpace.lg)
            .background(ETGColor.sunken, in: RoundedRectangle(cornerRadius: ETGRadius.card))
            .accessibilityElement(children: .combine)
            .onChange(of: remaining == 0) { _, ended in
                if ended { Task { await model.holdTimedOut() } }
            }
        }
    }

    static func format(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded(.up))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

struct StatusCard: View {
    let symbol: String
    let title: String
    let message: String
    var tint: Color = ETGColor.goldText
    var progress = false

    var body: some View {
        HStack(alignment: .top, spacing: ETGSpace.md) {
            if progress { ProgressView().tint(ETGColor.ink) } else {
                Image(systemName: symbol).font(.title2).foregroundStyle(tint).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(ETGFont.headline).foregroundStyle(ETGColor.ink)
                Text(message).font(ETGFont.subheadline).foregroundStyle(ETGColor.inkSecondary)
            }
            Spacer(minLength: 0)
        }
        .padding(ETGSpace.lg)
        .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.card))
        .overlay(RoundedRectangle(cornerRadius: ETGRadius.card).strokeBorder(ETGColor.rule))
        .accessibilityElement(children: .combine)
    }
}

/// MOCK builds: makes it impossible to mistake the demonstration for a real purchase.
struct SimulationBanner: View {
    var body: some View {
        Label("Simulated checkout — no payment is taken and no real tickets are issued.", systemImage: "flask")
            .font(ETGFont.caption.weight(.semibold))
            .foregroundStyle(ETGColor.goldText)
            .padding(ETGSpace.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ETGColor.sunken, in: RoundedRectangle(cornerRadius: ETGRadius.control))
            .overlay(RoundedRectangle(cornerRadius: ETGRadius.control).strokeBorder(ETGColor.gold, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }
}

/// MOCK only: stands in for a provider's hosted checkout page. Approving tells the simulated
/// provider, which confirms the booking on the simulated server a few seconds later — the app
/// still finds out only by polling.
struct SimulatedProviderView: View {
    let amount: String
    let onFinish: (Bool) -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: ETGSpace.xl) {
                SimulationBanner()
                VStack(spacing: ETGSpace.sm) {
                    Image(systemName: "creditcard.and.123").font(.system(size: 44, weight: .light)).foregroundStyle(ETGColor.goldText)
                    Text("Test payment provider").font(ETGFont.title).foregroundStyle(ETGColor.ink)
                    Text("Amount: \(amount)").font(ETGFont.headline).foregroundStyle(ETGColor.inkSecondary)
                }
                Spacer()
                Button("Approve test payment") { onFinish(true) }
                    .buttonStyle(.etgPrimary).accessibilityIdentifier("provider.approve")
                Button("Decline") { onFinish(false) }
                    .buttonStyle(.etgSecondary).accessibilityIdentifier("provider.decline")
            }
            .padding(ETGSpace.gutter)
            .etgScreenBackground()
            .navigationTitle("Secure checkout (simulated)")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
