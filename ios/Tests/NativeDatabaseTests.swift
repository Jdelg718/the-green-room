import Foundation
import SQLite3

private let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
private let migrations = root.appendingPathComponent("ios/App/App/Resources/Migrations")
private let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-native-tests-\(UUID().uuidString)")
private let databaseURL = temporary.appendingPathComponent("greenroom.sqlite")

private final class ProtectionSwitch: @unchecked Sendable {
    var fail = false
    var protectedPaths: [[String]] = []

    func protect(_ database: URL) throws {
        if fail { throw DatabaseFailure(code: "database_unavailable", retryable: true) }
        protectedPaths.append([database.path, database.path + "-wal", database.path + "-shm"])
    }
}

private func require(_ condition: Bool, _ message: String) {
    if !condition { fatalError(message) }
}

private func expectFailure(_ code: String, _ operation: () throws -> Void) {
    do {
        try operation()
        fatalError("expected \(code)")
    } catch let failure as DatabaseFailure {
        require(failure.code == code, "expected \(code), got \(failure.code)")
    } catch {
        fatalError("unexpected failure: \(error)")
    }
}

private func createStatements(title: String = "A\0B") -> [[String: Any]] {
    [
        ["sqlId": "create_room", "parameters": ["room-00000000-0000-4000-8000-000000000001", title]],
        ["sqlId": "create_human", "parameters": ["human-1", "room-00000000-0000-4000-8000-000000000001", "You"]],
        ["sqlId": "create_persona", "parameters": ["ada-lovelace", "room-00000000-0000-4000-8000-000000000001", "Ada Lovelace", 1, "ada-lovelace"]],
        ["sqlId": "create_director_state", "parameters": ["room-00000000-0000-4000-8000-000000000001"]],
        ["sqlId": "select_room", "parameters": ["room-00000000-0000-4000-8000-000000000001"]],
    ]
}

private func messageStatements(text: String = "hello") -> [[String: Any]] {
    let state = "{\"acceptedHumanEventNumber\":1,\"autonomousTurns\":1,\"cancelled\":false,\"fallbackIndex\":0,\"lastSelectedAt\":[[\"ada-lovelace\",1]],\"maxAutonomousTurns\":10,\"seen\":[[\"iphone-room:room-00000000-0000-4000-8000-000000000001\",\"10000000-0000-4000-8000-000000000001\"]],\"version\":1}"
    return [
        ["sqlId": "update_director_state", "parameters": [state, 1, "ada-lovelace", "ada-lovelace", 1, 0, "room-00000000-0000-4000-8000-000000000001", 0, 1]],
        ["sqlId": "append_event", "parameters": ["{\"participantId\":\"human-1\",\"text\":\"\(text)\",\"type\":\"human_message\"}", "room-00000000-0000-4000-8000-000000000001"]],
        ["sqlId": "append_event", "parameters": ["{\"generation\":0,\"reason\":\"selected\",\"sourceEventSequence\":1,\"speaker\":\"ada-lovelace\",\"type\":\"director_decision\"}", "room-00000000-0000-4000-8000-000000000001"]],
    ]
}

private func rowStrings(_ result: [String: Any]) -> [String] {
    (result["rows"] as? [[Any]] ?? []).compactMap { $0.first as? String }
}

private func rawExecute(_ sql: String) {
    var database: OpaquePointer?
    require(sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, "raw open failed")
    defer { sqlite3_close_v2(database) }
    require(sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK, "raw SQL failed")
}

@main
struct NativeDatabaseTests {
    static func main() throws {
        defer { try? FileManager.default.removeItem(at: temporary) }
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        let protection = ProtectionSwitch()
        var store: GreenRoomDatabaseStore? = GreenRoomDatabaseStore(
            directory: temporary,
            migrationsDirectory: migrations,
            fileProtector: protection.protect
        )
        require(try store!.open(expectedSchema: 4)["schema"] as? Int == 4, "schema four did not open")

        let callId = "00000000-0000-4000-8000-000000000001"
        require(canonicalBridgeCallId(callId) == callId, "canonical call ID was rejected")
        let sanitizedInvalidCallId = canonicalBridgeCallId(String(repeating: "secret", count: 60_000))
        require(sanitizedInvalidCallId == "invalid", "oversized call ID was reflected")
        let sanitizedFailure: [String: Any] = [
            "callId": sanitizedInvalidCallId,
            "ok": false,
            "error": ["code": "invalid_call", "retryable": false],
        ]
        require(try encodedBridgeJSONObject(sanitizedFailure, code: "internal_failure").count < 256 * 1024, "sanitized failure exceeded response budget")
        let emptyEnvelope: [String: Any] = [
            "contractVersion": "iphone-native-bridge/1.0",
            "callId": callId,
            "method": "database.query",
            "payload": ["sqlId": "room_events", "parameters": [""]],
        ]
        let envelopeOverhead = try JSONSerialization.data(withJSONObject: emptyEnvelope, options: [.sortedKeys]).count
        let exactEnvelopeParameter = String(repeating: "e", count: 256 * 1024 - envelopeOverhead)
        let exactEnvelope: [String: Any] = [
            "contractVersion": "iphone-native-bridge/1.0",
            "callId": callId,
            "method": "database.query",
            "payload": ["sqlId": "room_events", "parameters": [exactEnvelopeParameter]],
        ]
        require(try encodedBridgeJSONObject(exactEnvelope, code: "invalid_call").count == 256 * 1024, "exact request envelope was rejected")
        expectFailure("invalid_call") {
            _ = try encodedBridgeJSONObject([
                "contractVersion": "iphone-native-bridge/1.0",
                "callId": callId,
                "method": "database.query",
                "payload": ["sqlId": "room_events", "parameters": [exactEnvelopeParameter + "e"]],
            ], code: "invalid_call")
        }

        let created = try store!.executeBatch(transactionId: "create-room-1", statements: createStatements())
        require(created["changes"] as? Int == 5, "room creation changes mismatch")
        let replayedCreate = try store!.executeBatch(transactionId: "create-room-1", statements: createStatements())
        require(replayedCreate["changes"] as? Int == 5, "same-process room replay was not idempotent")
        expectFailure("transaction_rejected") {
            _ = try store!.executeBatch(transactionId: "create-room-1", statements: createStatements(title: "different"))
        }
        let roomProjection = rowStrings(try store!.query(sqlId: "current_room", parameters: []))
        require(roomProjection.count == 1 && roomProjection[0].contains("A\\u0000B"), "embedded NUL was not bound by exact UTF-8 length")

        protection.fail = true
        expectFailure("database_unavailable") {
            _ = try store!.executeBatch(transactionId: "message-1", statements: messageStatements())
        }
        require(rowStrings(try store!.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"])).isEmpty, "protection failure committed partial events")
        protection.fail = false
        let committed = try store!.executeBatch(transactionId: "message-1", statements: messageStatements())
        require(committed["changes"] as? Int == 3, "message commit mismatch")
        require(rowStrings(try store!.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"])).count == 2, "message pair missing")
        _ = try store!.executeBatch(transactionId: "message-1", statements: messageStatements())
        require(rowStrings(try store!.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"])).count == 2, "retry duplicated message pair")

        let oversizedEvent = "{\"type\":\"human_message\",\"text\":\"\(String(repeating: "x", count: 262_144))\"}"
        expectFailure("invalid_call") {
            _ = try store!.executeBatch(transactionId: "oversized", statements: [["sqlId": "append_event", "parameters": [oversizedEvent, "room-00000000-0000-4000-8000-000000000001"]]])
        }
        require(rowStrings(try store!.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"])).count == 2, "oversized input wrote an event")

        let cumulative = (0..<64).map { index in
            let persona = "p\(index)-" + String(repeating: "x", count: 2_200)
            let slug = "s\(index)-" + String(repeating: "y", count: 2_200)
            let parameters: [Any] = [persona, "room-00000000-0000-4000-8000-000000000001", "Name", index % 3 + 1, slug]
            return ["sqlId": "create_persona", "parameters": parameters] as [String: Any]
        }
        expectFailure("invalid_call") {
            _ = try store!.executeBatch(transactionId: "cumulative", statements: cumulative)
        }

        let emptyQuery: [String: Any] = ["sqlId": "room_events", "parameters": [""]]
        let queryOverhead = try JSONSerialization.data(withJSONObject: emptyQuery, options: [.sortedKeys]).count
        let exactParameter = String(repeating: "q", count: 256 * 1024 - queryOverhead)
        require(rowStrings(try store!.query(sqlId: "room_events", parameters: [exactParameter])).isEmpty, "exact 256 KiB query input was rejected")
        require(rowStrings(try store!.query(sqlId: "room_events", parameters: [""])).isEmpty, "empty UTF-8 text binding was rejected")
        expectFailure("invalid_call") {
            _ = try store!.query(sqlId: "room_events", parameters: [exactParameter + "q"])
        }

        let roomB = "room-00000000-0000-4000-8000-000000000002"
        let createB: [[String: Any]] = [
            ["sqlId": "create_room", "parameters": [roomB, "Room B"]],
            ["sqlId": "create_human", "parameters": ["human-2", roomB, "You"]],
            ["sqlId": "create_persona", "parameters": ["isaac-newton", roomB, "Isaac Newton", 1, "isaac-newton"]],
            ["sqlId": "create_director_state", "parameters": [roomB]],
            ["sqlId": "select_room", "parameters": [roomB]],
        ]
        _ = try store!.executeBatch(transactionId: "create-room-2", statements: createB)
        _ = try store!.executeBatch(transactionId: "create-room-2", statements: createB)

        _ = try store!.close()
        store = nil
        store = GreenRoomDatabaseStore(directory: temporary, migrationsDirectory: migrations, fileProtector: protection.protect)
        _ = try store!.open(expectedSchema: 4)
        _ = try store!.executeBatch(transactionId: "message-1", statements: messageStatements())
        let existingA = rowStrings(try store!.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"]))
        require(existingA.count == 2, "relaunch retry duplicated message pair")
        require(rowStrings(try store!.query(sqlId: "current_room", parameters: [])).first?.contains(roomB) == true, "restart did not reopen authoritative room B")
        require(protection.protectedPaths.allSatisfy { $0.count == 3 && $0[1].hasSuffix("-wal") && $0[2].hasSuffix("-shm") }, "DB/WAL/SHM protection coverage changed")

        _ = try store!.close()
        store = nil
        let emptyRecord = "{\"sequence\":3,\"event\":{\"participantId\":\"human-1\",\"text\":\"\",\"type\":\"human_message\"}}"
        let emptyResult: [String: Any] = ["columns": ["event_record_json"], "rows": (existingA + [emptyRecord]).map { [$0] }]
        let resultOverhead = try JSONSerialization.data(withJSONObject: emptyResult, options: [.sortedKeys]).count
        let valueBudget = try bridgeSuccessValueBudget(callId: callId)
        let boundaryPadding = valueBudget - resultOverhead
        let boundaryRecord = "{\"sequence\":3,\"event\":{\"participantId\":\"human-1\",\"text\":\"\(String(repeating: "z", count: boundaryPadding))\",\"type\":\"human_message\"}}"
        let boundaryResult: [String: Any] = ["columns": ["event_record_json"], "rows": (existingA + [boundaryRecord]).map { [$0] }]
        require(try JSONSerialization.data(withJSONObject: boundaryResult, options: [.sortedKeys]).count == valueBudget, "boundary fixture is not exact")
        rawExecute("INSERT INTO events(room_id, sequence, event_json) VALUES ('room-00000000-0000-4000-8000-000000000001', 3, json_object('participantId','human-1','text', printf('%.*c', \(boundaryPadding), 'z'),'type','human_message'));")
        store = GreenRoomDatabaseStore(directory: temporary, migrationsDirectory: migrations, fileProtector: protection.protect)
        _ = try store!.open(expectedSchema: 4)
        let exactResult = try store!.query(
            sqlId: "room_events",
            parameters: ["room-00000000-0000-4000-8000-000000000001"],
            maximumResultBytes: valueBudget
        )
        let exactResponse: [String: Any] = ["callId": callId, "ok": true, "value": exactResult]
        require(try encodedBridgeJSONObject(exactResponse, code: "result_too_large").count == 256 * 1024, "exact 256 KiB response envelope was rejected")
        _ = try store!.close()
        store = nil
        rawExecute("INSERT INTO events(room_id, sequence, event_json) VALUES ('room-00000000-0000-4000-8000-000000000001', 4, json_object('participantId','human-1','text','one-more-row','type','human_message')); INSERT INTO events(room_id, sequence, event_json) VALUES ('\(roomB)', 1, json_object('participantId','human-2','text', printf('%.*c', 300000, 'z'),'type','human_message'));")
        store = GreenRoomDatabaseStore(directory: temporary, migrationsDirectory: migrations, fileProtector: protection.protect)
        _ = try store!.open(expectedSchema: 4)
        expectFailure("result_too_large") {
            _ = try store!.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"])
        }
        expectFailure("result_too_large") {
            _ = try store!.query(sqlId: "room_events", parameters: [roomB])
        }

        print("PASS native database: byte budgets, exact UTF-8 binding, pre-commit rollback, durable replay, relaunch replay, and DB/WAL/SHM protection")
    }
}
