import XCTest
@testable import GreenRoomProof

final class GreenRoomProofTests: XCTestCase {
    func testProofRoomStartsWithHumanAndDeterministicPersonaResponse() {
        let room = Room.proofFixture(now: Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(room.personaIDs, Persona.bundled.map(\.id))
        XCTAssertEqual(room.messages.count, 2)
        XCTAssertEqual(room.messages.map(\.speakerKind), [.human, .persona])
        XCTAssertTrue(room.messages[1].text.contains("small exact trial"))
    }

    func testRoomPersistsAcrossFreshStoreInstances() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("room.json")
        let expected = Room.proofFixture(now: Date(timeIntervalSince1970: 1_700_000_000))

        try RoomDiskStore(fileURL: url).save(expected)
        let restored = try RoomDiskStore(fileURL: url).load()

        XCTAssertEqual(restored, expected)
    }

    func testBundledPersonaSourceRecordsAndPortraitsExist() {
        for persona in Persona.bundled {
            XCTAssertNotNil(Bundle.main.url(forResource: persona.portraitName, withExtension: "webp"))
            let stem = persona.sourceRecordName.replacingOccurrences(of: ".yaml", with: "")
            XCTAssertNotNil(Bundle.main.url(forResource: stem, withExtension: "yaml"))
        }
    }

    @MainActor
    func testSendingAppendsDeterministicResponseAndPersists() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let diskStore = RoomDiskStore(fileURL: root.appendingPathComponent("room.json"))
        let model = RoomViewModel(
            diskStore: diskStore,
            keychainStore: KeychainStore(service: "net.greenroomai.spike.tests.\(UUID().uuidString)")
        )

        model.draft = "How do we know the send path works?"
        model.send()

        XCTAssertEqual(model.room.messages.count, 4)
        XCTAssertEqual(model.room.messages[2].text, "How do we know the send path works?")
        XCTAssertTrue(model.room.messages[3].text.contains("one observable step"))
        let restored = try XCTUnwrap(diskStore.load())
        XCTAssertEqual(restored.id, model.room.id)
        XCTAssertEqual(restored.title, model.room.title)
        XCTAssertEqual(restored.personaIDs, model.room.personaIDs)
        XCTAssertEqual(restored.messages.map(\.id), model.room.messages.map(\.id))
        XCTAssertEqual(restored.messages.map(\.text), model.room.messages.map(\.text))
    }

    @MainActor
    func testFailedPersistenceDoesNotPublishAnUncommittedExchange() {
        let model = RoomViewModel(
            diskStore: RoomDiskStore(fileURL: URL(fileURLWithPath: "/dev/null/room.json")),
            keychainStore: KeychainStore(service: "net.greenroomai.spike.tests.\(UUID().uuidString)")
        )
        XCTAssertTrue(model.room.messages.isEmpty)
        model.draft = "This must remain a draft"

        model.send()

        XCTAssertTrue(model.room.messages.isEmpty)
        XCTAssertEqual(model.draft, "This must remain a draft")
        XCTAssertEqual(model.persistenceStatus, "Local save failed")
    }

    func testSyntheticSentinelRoundTripsThroughKeychain() throws {
        let store = KeychainStore(service: "net.greenroomai.spike.tests.\(UUID().uuidString)")
        XCTAssertTrue(try store.runSyntheticSentinelCheck())
        XCTAssertNil(try store.get(account: "proof-sentinel"))
    }
}
