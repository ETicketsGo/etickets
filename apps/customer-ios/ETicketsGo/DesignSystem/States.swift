import SwiftUI

struct LoadingStateView: View {
    var message = "Loading…"

    var body: some View {
        VStack(spacing: ETGSpace.md) {
            ProgressView().tint(ETGColor.ink)
            Text(message).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 240)
        .accessibilityElement(children: .combine)
    }
}

struct EmptyStateView<Action: View>: View {
    let systemImage: String
    let title: String
    let message: String
    @ViewBuilder var action: () -> Action

    var body: some View {
        VStack(spacing: ETGSpace.md) {
            Image(systemName: systemImage)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(ETGColor.goldText)
                .accessibilityHidden(true)
            Text(title).font(ETGFont.headline).foregroundStyle(ETGColor.ink)
            Text(message)
                .font(ETGFont.subheadline)
                .foregroundStyle(ETGColor.muted)
                .multilineTextAlignment(.center)
            action().padding(.top, ETGSpace.sm)
        }
        .padding(.horizontal, ETGSpace.xxl)
        .frame(maxWidth: .infinity, minHeight: 280)
    }
}

extension EmptyStateView where Action == EmptyView {
    init(systemImage: String, title: String, message: String) {
        self.init(systemImage: systemImage, title: title, message: message) { EmptyView() }
    }
}

struct ErrorStateView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        EmptyStateView(systemImage: "exclamationmark.circle", title: "Couldn't load this", message: message) {
            Button("Try again", action: retry)
                .buttonStyle(.etgSecondary)
                .frame(maxWidth: 200)
        }
    }
}

/// Switches over a `Loadable` so every screen presents loading and failure the same way.
struct LoadableView<Value: Sendable, Content: View>: View {
    let state: Loadable<Value>
    let retry: () -> Void
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        switch state {
        case .idle, .loading:
            LoadingStateView()
        case let .failed(message):
            ErrorStateView(message: message, retry: retry)
        case let .loaded(value):
            content(value)
        }
    }
}

#Preview("States") {
    ScrollView {
        LoadingStateView()
        EmptyStateView(systemImage: "ticket", title: "No tickets yet", message: "Tickets you book appear here.")
        ErrorStateView(message: "You're offline. Check your connection.") {}
    }
    .background(ETGColor.canvas)
}
