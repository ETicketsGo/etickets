import XCTest

/// Real QA API, read-only, driven through the UI. Runs only against the QA build
/// (`xcodebuild test -configuration QA …`); skips itself in MOCK. Nothing is reserved:
/// QA booking writes are switched off in the build, and the quote is side-effect free.
final class QALiveUITests: JourneyUITestCase {
    private func launchQA(_ arguments: [String]) throws -> XCUIApplication {
        #if QA_BUILD
        return launch(arguments)
        #else
        throw XCTSkip("Not a QA build: run with -configuration QA")
        #endif
    }

    func testBrowseCityAndSearch() throws {
        let app = try launchQA(["-ETGTab", "home"])
        XCTAssertTrue(app.staticTexts["Trending"].waitForExistence(timeout: 20), "no real events from QA")
        snap("qa-01-home")
        app.buttons["home.city"].tap()
        let hyderabad = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Hyderabad'")).firstMatch
        XCTAssertTrue(hyderabad.waitForExistence(timeout: 15), "no real cities from QA")
        snap("qa-02-cities")
        hyderabad.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Hyderabad'")).firstMatch.waitForExistence(timeout: 10))
        snap("qa-03-home-hyderabad")
        app.buttons["home.city"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'All cities'")).firstMatch.tap()

        app.buttons["Explore"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("Snowbound")
        XCTAssertTrue(any("Snowbound", in: app).waitForExistence(timeout: 15))
        snap("qa-04-search")
    }

    func testEventDetailSelectionAndLiveQuote() throws {
        let app = try launchQA(["-ETGTab", "home", "-ETGEvent", "snowbound-a-winter-comedy-a146aa"])
        XCTAssertTrue(app.staticTexts["Dates and tickets"].waitForExistence(timeout: 20))
        snap("qa-05-event-detail")
        app.buttons["event.getTickets"].tap()
        let add = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add one' AND enabled == true")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        XCTAssertFalse(totalLabel(in: app).isEmpty, "no live quote from QA")
        XCTAssertTrue(any("Booking is switched off", in: app).exists)
        XCTAssertTrue(app.buttons["Reserve tickets"].exists)
        XCTAssertFalse(app.buttons["Reserve tickets"].isEnabled)
        snap("qa-06-live-quote")
    }

    func testMovieShowtimesSeatMapAndQuote() throws {
        let app = try launchQA(["-ETGTab", "movies"])
        let poster = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'The Long Monsoon'")).firstMatch
        XCTAssertTrue(poster.waitForExistence(timeout: 20))
        poster.tap()
        XCTAssertTrue(app.staticTexts["Showtimes"].waitForExistence(timeout: 15))
        snap("qa-07-showtimes")
        let show = app.buttons.matching(NSPredicate(format: "label CONTAINS 'PM' OR label CONTAINS 'AM'")).firstMatch
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        show.tap()
        let getTickets = app.buttons["event.getTickets"]
        XCTAssertTrue(getTickets.waitForExistence(timeout: 15))
        getTickets.tap()
        let seat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Row' AND value == 'Available'")).firstMatch
        XCTAssertTrue(seat.waitForExistence(timeout: 15), "no real seat map from QA")
        seat.tap()
        XCTAssertFalse(totalLabel(in: app).isEmpty, "no live quote for a seat")
        snap("qa-08-seat-map-quote")
    }
}
