import Foundation
import Testing
@testable import ETicketsGo

@Suite("App configuration and the production write guard")
struct ConfigurationTests {
    @Test("Missing or unknown environment falls back to MOCK")
    func fallsBackToMock() {
        #expect(AppConfiguration.load(from: [:]) == .mock)
        #expect(AppConfiguration.load(from: ["ETGEnvironment": "staging"]) == .mock)
    }

    @Test("A non-MOCK build without a valid https URL falls back to MOCK")
    func rejectsBadBaseURL() {
        #expect(AppConfiguration.load(from: ["ETGEnvironment": "qa", "ETGAPIBaseURL": ""]) == .mock)
        #expect(AppConfiguration.load(from: ["ETGEnvironment": "prod", "ETGAPIBaseURL": "http://api.eticketsgo.com/api"]) == .mock)
    }

    @Test("QA reads its base URL and write opt-in")
    func readsQA() {
        let config = AppConfiguration.load(from: [
            "ETGEnvironment": "qa", "ETGAPIBaseURL": "https://api-qa.eticketsgo.com/api", "ETGAllowMutations": "YES",
        ])
        #expect(config.environment == .qa)
        #expect(config.apiBaseURL?.absoluteString == "https://api-qa.eticketsgo.com/api")
        #expect(config.permits(.post))
    }

    @Test("PROD never permits writes, even when the build asks for them")
    func prodIsReadOnly() {
        let config = AppConfiguration.load(from: [
            "ETGEnvironment": "prod", "ETGAPIBaseURL": "https://api.eticketsgo.com/api", "ETGAllowMutations": "YES",
        ])
        #expect(config.environment == .prod)
        #expect(config.permits(.get))
        for method in [HTTPMethod.post, .put, .patch, .delete] {
            #expect(!config.permits(method))
        }
    }

    @Test("QA allowlist matches exact identities only; wildcard entries approve nobody")
    func qaAllowlist() {
        let config = AppConfiguration.load(from: [
            "ETGEnvironment": "qa", "ETGAPIBaseURL": "https://api-qa.eticketsgo.com/api", "ETGAllowMutations": "YES",
            "ETGQATestAccounts": "approved.one@example.test +15550100 *@example.test approved*",
        ])
        #expect(config.isApprovedTestAccount("Approved.One@Example.test "))
        #expect(config.isApprovedTestAccount("+1 555 0100"))
        #expect(!config.isApprovedTestAccount("other@example.test"))  // `*@example.test` is ignored
        #expect(!config.isApprovedTestAccount("approved.two@example.test"))  // `approved*` is ignored
        #expect(!config.isApprovedTestAccount("+15550101"))
        #expect(!config.isApprovedTestAccount(""))
    }

    @Test("An empty allowlist approves nobody in QA; PROD approves nobody; MOCK approves anyone")
    func allowlistDefaults() {
        let qa = AppConfiguration(environment: .qa, apiBaseURL: URL(string: "https://api-qa.eticketsgo.com/api"), allowsMutations: true)
        #expect(!qa.isApprovedTestAccount("anyone@example.com"))
        let prod = AppConfiguration(environment: .prod, apiBaseURL: URL(string: "https://api.eticketsgo.com/api"), allowsMutations: true,
                                    qaTestAccounts: ["anyone@example.com"])
        #expect(!prod.isApprovedTestAccount("anyone@example.com"))
        #expect(AppConfiguration.mock.isApprovedTestAccount("anyone@example.com"))
    }

    @Test("MOCK permits no writes")
    func mockIsReadOnly() {
        #expect(!AppConfiguration.mock.permits(.post))
    }
}
