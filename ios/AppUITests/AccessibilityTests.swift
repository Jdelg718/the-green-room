import XCTest

final class AccessibilityTests: XCTestCase {
    private static let personaLabels = [
        "Ada Lovelace, historical interpretation",
        "Benjamin Franklin, historical interpretation",
        "Elizabeth I, historical interpretation",
        "Frederick Douglass, historical interpretation",
        "Galileo Galilei, historical interpretation",
        "George Washington, historical interpretation",
        "Isaac Newton, historical interpretation",
        "Jane Austen, historical interpretation",
        "Leonardo da Vinci, historical interpretation",
        "Mary Shelley, historical interpretation",
        "Nicolaus Copernicus, historical interpretation",
        "Thomas Jefferson, historical interpretation",
        "Hal Finney, historical interpretation",
        "Timothy C. May, historical interpretation",
        "Len Sassaman, historical interpretation",
        "Ludwig von Mises, historical interpretation",
        "Milton Friedman, historical interpretation",
        "John Maynard Keynes, historical interpretation",
        "FF2K, creator-authorized original",
    ]

    @MainActor
    func testFirstLaunchPickerAndActiveRoomAccessibility() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()

        let pickerTitle = app.staticTexts["CHOOSE THE CONVERSATION"]
        XCTAssertTrue(pickerTitle.waitForExistence(timeout: 15), "fresh app should open the character picker")
        try app.performAccessibilityAudit(for: .all.subtracting(.hitRegion))
        assertAbsent(["Cancel character picker", "Retry exact command", "Abandon exact command", "Close saved rooms", "Close provider settings", "Back from Privacy and Data Use"], in: app)

        let adaName = Self.personaLabels[0]
        let ada = app.switches[adaName]
        assertInteractive(ada, named: adaName, in: app)
        XCTAssertEqual(ada.label, adaName)
        XCTAssertEqual(ada.value as? String, "0", "picker card should expose an unselected toggle value")
        ada.tap()
        XCTAssertEqual(ada.label, adaName, "selection must not change the picker card accessible name")
        XCTAssertEqual(ada.value as? String, "1", "picker card should expose its selected toggle value")
        assertPickerControls(in: app, includesCancel: false)

        let createRoom = app.buttons["Create room with selected characters"]
        createRoom.tap()

        let roomTitle = app.staticTexts["ADA LOVELACE ROOM"]
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 15))
        assertActiveRoomControls(in: app)
        assertAbsent(["Retry exact command", "Abandon exact command", "Cancel character picker", "Close saved rooms", "Close provider settings", "Back from Privacy and Data Use"], in: app)

        let rooms = app.buttons["Open saved rooms"]
        let provider = app.buttons["Open provider settings"]
        let privacy = app.buttons["Open Privacy and Data Use"]
        let newRoom = app.buttons["Create another room"]
        let recipient = app.otherElements["Message recipient"]
        let line = app.textViews["Your line"]
        let send = app.buttons["Send atomic turn"]

        privacy.tap()
        XCTAssertTrue(app.staticTexts["PRIVACY & DATA USE"].waitForExistence(timeout: 5))
        assertPrivacyControls(in: app)
        app.buttons["Back from Privacy and Data Use"].tap()
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 5))
        assertFocused(privacy, "Privacy Back should restore focus to its trigger")

        rooms.tap()
        XCTAssertTrue(app.staticTexts["ROOMS"].waitForExistence(timeout: 5))
        assertRoomsControls(in: app)
        assertAbsent(["Cancel character picker", "Close provider settings", "Retry exact command", "Abandon exact command", "Back from Privacy and Data Use"], in: app)
        let closeRooms = app.buttons["Close saved rooms"]
        closeRooms.tap()
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 5), "Close saved rooms should return to the active room")
        assertFocused(rooms, "Rooms cancellation should restore focus to its trigger")

        provider.tap()
        XCTAssertTrue(app.staticTexts["PROVIDER"].waitForExistence(timeout: 5))
        assertProviderControls(in: app)
        assertAbsent(["Cancel character picker", "Close saved rooms", "Retry exact command", "Abandon exact command", "Back from Privacy and Data Use"], in: app)
        app.buttons["Close provider settings"].tap()
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 5))
        assertFocused(provider, "Provider cancellation should restore focus to its trigger")

        newRoom.tap()
        XCTAssertTrue(pickerTitle.waitForExistence(timeout: 5))
        assertPickerControls(in: app, includesCancel: true)
        assertAbsent(["Close saved rooms", "Close provider settings", "Retry exact command", "Abandon exact command", "Back from Privacy and Data Use"], in: app)
        let cancelPicker = app.buttons["Cancel character picker"]
        cancelPicker.tap()
        XCTAssertTrue(roomTitle.waitForExistence(timeout: 5), "Cancel character picker should return to the active room")
        assertFocused(newRoom, "Picker cancellation should restore focus to its trigger")
        assertActiveRoomControls(in: app)
        assertAbsent(["Retry exact command", "Abandon exact command", "Cancel character picker", "Close saved rooms", "Close provider settings", "Back from Privacy and Data Use"], in: app)

        line.tap()
        line.typeText("Keyboard reachability check")
        XCTAssertTrue(recipient.exists && send.exists, "software keyboard must not remove composer actions from the accessibility tree")
        XCTAssertTrue(recipient.isHittable && send.isHittable, "composer actions must remain reachable with the software keyboard")

        XCUIDevice.shared.orientation = .landscapeLeft
        addTeardownBlock { XCUIDevice.shared.orientation = .portrait }
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        XCTAssertTrue(recipient.isHittable && send.isHittable, "landscape must retain reachable recipient and send controls")
        XCTAssertGreaterThanOrEqual(recipient.frame.width, 44)
        XCTAssertGreaterThanOrEqual(recipient.frame.height, 44)
        XCTAssertGreaterThanOrEqual(line.frame.width, 44)
        XCTAssertGreaterThanOrEqual(line.frame.height, 44)
        XCTAssertGreaterThanOrEqual(send.frame.width, 44)
        XCTAssertGreaterThanOrEqual(send.frame.height, 44)
        try app.performAccessibilityAudit(for: .all.subtracting(.hitRegion))
        assertAbsent(["Retry exact command", "Abandon exact command", "Cancel character picker", "Close saved rooms", "Close provider settings", "Back from Privacy and Data Use"], in: app)

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
        assertActiveRoomControls(in: app)
        assertAbsent(["Retry exact command", "Abandon exact command", "Cancel character picker", "Close saved rooms", "Close provider settings", "Back from Privacy and Data Use"], in: app)
    }

    @MainActor
    private func assertPickerControls(in app: XCUIApplication, includesCancel: Bool, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.switches.count, Self.personaLabels.count, "picker must expose exactly the 19 reviewed persona controls", file: file, line: line)
        for name in Self.personaLabels {
            assertInteractive(app.switches[name], named: name, in: app, file: file, line: line)
        }
        assertInteractive(app.buttons["Open saved rooms"], named: "Open saved rooms", in: app, scrollTowardTop: true, file: file, line: line)
        assertInteractive(app.buttons["Open provider settings"], named: "Open provider settings", in: app, scrollTowardTop: true, file: file, line: line)
        assertInteractive(app.buttons["Open Privacy and Data Use"], named: "Open Privacy and Data Use", in: app, scrollTowardTop: true, file: file, line: line)
        assertInteractive(app.buttons["Create room with selected characters"], named: "Create room with selected characters", in: app, file: file, line: line)
        if includesCancel {
            assertInteractive(app.buttons["Cancel character picker"], named: "Cancel character picker", in: app, file: file, line: line)
        } else {
            assertAbsent(["Cancel character picker"], in: app, file: file, line: line)
        }
    }

    @MainActor
    private func assertRoomsControls(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for name in ["Open saved rooms", "Open provider settings", "Open Privacy and Data Use", "Close saved rooms", "Create a new room"] {
            assertInteractive(app.buttons[name], named: name, in: app, scrollTowardTop: true, file: file, line: line)
        }
        let rows = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open saved room "))
        XCTAssertEqual(rows.count, 1, "the exercised one-room fixture must expose exactly one saved-room control", file: file, line: line)
        for index in 0..<rows.count {
            let row = rows.element(boundBy: index)
            assertInteractive(row, named: row.label, in: app, scrollTowardTop: false, file: file, line: line)
        }
        XCTAssertEqual(rows.firstMatch.label, "Open saved room 1: Ada Lovelace Room; activity 1", file: file, line: line)
    }

    @MainActor
    private func assertProviderControls(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for name in ["Open saved rooms", "Open provider settings", "Open Privacy and Data Use"] {
            assertInteractive(app.buttons[name], named: name, in: app, scrollTowardTop: true, file: file, line: line)
        }
        assertInteractive(app.otherElements["Provider"], named: "Provider", in: app, scrollTowardTop: false, file: file, line: line)
        assertInteractive(app.textFields["Provider model ID"], named: "Provider model ID", in: app, scrollTowardTop: false, file: file, line: line)
        let consent = app.switches["Consent to selected provider data use"]
        assertInteractive(consent, named: "Consent to selected provider data use", in: app, scrollTowardTop: false, file: file, line: line)
        XCTAssertEqual(consent.value as? String, "0", "provider consent must start unchecked")
        for name in ["Close provider settings", "Save provider credential"] {
            assertInteractive(app.buttons[name], named: name, in: app, scrollTowardTop: false, file: file, line: line)
        }
    }

    @MainActor
    private func assertPrivacyControls(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for name in ["Open saved rooms", "Open provider settings", "Open Privacy and Data Use", "Back from Privacy and Data Use"] {
            assertInteractive(app.buttons[name], named: name, in: app, scrollTowardTop: true, file: file, line: line)
        }
        XCTAssertTrue(app.staticTexts["STORED ON THIS IPHONE"].exists, file: file, line: line)
        XCTAssertTrue(app.staticTexts["WHAT A PROVIDER RECEIVES"].exists, file: file, line: line)
    }

    @MainActor
    private func assertActiveRoomControls(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for name in ["Open saved rooms", "Open provider settings", "Open Privacy and Data Use"] {
            assertInteractive(app.buttons[name], named: name, in: app, scrollTowardTop: true, file: file, line: line)
        }
        assertInteractive(app.otherElements["Message recipient"], named: "Message recipient", in: app, scrollTowardTop: false, file: file, line: line)
        assertInteractive(app.textViews["Your line"], named: "Your line", in: app, scrollTowardTop: false, file: file, line: line)
        assertInteractive(app.buttons["Send atomic turn"], named: "Send atomic turn", in: app, requiresEnabled: false, scrollTowardTop: false, file: file, line: line)
        assertInteractive(app.buttons["Create another room"], named: "Create another room", in: app, scrollTowardTop: false, file: file, line: line)
    }

    @MainActor
    private func assertInteractive(
        _ control: XCUIElement,
        named name: String,
        in app: XCUIApplication,
        requiresEnabled: Bool = true,
        scrollTowardTop: Bool? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(control.waitForExistence(timeout: 5), "missing expected control: \(name)", file: file, line: line)
        if requiresEnabled { XCTAssertTrue(control.isEnabled, "expected enabled control: \(name)", file: file, line: line) }
        for _ in 0..<12 {
            let frame = control.frame
            if app.frame.contains(frame) { break }
            if let scrollTowardTop {
                if scrollTowardTop { app.swipeDown() } else { app.swipeUp() }
            } else if frame.midY >= app.frame.midY {
                app.swipeUp()
            } else {
                app.swipeDown()
            }
        }
        XCTAssertTrue(app.frame.intersects(control.frame) && app.frame.contains(control.frame), "\(name) is clipped or offscreen", file: file, line: line)
        XCTAssertTrue(control.isHittable, "expected unobstructed, onscreen, hittable control: \(name)", file: file, line: line)
        XCTAssertGreaterThanOrEqual(control.frame.width, 44, "\(name) is narrower than 44 points", file: file, line: line)
        XCTAssertGreaterThanOrEqual(control.frame.height, 44, "\(name) is shorter than 44 points", file: file, line: line)
    }

    @MainActor
    private func assertFocused(_ control: XCUIElement, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        let focused = NSPredicate(format: "hasFocus == true")
        expectation(for: focused, evaluatedWith: control)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(control.exists, message, file: file, line: line)
    }

    @MainActor
    private func assertAbsent(_ names: [String], in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for name in names {
            XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).count, 0, "hidden \(name) must be absent from the accessibility tree", file: file, line: line)
        }
    }
}
