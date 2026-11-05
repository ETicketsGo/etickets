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
    @State private var deletingAccount = false

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
                if container.auth.user != nil {
                    NavigationLink(value: Route.bookings) {
                        Label("Booking history", systemImage: "doc.text").foregroundStyle(ETGColor.ink)
                    }
                }
            }

            Section("Support") {
                webLink("Help and support", "questionmark.circle", path: "help")
                webLink("Privacy policy", "lock.shield", path: "privacy")
                webLink("Terms of service", "doc.plaintext", path: "terms")
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
                Section {
                    Button("Delete account", role: .destructive) { deletingAccount = true }
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("profile.deleteAccount")
                } footer: {
                    Text("Permanently deletes your account and signs you out on this phone.")
                }
            }
        }
        .sheet(isPresented: $deletingAccount) { DeleteAccountView() }
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
                Text(user.email ?? "Signed in with your phone number").font(ETGFont.subheadline).foregroundStyle(ETGColor.muted)
            }
        }
        .padding(.vertical, ETGSpace.xs)
        .accessibilityElement(children: .combine)
    }

    /// The website's own page; the MOCK build has no web host and links to production.
    @ViewBuilder
    private func webLink(_ title: String, _ symbol: String, path: String) -> some View {
        if let url = URL(string: "https://\(container.configuration.webHost ?? "eticketsgo.com")/\(path)") {
            Link(destination: url) {
                Label(title, systemImage: symbol).foregroundStyle(ETGColor.ink)
            }
            .accessibilityHint("Opens in your browser")
        }
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

/// Typed confirmation, as on Android: deletion is irreversible and has no undo on the server.
struct DeleteAccountView: View {
    static let confirmationWord = "DELETE"

    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var working = false
    @State private var problem: String?

    var confirmed: Bool { typed.trimmingCharacters(in: .whitespaces) == Self.confirmationWord }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This permanently deletes your ETicketsGo account, your profile and your saved details. Tickets for upcoming events will no longer be available in the app.")
                        .font(ETGFont.body).foregroundStyle(ETGColor.ink)
                }
                Section {
                    TextField("Type \(Self.confirmationWord) to confirm", text: $typed)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("deleteAccount.confirmation")
                } footer: {
                    if let problem {
                        Text(problem).foregroundStyle(ETGColor.critical)
                    }
                }
                Section {
                    Button(role: .destructive) {
                        Task { await delete() }
                    } label: {
                        if working { ProgressView().frame(maxWidth: .infinity) } else {
                            Text("Delete my account").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(!confirmed || working)
                    .accessibilityIdentifier("deleteAccount.submit")
                }
            }
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(working) }
            }
            .interactiveDismissDisabled(working)
        }
    }

    private func delete() async {
        working = true
        defer { working = false }
        switch await container.auth.deleteAccount(pendingCheckout: container.pendingCheckout) {
        case .deleted: dismiss()
        case let .blocked(message), let .failed(message): problem = message
        }
    }
}

#Preview {
    NavigationStack { ProfileView() }
        .environment(AppContainer.preview)
        .environment(AppRouter())
}
