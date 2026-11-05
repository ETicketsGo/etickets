import Foundation
import Testing
@testable import ETicketsGo

/// Real QA account deletion: DELETE /users/me on api-qa, then proof the account is gone.
/// **Irreversible** - so it refuses to run unless every gate is set, and never against the
/// main QA customer:
///
/// - `ETG_QA_ALLOW_ACCOUNT_DELETION=1` - the explicit authorization
/// - `ETG_QA_DELETION_EMAIL` / `ETG_QA_DELETION_PASSWORD` - a disposable QA account created for
///   this run, different from `ETG_QA_EMAIL`
private enum DeletionGate {
    static let env = ProcessInfo.processInfo.environment
    static var enabled: Bool {
        guard env["ETG_QA_ALLOW_ACCOUNT_DELETION"] == "1",
              let email = env["ETG_QA_DELETION_EMAIL"], env["ETG_QA_DELETION_PASSWORD"] != nil
        else { return false }
        return email.lowercased() != env["ETG_QA_EMAIL"]?.lowercased()
    }
}

@Suite("QA account deletion (irreversible; gated)", .enabled(if: DeletionGate.enabled), .serialized)
struct QAAccountDeletionTests {
    @Test("Delete a disposable QA account; it can no longer sign in")
    func deleteDisposableAccount() async throws {
        let email = try #require(DeletionGate.env["ETG_QA_DELETION_EMAIL"])
        let password = try #require(DeletionGate.env["ETG_QA_DELETION_PASSWORD"])
        let config = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api")!,
                                      allowsMutations: true, qaTestAccounts: [email])
        let publicClient = APIClient(configuration: config)
        let store = InMemoryTokenStore()
        let session = AuthSession(store: store, configuration: config) { try await publicClient.send(AuthAPI.refresh($0)) }
        let client = APIClient(configuration: config, tokens: session)
        let auth = RemoteAuthService(publicClient: publicClient, client: client, session: session, configuration: config)

        _ = try await auth.login(email: email, password: password)
        #expect(await auth.deleteAccount() == .deleted)
        #expect(store.read() == nil)
        await #expect(throws: (any Error).self) { _ = try await auth.login(email: email, password: password) }
    }
}
