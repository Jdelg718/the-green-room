import XCTest

final class AccessibilityTests: XCTestCase {
    @MainActor
    func testFirstLaunchPickerAndActiveRoomAccessibility() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()

        let pickerTitle = app.staticTexts["CHOOSE THE CONVERSATION"]
        XCTAssertTrue(pickerTitle.waitForExistence(timeout: 15), "fresh app should open the character picker")

        try app.performAccessibilityAudit(for: .all.subtracting(.hitRegion))
        assertMinimumHitRegions(in: app)

        let ada = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Ada Lovelace,")).firstMatch
        XCTAssertTrue(ada.exists)
        XCTAssertEqual(ada.value as? String, "0", "picker card should expose an unselected toggle value")
        ada.tap()
        XCTAssertEqual(ada.value as? String, "1", "picker card should expose its selected toggle value")

        let createRoom = app.buttons["Create room with selected characters"]
        XCTAssertTrue(createRoom.isEnabled)
        createRoom.tap()

        let recipient = app.otherElements["Message recipient"]
        let line = app.textViews["Your line"]
        let send = app.buttons["Send atomic turn"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 15))
        XCTAssertTrue(line.exists)
        XCTAssertTrue(send.exists)
        assertMinimumHitRegions(in: app)

        line.tap()
        line.typeText("Keyboard reachability check")
        XCTAssertTrue(recipient.exists && send.exists, "software keyboard must not remove composer actions from the accessibility tree")

        XCUIDevice.shared.orientation = .landscapeLeft
        addTeardownBlock { XCUIDevice.shared.orientation = .portrait }
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        XCTAssertTrue(recipient.exists && send.exists, "landscape must retain recipient and send controls")
        try app.performAccessibilityAudit(for: .all.subtracting(.hitRegion))
    }

    @MainActor
    private func assertMinimumHitRegions(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let controls = app.buttons.allElementsBoundByIndex + app.switches.allElementsBoundByIndex + app.textFields.allElementsBoundByIndex + app.textViews.allElementsBoundByIndex
        XCTAssertFalse(controls.isEmpty, "expected interactive controls", file: file, line: line)
        for control in controls where control.exists && control.isEnabled && control.isHittable {
            XCTAssertGreaterThanOrEqual(control.frame.width, 44, "\(control.label) is narrower than 44 points", file: file, line: line)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44, "\(control.label) is shorter than 44 points", file: file, line: line)
        }
    }
}
