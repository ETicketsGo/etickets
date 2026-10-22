import SwiftUI
import Observation

@MainActor
@Observable
final class ProfileViewModel {
    private(set) var state: Loadable<AuthenticatedUser?> = .idle
    private let account: any AccountRepository

    init(account: any AccountRepository) { self.account = account }

    func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await account.currentUser())
        } catch {
            state = .failed(error.userMessage)
        }
    }

    static func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first)
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }
}

struct ProfileView: View {
    @Environment(AppContainer.self) private var container
    @State private var model: ProfileViewModel?

    var body: some View {
        List {
            if let model {
                Section {
                    switch model.state {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity)
                    case let .failed(message):
                        Text(message).foregroundStyle(ETGColor.critical)
                    case .loaded(nil):
                        VStack(alignment: .leading, spacing: ETGSpace.sm) {
                            Text("You're browsing as a guest").font(ETGFont.headline)
                            Text("Sign-in arrives in the next release.").font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
                        }
                        .padding(.vertical, ETGSpace.xs)
                    case let .loaded(user?):
                        identity(user)
                    }
                }
            }

            Section("Account") {
                comingSoon("Edit profile", "person")
                comingSoon("Notifications", "bell")
                comingSoon("Payment receipts", "doc.text")
            }

            Section("Support") {
                comingSoon("Help and support", "questionmark.circle")
                comingSoon("Privacy and terms", "lock.shield")
            }

            Section {
                LabeledContent("Environment", value: container.configuration.environment.displayName)
                LabeledContent("Server", value: container.configuration.apiBaseURL?.host() ?? "Bundled sample data")
                LabeledContent("Writes", value: container.configuration.permits(.post) ? "Allowed" : "Blocked")
                LabeledContent("Version", value: Self.version)
            } header: {
                Text("About this build")
            } footer: {
                Text("Business rules — prices, availability, ticket validity — are always decided by the ETicketsGo server.")
            }
        }
        .scrollContentBackground(.hidden)
        .etgScreenBackground()
        .navigationTitle("Profile")
        .refreshable { await model?.load() }
        .task {
            if model == nil { model = ProfileViewModel(account: container.account) }
            if model?.state.value == nil { await model?.load() }
        }
    }

    private func identity(_ user: AuthenticatedUser) -> some View {
        HStack(spacing: ETGSpace.md) {
            Text(ProfileViewModel.initials(user.fullName))
                .font(.system(.headline, weight: .bold))
                .foregroundStyle(ETGColor.onAction)
                .frame(width: 52, height: 52)
                .background(ETGColor.action, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(user.fullName).font(ETGFont.headline).foregroundStyle(ETGColor.ink)
                Text(user.email).font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
            }
        }
        .padding(.vertical, ETGSpace.xs)
        .accessibilityElement(children: .combine)
    }

    private func comingSoon(_ title: String, _ symbol: String) -> some View {
        HStack {
            Label(title, systemImage: symbol).foregroundStyle(ETGColor.ink)
            Spacer()
            Text("Soon").font(ETGFont.caption).foregroundStyle(ETGColor.muted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Not available yet")
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}

#Preview {
    NavigationStack { ProfileView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
