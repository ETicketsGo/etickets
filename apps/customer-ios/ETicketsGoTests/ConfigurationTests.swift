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

    @Test("PROD permits no writes when only ALLOW_MUTATIONS is set")
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

    @Test("PROD writes need both switches; bookings and checkout each need their own on top")
    func prodLaunchSwitches() {
        let base: [String: Any] = ["ETGEnvironment": "prod", "ETGAPIBaseURL": "https://api.eticketsgo.com/api"]
        func load(_ extra: [String: String]) -> AppConfiguration { AppConfiguration.load(from: base.merging(extra) { $1 }) }

        let launchOnly = load(["ETGProdLaunchApproved": "YES"])
        #expect(!launchOnly.permits(.post))
        #expect(!launchOnly.isApprovedTestAccount("anyone@gmail.com"))

        let accounts = load(["ETGAllowMutations": "YES", "ETGProdLaunchApproved": "YES"])
        #expect(accounts.permits(.post) && accounts.permits(.delete))
        #expect(accounts.isApprovedTestAccount("anyone@gmail.com"))
        #expect(!accounts.bookingWritesPermitted)
        #expect(!accounts.nativeCheckoutPermitted)

        let booking = load(["ETGAllowMutations": "YES", "ETGProdLaunchApproved": "YES", "ETGAllowBookingWrites": "YES"])
        #expect(booking.bookingWritesPermitted)
        #expect(!booking.nativeCheckoutPermitted)

        let all = load(["ETGAllowMutations": "YES", "ETGProdLaunchApproved": "YES", "ETGAllowBookingWrites": "YES", "ETGNativeCheckout": "YES"])
        #expect(all.nativeCheckoutPermitted)

        // Booking and checkout switches alone open nothing.
        let noLaunch = load(["ETGAllowMutations": "YES", "ETGAllowBookingWrites": "YES", "ETGNativeCheckout": "YES"])
        #expect(!noLaunch.bookingWritesPermitted && !noLaunch.nativeCheckoutPermitted)
        // The launch switch means nothing outside PROD.
        let qa = AppConfiguration.load(from: ["ETGEnvironment": "qa", "ETGAPIBaseURL": "https://api-qa.eticketsgo.com/api",
                                              "ETGProdLaunchApproved": "YES"])
        #expect(!qa.prodLaunchApproved && !qa.isApprovedTestAccount("anyone@gmail.com"))
    }

    @Test("The shipped Prod build settings keep every production write off")
    func shippedProdIsOff() {
        // Unit tests run in the Mock build; the Prod values are checked from the xcconfig text.
        let prod = (try? String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Config/Prod.xcconfig"), encoding: .utf8)) ?? ""
        for key in ["ALLOW_MUTATIONS", "PROD_LAUNCH_APPROVED", "ALLOW_BOOKING_WRITES", "NATIVE_CHECKOUT"] {
            #expect(prod.contains("\n\(key) = NO"), "\(key) must ship as NO in Prod.xcconfig")
        }
        #expect(prod.contains("PRODUCT_BUNDLE_IDENTIFIER = com.eticketsgo.customer\n"))
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
