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

        let adaName = "Ada Lovelace, historical interpretation"
        let ada = app.switches[adaName]
        XCTAssertTrue(ada.waitForExistence(timeout: 5))
        XCTAssertEqual(ada.label, adaName)
        XCTAssertEqual(ada.value as? String, "0", "picker card should expose an unselected toggle value")
        assertInteractive(ada, named: adaName, in: app)
        ada.tap()
        XCTAssertEqual(ada.label, adaName, "selection must not change the picker card accessible name")
        XCTAssertEqual(ada.value as? String, "1", "picker card should expose its selected toggle value")

        let createRoom = app.buttons["Create room with selected characters"]
        assertInteractive(createRoom, named: "Create room with selected characters", in: app)
        createRoom.tap()

        let roomTitle = app.staticTexts["ADA LOVELACE ROOM"]
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 15))
        let rooms = app.buttons["Open saved rooms"]
        let provider = app.buttons["Open provider settings"]
        let newRoom = app.buttons["Create another room"]
        let recipient = app.otherElements["Message recipient"]
        let line = app.textViews["Your line"]
        let send = app.buttons["Send atomic turn"]
        for (element, name) in [(rooms, "Open saved rooms"), (provider, "Open provider settings"), (newRoom, "Create another room"), (recipient, "Message recipient"), (line, "Your line"), (send, "Send atomic turn")] {
            assertInteractive(element, named: name, in: app, requiresEnabled: name != "Send atomic turn")
        }
        assertHiddenCommandControls(in: app)

        rooms.tap()
        XCTAssertTrue(app.staticTexts["ROOMS"].waitForExistence(timeout: 5))
        let closeRooms = app.buttons["Close saved rooms"]
        assertInteractive(closeRooms, named: "Close saved rooms", in: app)
        closeRooms.tap()
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 5), "Close saved rooms should return to the active room")
        assertFocused(rooms, "Rooms cancellation should restore focus to its trigger")

        provider.tap()
        XCTAssertTrue(app.staticTexts["PROVIDER"].waitForExistence(timeout: 5))
        assertInteractive(app.buttons["Close provider settings"], named: "Close provider settings", in: app)
        app.buttons["Close provider settings"].tap()
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 5))
        assertFocused(provider, "Provider cancellation should restore focus to its trigger")

        newRoom.tap()
        XCTAssertTrue(pickerTitle.waitForExistence(timeout: 5))
        let cancelPicker = app.buttons["Cancel character picker"]
        assertInteractive(cancelPicker, named: "Cancel character picker", in: app)
        cancelPicker.tap()
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 5), "Cancel character picker should return to the active room")
        assertFocused(newRoom, "Picker cancellation should restore focus to its trigger")
        assertHiddenCommandControls(in: app)

        line.tap()
        line.typeText("Keyboard reachability check")
        XCTAssertTrue(recipient.exists && send.exists, "software keyboard must not remove composer actions from the accessibility tree")
        XCTAssertTrue(recipient.isHittable && send.isHittable, "composer actions must remain reachable with the software keyboard")

        XCUIDevice.shared.orientation = .landscapeLeft
        addTeardownBlock { XCUIDevice.shared.orientation = .portrait }
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        XCTAssertTrue(recipient.isHittable && send.isHittable, "landscape must retain reachable recipient and send controls")
        try app.performAccessibilityAudit(for: .all.subtracting(.hitRegion))
        assertHiddenCommandControls(in: app)

        XCUIDevice.shared.orientation = .portrait
        app.terminate()
        app.launchEnvironment["GREENROOM_SIMULATOR_DIRECTOR_ACCEPTANCE"] = "true"
        app.launch()
        let transcript = app.otherElements["Ordered room transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 20), "deterministic fixture should open an ordered transcript")
        let humanProof = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Simulator director continuity proof")).firstMatch
        let personaProof = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "A stubbed reply crossed the signed room runtime")).firstMatch
        XCTAssertTrue(humanProof.waitForExistence(timeout: 20), "deterministic transcript should contain the directed human line")
        XCTAssertTrue(personaProof.waitForExistence(timeout: 20), "deterministic transcript should contain the committed persona reply")
        assertHiddenCommandControls(in: app)
    }

    @MainActor
    private func assertInteractive(
        _ control: XCUIElement,
        named name: String,
        in app: XCUIApplication,
        requiresEnabled: Bool = true,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(control.waitForExistence(timeout: 5), "missing expected control: \(name)", file: file, line: line)
        if requiresEnabled { XCTAssertTrue(control.isEnabled, "expected enabled control: \(name)", file: file, line: line) }
        for _ in 0..<8 where !control.isHittable {
            if control.frame.midY >= app.frame.midY { app.swipeUp() } else { app.swipeDown() }
        }
        XCTAssertTrue(control.isHittable, "expected unobstructed, onscreen, hittable control: \(name)", file: file, line: line)
        XCTAssertGreaterThanOrEqual(control.frame.width, 44, "\(name) is narrower than 44 points", file: file, line: line)
        XCTAssertGreaterThanOrEqual(control.frame.height, 44, "\(name) is shorter than 44 points", file: file, line: line)
        XCTAssertTrue(app.frame.intersects(control.frame) && app.frame.contains(control.frame), "\(name) is clipped or offscreen", file: file, line: line)
    }

    @MainActor
    private func assertFocused(_ control: XCUIElement, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        let focused = NSPredicate(format: "hasFocus == true")
        expectation(for: focused, evaluatedWith: control)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(control.exists, message, file: file, line: line)
    }

    @MainActor
    private func assertHiddenCommandControls(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for name in ["Retry exact command", "Abandon exact command"] {
            XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).count, 0, "hidden \(name) must be absent from the accessibility tree", file: file, line: line)
        }
    }
}
