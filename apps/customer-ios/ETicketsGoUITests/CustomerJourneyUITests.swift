import XCTest

/// Simulator UI regression tests for the main customer journeys, against the MOCK build.
/// Each test starts signed out with nothing saved (`-ETGResetSession`), so tests are
/// independent of order and of what a previous run left in the Keychain.
@MainActor
final class CustomerJourneyUITests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ETGResetSession"] + arguments
        app.launch()
        return app
    }

    /// Any element whose accessibility label contains `text`.
    private func element(containing text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testHomeShowsBrandShelvesAndTabs() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["What's on"].waitForExistence(timeout: 10))
        XCTAssertTrue(element(containing: "ETicketsGo", in: app).exists)
        XCTAssertTrue(app.staticTexts["Now showing"].waitForExistence(timeout: 5))
        for tab in ["Home", "Explore", "Movies", "Tickets", "Profile"] {
            XCTAssertTrue(app.buttons[tab].exists, "missing tab \(tab)")
        }
    }

    func testExploreSearchFindsAnEvent() {
        let app = launch(["-ETGTab", "explore"])
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("jazz")
        XCTAssertTrue(element(containing: "Monsoon Jazz Nights", in: app).waitForExistence(timeout: 5))
        XCTAssertFalse(element(containing: "Laugh Riot", in: app).exists)
    }

    func testEventDetailShowsTicketsAndNoBooking() {
        let app = launch(["-ETGTab", "home", "-ETGEvent", "monsoon-jazz-nights-hyderabad"])
        XCTAssertTrue(app.staticTexts["Monsoon Jazz Nights"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Dates and tickets"].exists)
        // Phase 1–2B never books: the action is present but disabled.
        let book = app.buttons["Booking opens in the next release"]
        XCTAssertTrue(book.exists)
        XCTAssertFalse(book.isEnabled)
    }

    func testSignInThenTicketsLoad() {
        let app = launch(["-ETGTab", "tickets"])
        XCTAssertTrue(app.staticTexts["Sign in to see your tickets"].waitForExistence(timeout: 10))
        app.buttons["Sign in"].firstMatch.tap()

        let email = app.textFields["signIn.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.tap()
        email.typeText("demo.customer@example.com")
        let password = app.secureTextFields["signIn.password"]
        password.tap()
        password.typeText("Tickets-Demo-2026")
        app.buttons["signIn.submit"].tap()

        XCTAssertTrue(element(containing: "The Long Monsoon", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Upcoming"].exists)
    }

    func testWrongPasswordShowsServerMessage() {
        let app = launch(["-ETGTab", "profile", "-ETGSignIn"])
        let email = app.textFields["signIn.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("demo.customer@example.com")
        let password = app.secureTextFields["signIn.password"]
        password.tap()
        password.typeText("not-the-password")
        app.buttons["signIn.submit"].tap()
        XCTAssertTrue(element(containing: "Incorrect email or password.", in: app).waitForExistence(timeout: 5))
    }

    func testValidTicketShowsServerIssuedCode() {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "tickets", "-ETGTicket", "tkt-1"])
        let code = app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Entry code for Monsoon Jazz Nights")).firstMatch
        XCTAssertTrue(code.waitForExistence(timeout: 10))
    }

    func testTransferredTicketShowsNoCode() {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "tickets", "-ETGTicket", "tkt-5"])
        XCTAssertTrue(element(containing: "This ticket has been transferred", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Entry code")).firstMatch.exists)
    }

    func testBookingHistory() {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "profile", "-ETGBookings"])
        XCTAssertTrue(element(containing: "Monsoon Jazz Nights", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element(containing: "₹1,677.90", in: app).exists)
    }

    func testSignOutReturnsToGuest() throws {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "profile"])
        XCTAssertTrue(app.staticTexts["Demo Customer"].waitForExistence(timeout: 10))
        let signOut = app.buttons["Sign out"].firstMatch
        for _ in 0..<4 where !signOut.isHittable { app.swipeUp() }
        signOut.tap()
        // Confirm in the dialog: the "Sign out" that can be tapped (the list's is now covered).
        XCTAssertTrue(element(containing: "Your tickets stay in your account", in: app).waitForExistence(timeout: 5))
        let candidates = app.buttons.matching(NSPredicate(format: "label == %@", "Sign out")).allElementsBoundByIndex
        let button = try XCTUnwrap(candidates.first { $0.isHittable }, "no confirm button in the sign-out dialog")
        button.tap()
        XCTAssertTrue(app.buttons["Sign in or create account"].waitForExistence(timeout: 5))
    }
}
