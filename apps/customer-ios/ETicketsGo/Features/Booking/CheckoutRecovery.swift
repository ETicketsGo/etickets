import SwiftUI

/// Picks up an interrupted checkout — after the app was terminated, or when a payment-return
/// link opens the app. It shows what the SERVER says about the booking and offers the right
/// next step; it never treats the app's own record or a return link as a payment.
struct CheckoutRecoveryBanner: View {
    @Environment(AppContainer.self) private var container
    @Environment(AppRouter.self) private var router
    @State private var booking: Booking?
    @State private var resuming: ReservedBooking?
    @State private var resumePolling = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // A VStack, not a Group: modifiers on an empty Group are dropped, and then the check
        // below would never run while there is nothing to show yet.
        VStack(spacing: 0) {
            if let booking, booking.status == "PENDING_PAYMENT" || booking.status == "CONFIRMED" {
                Button {
                    if booking.status == "CONFIRMED" {
                        container.pendingCheckout.clear(bookingId: booking.id)
                        self.booking = nil
                        router.selectedTab = .tickets
                    } else {
                        resumePolling = container.pendingCheckout.current?.paymentStartedAt != nil || router.paymentReturn != nil
                        resuming = ReservedBooking(booking: BookingDetailView.resumable(booking))
                    }
                } label: {
                    HStack(spacing: ETGSpace.md) {
                        Image(systemName: booking.status == "CONFIRMED" ? "checkmark.seal.fill" : "timer")
                            .foregroundStyle(booking.status == "CONFIRMED" ? ETGColor.success : ETGColor.goldText)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(booking.status == "CONFIRMED" ? "Your booking is confirmed" : "Finish your booking")
                                .font(ETGFont.subheadline.weight(.semibold))
                            Text(booking.event.title).font(ETGFont.caption).lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption)
                    }
                    .foregroundStyle(ETGColor.ink)
                    .padding(ETGSpace.md)
                    .background(ETGColor.surface, in: RoundedRectangle(cornerRadius: ETGRadius.control))
                    .overlay(RoundedRectangle(cornerRadius: ETGRadius.control).strokeBorder(ETGColor.gold))
                    .padding(.horizontal, ETGSpace.gutter)
                    .padding(.vertical, ETGSpace.xs)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("recovery.banner")
            }
        }
        // Re-check whenever the answer could have changed: sign-in, a return link, a checkout
        // closed with tickets still held, or the app coming back to the foreground.
        .task(id: "\(container.auth.sessionKey)|\(router.paymentReturn?.bookingId ?? "")|\(container.pendingCheckout.current?.bookingId ?? "")|\(resuming == nil)|\(scenePhase == .active)") {
            guard resuming == nil else { return }
            await check()
        }
        .fullScreenCover(item: $resuming, onDismiss: { router.paymentReturn = nil; Task { await check() } }) { reserved in
            NavigationStack {
                CheckoutView(created: reserved.booking, title: booking?.event.title ?? "Your booking", resumePolling: resumePolling) { outcome in
                    if outcome == .confirmed { router.paths[router.selectedTab] = []; router.selectedTab = .tickets }
                }
            }
            .environment(container)
            .environment(router)
        }
    }

    private func check() async {
        guard let user = container.auth.user else { booking = nil; return }
        let bookingId = router.paymentReturn?.bookingId ?? container.pendingCheckout.pending(for: user.id)?.bookingId
        guard let bookingId else { booking = nil; return }
        do {
            let latest = try await container.booking.booking(id: bookingId)
            switch latest.status {
            case "PENDING_PAYMENT" where BookingDetailView.canResume(latest), "CONFIRMED":
                booking = latest
                // A return link opens the checkout straight away, polling the server.
                if router.paymentReturn != nil, latest.status == "PENDING_PAYMENT", resuming == nil {
                    resumePolling = true
                    resuming = ReservedBooking(booking: BookingDetailView.resumable(latest))
                }
            default:
                // Expired, cancelled, or no longer payable: nothing to resume.
                container.pendingCheckout.clear(bookingId: bookingId)
                booking = nil
            }
        } catch {
            booking = nil   // can't tell right now; offer nothing rather than guess
        }
    }
}
