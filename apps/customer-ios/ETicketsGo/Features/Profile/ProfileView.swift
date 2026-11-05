import SwiftUI
import Observation

enum ProfileFormat {
    static func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first)
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }
}

struct ProfileView: View {
    @Environment(AppContainer.self) private var container
    @State private var confirmingSignOut = false

    var body: some View {
        List {
            Section {
                switch container.auth.state {
                case .restoring:
                    ProgressView().frame(maxWidth: .infinity)
                case .signedOut:
                    VStack(alignment: .leading, spacing: ETGSpace.md) {
                        Text("You're browsing as a guest").font(ETGFont.headline).foregroundStyle(ETGColor.ink)
                        if container.auth.sessionExpired {
                            Text("Your session ended. Please sign in again.")
                                .font(ETGFont.subheadline).foregroundStyle(ETGColor.critical)
                        }
                        Button("Sign in or create account") { container.auth.isPresentingSignIn = true }
                            .buttonStyle(.etgPrimary)
                    }
                    .padding(.vertical, ETGSpace.xs)
                case let .signedIn(user):
                    identity(user)
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

            if container.auth.user != nil {
                Section {
                    Button("Sign out", role: .destructive) { confirmingSignOut = true }
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .confirmationDialog("Sign out of ETicketsGo?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await container.auth.logout() } }
        } message: {
            Text("Your tickets stay in your account. You'll need to sign in again to see them.")
        }
        .scrollContentBackground(.hidden)
        .etgScreenBackground()
        .navigationTitle("Profile")

    }

    private func identity(_ user: AuthenticatedUser) -> some View {
        HStack(spacing: ETGSpace.md) {
            Text(ProfileFormat.initials(user.fullName))
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
