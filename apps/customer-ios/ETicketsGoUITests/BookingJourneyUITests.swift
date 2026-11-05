import XCTest

/// Drives the app in the simulator through the customer journeys and keeps a screenshot of
/// each step (attachments in the .xcresult). MOCK build unless the class says otherwise.
@MainActor
class JourneyUITestCase: XCTestCase {
    override func setUp() async throws { continueAfterFailure = false }

    func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ETGResetSession"] + arguments
        app.launch()
        return app
    }

    func snap(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func any(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Pull-to-refresh: a press-and-drag from the top of the content, which a plain swipe does
    /// not reliably trigger.
    func pullToRefresh(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
    }

    func scrollTo(_ element: XCUIElement, in app: XCUIApplication, maxSwipes: Int = 6) {
        for _ in 0..<maxSwipes where !element.isHittable { app.swipeUp() }
    }

    /// The "Total" row of the server's breakdown, e.g. "Total, ₹1,703.80".
    func totalLabel(in app: XCUIApplication) -> String {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Total,")).firstMatch
        return row.waitForExistence(timeout: 10) ? row.label : ""
    }
}

final class BookingJourneyUITests: JourneyUITestCase {
    func testGeneralAdmissionPurchaseEndToEnd() {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "home", "-ETGEvent", "monsoon-jazz-nights-hyderabad"])
        XCTAssertTrue(app.staticTexts["Monsoon Jazz Nights"].waitForExistence(timeout: 10))
        snap("01-event-detail")
        app.buttons["event.getTickets"].tap()

        XCTAssertTrue(app.staticTexts["Date and time"].waitForExistence(timeout: 10))
        let add = app.buttons["Add one Lawn"]
        add.tap()
        let one = totalLabel(in: app)
        XCTAssertFalse(one.isEmpty, "no server quote shown")
        add.tap()
        let expectation = expectation(for: NSPredicate(format: "label != %@", one),
                                      evaluatedWith: app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Total,")).firstMatch)
        wait(for: [expectation], timeout: 10)
        snap("02-selection-two-tickets-quoted")
        XCTAssertNotEqual(totalLabel(in: app), one, "quantity change didn't re-quote")

        app.buttons["booking.reserve"].tap()
        XCTAssertTrue(app.staticTexts["Tickets held for you"].waitForExistence(timeout: 10))
        XCTAssertTrue(any("Simulated checkout", in: app).exists)
        snap("03-checkout-hold")

        app.buttons["checkout.pay"].tap()
        XCTAssertTrue(app.buttons["provider.approve"].waitForExistence(timeout: 10))
        snap("04-simulated-provider")
        app.buttons["provider.approve"].tap()
        XCTAssertTrue(any("Confirming your payment", in: app).waitForExistence(timeout: 5))
        snap("05-confirming")
        XCTAssertTrue(app.staticTexts["You're going!"].waitForExistence(timeout: 20))
        snap("06-confirmed")

        app.buttons["checkout.viewTickets"].tap()
        XCTAssertTrue(app.navigationBars["My Tickets"].waitForExistence(timeout: 10))
        snap("07-tickets-after-purchase")
    }

    func testReservedSeatingSelection() {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "movies", "-ETGEvent", "the-long-monsoon-galaxy-cinemas-hyderabad"])
        let getTickets = app.buttons["event.getTickets"]
        XCTAssertTrue(getTickets.waitForExistence(timeout: 10))
        getTickets.tap()
        let available = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Row' AND value == 'Available'"))
        XCTAssertTrue(available.firstMatch.waitForExistence(timeout: 10))
        // Named seats: a query over "available" seats can lag one update behind a tap.
        app.buttons["Row C, seat 5"].tap()
        app.buttons["Row C, seat 6"].tap()
        let reserve = app.buttons["booking.reserve"]
        XCTAssertTrue(reserve.waitForExistence(timeout: 5))
        XCTAssertTrue(NSPredicate(format: "label == 'Reserve 2 tickets'").evaluate(with: reserve) || reserve.label == "Reserve 2 tickets")
        XCTAssertFalse(totalLabel(in: app).isEmpty)
        snap("08-seat-map-two-selected")
        app.buttons["booking.reserve"].tap()
        XCTAssertTrue(app.staticTexts["Tickets held for you"].waitForExistence(timeout: 10))
        snap("09-seats-held")
    }

    func testHoldExpiresAndCannotBePaid() {
        let app = launch(["-ETGMockSignedIn", "-ETGMockHoldSeconds", "6", "-ETGTab", "home", "-ETGEvent", "deccan-street-food-festival-hyderabad"])
        let getTickets = app.buttons["event.getTickets"]
        XCTAssertTrue(getTickets.waitForExistence(timeout: 10))
        getTickets.tap()
        // A free event confirms immediately, so pick a paid one instead.
        app.terminate()

        let paid = launch(["-ETGMockSignedIn", "-ETGMockHoldSeconds", "6", "-ETGTab", "home", "-ETGEvent", "laugh-riot-standup-vijayawada"])
        paid.buttons["event.getTickets"].tap()
        let add = paid.buttons["Add one General admission"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        XCTAssertFalse(totalLabel(in: paid).isEmpty)
        paid.buttons["booking.reserve"].tap()
        XCTAssertTrue(paid.staticTexts["Tickets held for you"].waitForExistence(timeout: 10))
        snap("10-hold-counting-down")
        XCTAssertTrue(paid.staticTexts["Your hold has ended"].waitForExistence(timeout: 20))
        XCTAssertFalse(paid.buttons["checkout.pay"].exists)
        snap("11-hold-expired")
    }

    func testReleaseHold() {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "home", "-ETGEvent", "laugh-riot-standup-vijayawada"])
        app.buttons["event.getTickets"].tap()
        app.buttons["Add one General admission"].tap()
        XCTAssertFalse(totalLabel(in: app).isEmpty)
        app.buttons["booking.reserve"].tap()
        XCTAssertTrue(app.buttons["Release tickets"].waitForExistence(timeout: 10))
        app.buttons["Release tickets"].tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Release tickets")).allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY < 700 }
        (confirm ?? app.buttons["Release tickets"].firstMatch).tap()
        XCTAssertTrue(app.staticTexts["Tickets released"].waitForExistence(timeout: 10))
        snap("12-hold-released")
    }

    func testSignedOutCustomerIsAskedToSignInBeforeBooking() {
        let app = launch(["-ETGTab", "home", "-ETGEvent", "monsoon-jazz-nights-hyderabad"])
        app.buttons["event.getTickets"].tap()
        app.buttons["Add one Lawn"].tap()
        XCTAssertFalse(totalLabel(in: app).isEmpty)       // quotes work signed out (public)
        XCTAssertTrue(app.buttons["Sign in to book"].exists)
        snap("13-signed-out-quote")
    }
}

final class ProductStateUITests: JourneyUITestCase {
    func testCityChoiceScopesHome() {
        let app = launch(["-ETGTab", "home"])
        let chip = app.buttons["home.city"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        chip.tap()
        XCTAssertTrue(app.staticTexts["Choose a city"].waitForExistence(timeout: 5))
        snap("14-city-picker")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Bengaluru'")).firstMatch.tap()
        XCTAssertTrue(any("Carnatic Evening", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(any("Monsoon Jazz Nights", in: app).exists)
        snap("15-home-bengaluru")
        chip.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'All cities'")).firstMatch.tap()
    }

    func testErrorThenRetry() {
        let app = launch(["-ETGMockFailFirst", "-ETGTab", "home"])
        XCTAssertTrue(app.staticTexts["Couldn't load this"].waitForExistence(timeout: 10))
        snap("16-error-state")
        app.buttons["Try again"].tap()
        XCTAssertTrue(app.staticTexts["Now showing"].waitForExistence(timeout: 10))
    }

    func testRefundedAndUsedTicketsShowNoCode() {
        let refunded = launch(["-ETGMockSignedIn", "-ETGTab", "tickets", "-ETGTicket", "tkt-6"])
        XCTAssertTrue(any("was refunded", in: refunded).waitForExistence(timeout: 10))
        XCTAssertFalse(refunded.images.matching(NSPredicate(format: "label BEGINSWITH 'Entry code'")).firstMatch.exists)
        snap("17-refunded-ticket")
        refunded.terminate()
        let used = launch(["-ETGMockSignedIn", "-ETGTab", "tickets", "-ETGTicket", "tkt-4"])
        XCTAssertTrue(any("Already used for entry", in: used).waitForExistence(timeout: 10))
        snap("18-used-ticket")
    }

    func testOfflineShowsSavedTickets() {
        let app = launch(["-ETGMockSignedIn", "-ETGMockOfflineAfterFirstLoad", "-ETGTab", "tickets"])
        XCTAssertTrue(app.staticTexts["Upcoming"].waitForExistence(timeout: 10))
        pullToRefresh(app)                                   // refresh — the "network" is now gone
        XCTAssertTrue(any("You're offline", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(any("Monsoon Jazz Nights", in: app).exists)
        snap("19-offline-saved-tickets")
    }

    func testLargeTextBooking() {
        let app = launch(["-ETGMockSignedIn", "-ETGTab", "home", "-ETGEvent", "monsoon-jazz-nights-hyderabad",
                          "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])
        XCTAssertTrue(app.buttons["event.getTickets"].waitForExistence(timeout: 10))
        snap("20-large-text-event")
        app.buttons["event.getTickets"].tap()
        let add = app.buttons["Add one Lawn"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        scrollTo(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Total,")).firstMatch, in: app)
        XCTAssertFalse(totalLabel(in: app).isEmpty)
        snap("21-large-text-summary")
    }
}
