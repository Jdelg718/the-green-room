import CryptoKit
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

private func directedMessageStatements(text: String = "hello") -> [[String: Any]] {
    let state = "{\"acceptedHumanEventNumber\":1,\"autonomousTurns\":1,\"cancelled\":false,\"fallbackIndex\":0,\"lastSelectedAt\":[[\"isaac-newton\",1]],\"maxAutonomousTurns\":10,\"seen\":[[\"iphone-room:room-00000000-0000-4000-8000-000000000001\",\"17000000-0000-4000-8000-000000000001\"]],\"version\":1}"
    return [
        ["sqlId": "update_director_state", "parameters": [state, 1, "isaac-newton", "isaac-newton", 1, 0, "room-00000000-0000-4000-8000-000000000001", 0, 1]],
        ["sqlId": "append_event", "parameters": ["{\"participantId\":\"human-1\",\"text\":\"\(text)\",\"type\":\"human_message\"}", "room-00000000-0000-4000-8000-000000000001"]],
        ["sqlId": "append_event", "parameters": ["{\"generation\":0,\"reason\":\"directed\",\"sourceEventSequence\":1,\"speaker\":\"isaac-newton\",\"type\":\"director_decision\"}", "room-00000000-0000-4000-8000-000000000001"]],
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

private func atomicPlan(roomId: String, requestId: String, persona: String? = "ada-lovelace") -> String {
    if persona == nil {
        return "{\"kind\":\"silence\",\"requestId\":\"\(requestId)\",\"roomId\":\"\(roomId)\",\"sourceEventSequence\":1}"
    }
    return "{\"kind\":\"provider\",\"maxOutputTokens\":700,\"messages\":[{\"content\":\"System\",\"role\":\"system\"},{\"content\":\"hello\",\"role\":\"user\"}],\"model\":\"gpt-test\",\"personaSlug\":\"\(persona!)\",\"profileId\":\"iphone.openai\",\"profileRevision\":1,\"providerId\":\"openai\",\"requestId\":\"\(requestId)\",\"roomId\":\"\(roomId)\",\"sourceEventSequence\":1,\"temperature\":0.8}"
}

private func atomicPrepareParameters(
    roomId: String,
    commandId: String,
    requestId: String,
    digest: String,
    plan: String,
    persona: String? = "ada-lovelace",
    humanId: String = "human-1"
) -> [Any] {
    let personaValue: Any = persona ?? NSNull()
    let speaker = persona.map { "\"\($0)\"" } ?? "null"
    let reason = persona == nil ? "deliberate_silence" : "selected"
    let director = "{\"generation\":0,\"reason\":\"\(reason)\",\"sourceEventSequence\":1,\"speaker\":\(speaker),\"type\":\"director_decision\"}"
    let state = "{\"acceptedHumanEventNumber\":1,\"autonomousTurns\":1,\"cancelled\":false,\"fallbackIndex\":0,\"lastSelectedAt\":[],\"maxAutonomousTurns\":10,\"seen\":[],\"version\":1}"
    let human = "{\"participantId\":\"\(humanId)\",\"text\":\"hello\",\"type\":\"human_message\"}"
    return [
        commandId, requestId, digest, plan,
        human,
        director, state, 0, 1, personaValue, roomId, 0, 1,
        personaValue, plan, personaValue, plan, plan, plan, plan, plan,
    ]
}

private func runAtomicGenerationDatabaseTests() throws {
    let atomicRoot = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-atomic-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: atomicRoot) }
    let protection = ProtectionSwitch()
    let store = GreenRoomDatabaseStore(
        directory: atomicRoot, migrationsDirectory: migrations, fileProtector: protection.protect
    )
    require(try store.open(expectedSchema: 7)["schema"] as? Int == 7, "fresh schema seven did not open")
    let roomId = "room-00000000-0000-4000-8000-000000000091"
    _ = try store.executeBatch(transactionId: "atomic-room", statements: [
        ["sqlId": "create_room", "parameters": [roomId, "Atomic room"]],
        ["sqlId": "create_human", "parameters": ["human-1", roomId, "You"]],
        ["sqlId": "create_persona", "parameters": ["ada-lovelace", roomId, "Ada Lovelace", 1, "ada-lovelace"]],
        ["sqlId": "create_director_state", "parameters": [roomId]],
        ["sqlId": "select_room", "parameters": [roomId]],
        ["sqlId": "create_connection_profile_revision", "parameters": ["iphone.openai", 1, "openai", NSNull()]],
        ["sqlId": "reserve_credential", "parameters": ["iphone.openai", 1, "openai", "credential:iphone.openai:1", NSNull(), "91000000-0000-4000-8000-000000000001"]],
        ["sqlId": "save_provider_selection", "parameters": ["openai", "iphone.openai", 1, "gpt-test", "iphone.openai", 1, "openai"]],
        ["sqlId": "save_local_draft", "parameters": [roomId, "hello"]],
    ])
    try store.markCredentialReady(CredentialReservation(
        profileId: "iphone.openai", profileRevision: 1, providerId: "openai",
        credentialRef: "credential:iphone.openai:1",
        mutationId: "91000000-0000-4000-8000-000000000001",
        lifecycleState: "credential_pending", tombstoned: false
    ))
    let commandId = "92000000-0000-4000-8000-000000000002"
    let requestId = "93000000-0000-4000-8000-000000000003"
    let plan = atomicPlan(roomId: roomId, requestId: requestId)
    let digest = SHA256.hash(data: Data(plan.utf8)).map { String(format: "%02x", $0) }.joined()
    let prepare = [["sqlId": "prepare_generation_command", "parameters": atomicPrepareParameters(
        roomId: roomId, commandId: commandId, requestId: requestId, digest: digest, plan: plan
    )]]
    _ = try store.executeBatch(transactionId: "atomic-prepare", statements: prepare)
    require(rowStrings(try store.query(sqlId: "room_events", parameters: [roomId])).isEmpty, "prepare appended an event")
    let contextBefore = rowStrings(try store.query(sqlId: "director_context", parameters: [roomId])).first!
    require(contextBefore.contains("\"nextEventSequence\":1") && contextBefore.contains("\"state\":null"), "prepare mutated room/director authority")
    require(rowStrings(try store.query(sqlId: "local_draft", parameters: [roomId])).first?.contains("hello") == true, "prepare removed draft")
    expectFailure("transaction_rejected") {
        _ = try store.executeBatch(transactionId: "atomic-second-unresolved", statements: [[
            "sqlId": "prepare_generation_command", "parameters": atomicPrepareParameters(
                roomId: roomId,
                commandId: "94000000-0000-4000-8000-000000000004",
                requestId: "95000000-0000-4000-8000-000000000005",
                digest: digest, plan: plan
            ),
        ]])
    }
    expectFailure("transaction_rejected") {
        _ = try store.executeBatch(transactionId: "atomic-changed-digest", statements: [[
            "sqlId": "begin_generation_command", "parameters": [commandId, requestId, String(repeating: "f", count: 64)],
        ]])
    }
    _ = try store.executeBatch(transactionId: "atomic-begin-1", statements: [[
        "sqlId": "begin_generation_command", "parameters": [commandId, requestId, digest],
    ]])
    expectFailure("transaction_rejected") {
        _ = try store.executeBatch(transactionId: "atomic-started-cannot-fail", statements: [[
            "sqlId": "fail_generation_command", "parameters": ["offline", commandId, requestId, digest, 1],
        ]])
    }
    let completion = [["sqlId": "complete_generation_command", "parameters": ["Atomic answer.", commandId, requestId, digest]]]
    _ = try store.executeBatch(transactionId: "atomic-complete", statements: completion)
    let events = rowStrings(try store.query(sqlId: "room_events", parameters: [roomId]))
    require(events.count == 3, "atomic completion did not expose exactly three events")
    require(events[0].contains("human_message") && events[1].contains("director_decision") && events[2].contains("persona_message"), "atomic triplet order changed")
    require(rowStrings(try store.query(sqlId: "local_draft", parameters: [roomId])).isEmpty, "atomic completion retained draft")
    _ = try store.executeBatch(transactionId: "atomic-complete", statements: completion)
    require(rowStrings(try store.query(sqlId: "room_events", parameters: [roomId])).count == 3, "completion replay duplicated events")

    let failureRoom = "room-00000000-0000-4000-8000-000000000092"
    _ = try store.executeBatch(transactionId: "atomic-failure-room", statements: [
        ["sqlId": "create_room", "parameters": [failureRoom, "Failure room"]],
        ["sqlId": "create_human", "parameters": ["human-2", failureRoom, "You"]],
        ["sqlId": "create_persona", "parameters": ["ada-lovelace", failureRoom, "Ada Lovelace", 1, "ada-lovelace"]],
        ["sqlId": "create_director_state", "parameters": [failureRoom]],
        ["sqlId": "save_local_draft", "parameters": [failureRoom, "still not sent"]],
    ])
    let failureCommand = "92000000-0000-4000-8000-000000000012"
    let failureRequest = "93000000-0000-4000-8000-000000000013"
    let failurePlan = atomicPlan(roomId: failureRoom, requestId: failureRequest)
    let failureDigest = SHA256.hash(data: Data(failurePlan.utf8)).map { String(format: "%02x", $0) }.joined()
    _ = try store.executeBatch(transactionId: "atomic-failure-prepare", statements: [[
        "sqlId": "prepare_generation_command", "parameters": atomicPrepareParameters(
            roomId: failureRoom, commandId: failureCommand, requestId: failureRequest,
            digest: failureDigest, plan: failurePlan, humanId: "human-2"
        ),
    ]])
    _ = try store.executeBatch(transactionId: "atomic-definitive-failure", statements: [[
        "sqlId": "fail_generation_command", "parameters": ["credential_missing", failureCommand, failureRequest, failureDigest, 0],
    ]])
    require(rowStrings(try store.query(sqlId: "unresolved_generation_command", parameters: [failureRoom])).first?.contains("\"state\":\"failed\"") == true, "pre-request failure was not definitive")
    _ = try store.executeBatch(transactionId: "atomic-failure-retry-begin", statements: [[
        "sqlId": "begin_generation_command", "parameters": [failureCommand, failureRequest, failureDigest],
    ]])
    _ = try store.executeBatch(transactionId: "atomic-started-interrupt", statements: [[
        "sqlId": "interrupt_generation_command", "parameters": ["timeout", failureCommand, failureRequest, failureDigest, 1],
    ]])
    require(rowStrings(try store.query(sqlId: "unresolved_generation_command", parameters: [failureRoom])).first?.contains("\"state\":\"interrupted\"") == true, "started failure was not uncertain/interrupted")
    _ = try store.executeBatch(transactionId: "atomic-abandon", statements: [[
        "sqlId": "abandon_generation_command", "parameters": ["user_abandoned", failureCommand, failureRequest, failureDigest],
    ]])
    require(rowStrings(try store.query(sqlId: "unresolved_generation_command", parameters: [failureRoom])).isEmpty, "abandoned command remained unresolved")
    require(rowStrings(try store.query(sqlId: "room_events", parameters: [failureRoom])).isEmpty, "failure/abandon mutated transcript")
    require(rowStrings(try store.query(sqlId: "local_draft", parameters: [failureRoom])).first?.contains("still not sent") == true, "failure/abandon removed draft")

    let silenceRoom = "room-00000000-0000-4000-8000-000000000093"
    _ = try store.executeBatch(transactionId: "atomic-silence-room", statements: [
        ["sqlId": "create_room", "parameters": [silenceRoom, "Silence room"]],
        ["sqlId": "create_human", "parameters": ["human-3", silenceRoom, "You"]],
        ["sqlId": "create_persona", "parameters": ["ada-lovelace", silenceRoom, "Ada Lovelace", 1, "ada-lovelace"]],
        ["sqlId": "create_director_state", "parameters": [silenceRoom]],
        ["sqlId": "save_local_draft", "parameters": [silenceRoom, "quiet"]],
    ])
    let silenceCommand = "92000000-0000-4000-8000-000000000022"
    let silenceRequest = "93000000-0000-4000-8000-000000000023"
    let silencePlan = atomicPlan(roomId: silenceRoom, requestId: silenceRequest, persona: nil)
    let silenceDigest = SHA256.hash(data: Data(silencePlan.utf8)).map { String(format: "%02x", $0) }.joined()
    _ = try store.executeBatch(transactionId: "atomic-silence-prepare", statements: [[
        "sqlId": "prepare_generation_command", "parameters": atomicPrepareParameters(
            roomId: silenceRoom, commandId: silenceCommand, requestId: silenceRequest,
            digest: silenceDigest, plan: silencePlan, persona: nil, humanId: "human-3"
        ),
    ]])
    _ = try store.executeBatch(transactionId: "atomic-silence-complete", statements: [[
        "sqlId": "complete_silent_generation_command", "parameters": [silenceCommand, silenceRequest, silenceDigest],
    ]])
    let silenceEvents = rowStrings(try store.query(sqlId: "room_events", parameters: [silenceRoom]))
    require(silenceEvents.count == 2 && silenceEvents[0].contains("human_message") && silenceEvents[1].contains("deliberate_silence"), "deliberate silence did not commit the exact pair")

    let rollbackRoom = "room-00000000-0000-4000-8000-000000000094"
    _ = try store.executeBatch(transactionId: "atomic-rollback-room", statements: [
        ["sqlId": "create_room", "parameters": [rollbackRoom, "Rollback room"]],
        ["sqlId": "create_human", "parameters": ["human-4", rollbackRoom, "You"]],
        ["sqlId": "create_persona", "parameters": ["ada-lovelace", rollbackRoom, "Ada Lovelace", 1, "ada-lovelace"]],
        ["sqlId": "create_director_state", "parameters": [rollbackRoom]],
        ["sqlId": "save_local_draft", "parameters": [rollbackRoom, "rollback"]],
    ])
    let rollbackCommand = "92000000-0000-4000-8000-000000000032"
    let rollbackRequest = "93000000-0000-4000-8000-000000000033"
    let rollbackPlan = atomicPlan(roomId: rollbackRoom, requestId: rollbackRequest)
    let rollbackDigest = SHA256.hash(data: Data(rollbackPlan.utf8)).map { String(format: "%02x", $0) }.joined()
    _ = try store.executeBatch(transactionId: "atomic-rollback-prepare", statements: [[
        "sqlId": "prepare_generation_command", "parameters": atomicPrepareParameters(
            roomId: rollbackRoom, commandId: rollbackCommand, requestId: rollbackRequest,
            digest: rollbackDigest, plan: rollbackPlan, humanId: "human-4"
        ),
    ]])
    _ = try store.executeBatch(transactionId: "atomic-rollback-begin", statements: [[
        "sqlId": "begin_generation_command", "parameters": [rollbackCommand, rollbackRequest, rollbackDigest],
    ]])
    protection.fail = true
    expectFailure("database_unavailable") {
        _ = try store.executeBatch(transactionId: "atomic-rollback-complete", statements: [[
            "sqlId": "complete_generation_command", "parameters": ["must roll back", rollbackCommand, rollbackRequest, rollbackDigest],
        ]])
    }
    protection.fail = false
    require(rowStrings(try store.query(sqlId: "room_events", parameters: [rollbackRoom])).isEmpty, "completion failure exposed partial events")
    require(rowStrings(try store.query(sqlId: "unresolved_generation_command", parameters: [rollbackRoom])).first?.contains("\"state\":\"in_flight\"") == true, "completion rollback changed command state")
    require(rowStrings(try store.query(sqlId: "local_draft", parameters: [rollbackRoom])).first?.contains("rollback") == true, "completion rollback removed draft")

    let recoveredRoom = "room-00000000-0000-4000-8000-000000000095"
    _ = try store.executeBatch(transactionId: "atomic-recovered-room", statements: [
        ["sqlId": "create_room", "parameters": [recoveredRoom, "Recovered silence"]],
        ["sqlId": "create_human", "parameters": ["human-5", recoveredRoom, "You"]],
        ["sqlId": "create_persona", "parameters": ["ada-lovelace", recoveredRoom, "Ada Lovelace", 1, "ada-lovelace"]],
        ["sqlId": "create_director_state", "parameters": [recoveredRoom]],
        ["sqlId": "save_local_draft", "parameters": [recoveredRoom, "recover precisely"]],
    ])
    let recoveredCommand = "92000000-0000-4000-8000-000000000042"
    let recoveredRequest = "93000000-0000-4000-8000-000000000043"
    let recoveredPlan = atomicPlan(roomId: recoveredRoom, requestId: recoveredRequest, persona: nil)
    let recoveredDigest = SHA256.hash(data: Data(recoveredPlan.utf8)).map { String(format: "%02x", $0) }.joined()
    _ = try store.executeBatch(transactionId: "atomic-recovered-prepare", statements: [[
        "sqlId": "prepare_generation_command", "parameters": atomicPrepareParameters(
            roomId: recoveredRoom, commandId: recoveredCommand, requestId: recoveredRequest,
            digest: recoveredDigest, plan: recoveredPlan, persona: nil, humanId: "human-5"
        ),
    ]])
    try store.interruptInFlightGenerationCommands()
    let recovered = rowStrings(try store.query(sqlId: "unresolved_generation_command", parameters: [recoveredRoom])).first ?? ""
    require(recovered.contains("\"state\":\"failed\"") && recovered.contains("\"failureCode\":\"not_started\""), "prepared launch recovery was not precise")
    _ = try store.executeBatch(transactionId: "atomic-recovered-complete", statements: [[
        "sqlId": "complete_silent_generation_command", "parameters": [recoveredCommand, recoveredRequest, recoveredDigest],
    ]])
    require(rowStrings(try store.query(sqlId: "room_events", parameters: [recoveredRoom])).count == 2, "precisely failed silence was not retryable without a provider")

    var raw: OpaquePointer?
    require(sqlite3_open_v2(atomicRoot.appendingPathComponent("greenroom.sqlite").path, &raw, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, "raw atomic database open failed")
    let deleteResult = sqlite3_exec(raw, "DELETE FROM generation_commands", nil, nil, nil)
    sqlite3_close_v2(raw)
    require(deleteResult != SQLITE_OK, "durable generation command was deleted")
}

private func runSchemaSixUpgradeTest() throws {
    let upgradeRoot = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-schema-six-upgrade-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: upgradeRoot) }
    try FileManager.default.createDirectory(at: upgradeRoot, withIntermediateDirectories: true)
    let path = upgradeRoot.appendingPathComponent("greenroom.sqlite")
    var raw: OpaquePointer?
    require(sqlite3_open_v2(path.path, &raw, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK, "schema-six fixture open failed")
    for version in 1...6 {
        let file = migrations.appendingPathComponent(String(format: "%04d", version) + ([
            "-iphone-alpha.sql", "-ordered-events.sql", "-shared-director-state.sql",
            "-transaction-replay.sql", "-credential-lifecycle.sql", "-room-talk.sql",
        ][version - 1]))
        let sql = try String(contentsOf: file, encoding: .utf8)
        require(sqlite3_exec(raw, sql, nil, nil, nil) == SQLITE_OK, "schema-six fixture migration \(version) failed")
        require(sqlite3_exec(raw, "PRAGMA user_version = \(version)", nil, nil, nil) == SQLITE_OK, "schema-six fixture version failed")
    }
    require(sqlite3_exec(raw, "INSERT INTO rooms(id,title,status,last_activity_order) VALUES ('room-00000000-0000-4000-8000-000000000096','Preserved','active',1); INSERT INTO participants(id,room_id,kind,display_name,sort_order) VALUES ('human-1','room-00000000-0000-4000-8000-000000000096','human','You',0); INSERT INTO participants(id,room_id,kind,display_name,sort_order,persona_slug) VALUES ('ada-lovelace','room-00000000-0000-4000-8000-000000000096','persona','Ada Lovelace',1,'ada-lovelace'); INSERT INTO director_state(room_id) VALUES ('room-00000000-0000-4000-8000-000000000096'); INSERT INTO events(room_id,sequence,event_json) VALUES ('room-00000000-0000-4000-8000-000000000096',1,'{\"participantId\":\"human-1\",\"text\":\"preserve me\",\"type\":\"human_message\"}');", nil, nil, nil) == SQLITE_OK, "schema-six preserved data fixture failed")
    sqlite3_close_v2(raw)
    let upgraded = GreenRoomDatabaseStore(directory: upgradeRoot, migrationsDirectory: migrations, fileProtector: { _ in })
    require(try upgraded.open(expectedSchema: 7)["schema"] as? Int == 7, "schema six did not upgrade to seven")
    let preserved = rowStrings(try upgraded.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000096"]))
    require(preserved.count == 1 && preserved[0].contains("preserve me"), "schema six upgrade lost room events")
    require(rowStrings(try upgraded.query(sqlId: "unresolved_generation_command", parameters: ["room-00000000-0000-4000-8000-000000000096"])).isEmpty, "schema six upgrade invented a command")
}

private func runRoomTalkTests() throws {
    let roomTalkRoot = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-room-talk-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: roomTalkRoot) }
    let store = GreenRoomDatabaseStore(directory: roomTalkRoot, migrationsDirectory: migrations, fileProtector: { _ in })
    _ = try store.open(expectedSchema: 7)
    var roomStatements = createStatements(title: "Room Talk")
    roomStatements.insert(
        ["sqlId": "create_persona", "parameters": ["isaac-newton", "room-00000000-0000-4000-8000-000000000001", "Isaac Newton", 2, "isaac-newton"]],
        at: 3
    )
    _ = try store.executeBatch(transactionId: "room-talk-create", statements: roomStatements)
    _ = try store.executeBatch(transactionId: "room-talk-human", statements: directedMessageStatements(text: "Isaac, what should we test?"))
    let reply = "{\"generation\":0,\"personaSlug\":\"isaac-newton\",\"sourceEventSequence\":1,\"text\":\"Test the mechanism.\",\"type\":\"persona_message\"}"
    _ = try store.executeBatch(transactionId: "room-talk-reply", statements: [[
        "sqlId": "append_persona_event",
        "parameters": [reply, "room-00000000-0000-4000-8000-000000000001", 0, 3, 2, 1, "isaac-newton"],
    ]])
    let events = rowStrings(try store.query(
        sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"]
    ))
    require(events.count == 3 && events[1].contains("\"reason\":\"directed\"") && events[1].contains("isaac-newton") && events.last?.contains("persona_message") == true, "directed persona reply was not durable")
    expectFailure("transaction_rejected") {
        _ = try store.executeBatch(transactionId: "room-talk-stale", statements: [[
            "sqlId": "append_persona_event",
            "parameters": [reply, "room-00000000-0000-4000-8000-000000000001", 0, 3, 2, 1, "isaac-newton"],
        ]])
    }
    let profile = "iphone.openrouter"
    let mutation = "83000000-0000-4000-8000-000000000001"
    _ = try store.executeBatch(transactionId: "room-talk-provider", statements: [
        ["sqlId": "create_connection_profile_revision", "parameters": [profile, 1, "openrouter", NSNull()]],
        ["sqlId": "reserve_credential", "parameters": [profile, 1, "openrouter", "credential:iphone.openrouter:1", NSNull(), mutation]],
        ["sqlId": "save_provider_selection", "parameters": ["openrouter", profile, 1, "openai/gpt-oss-20b", profile, 1, "openrouter"]],
    ])
    let selection = rowStrings(try store.query(sqlId: "provider_selection", parameters: []))
    require(selection.count == 1 && selection[0].contains("openai/gpt-oss-20b") && !selection[0].contains("credential:"), "non-secret provider selection mismatch")
    require(rowStrings(try store.query(sqlId: "room_list", parameters: [])).first?.contains("Room Talk") == true, "room activity list missing")
    _ = try store.close()
    let reopened = GreenRoomDatabaseStore(directory: roomTalkRoot, migrationsDirectory: migrations, fileProtector: { _ in })
    _ = try reopened.open(expectedSchema: 7)
    require(rowStrings(try reopened.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"])).count == 3, "force-relaunch lost persona reply")
    require(rowStrings(try reopened.query(sqlId: "provider_selection", parameters: [])).count == 1, "force-relaunch lost provider selection")
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
        require(try store!.open(expectedSchema: 7)["schema"] as? Int == 7, "schema seven did not open")

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
        _ = try store!.open(expectedSchema: 7)
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
        _ = try store!.open(expectedSchema: 7)
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
        _ = try store!.open(expectedSchema: 7)
        expectFailure("result_too_large") {
            _ = try store!.query(sqlId: "room_events", parameters: ["room-00000000-0000-4000-8000-000000000001"])
        }
        expectFailure("result_too_large") {
            _ = try store!.query(sqlId: "room_events", parameters: [roomB])
        }

        try runRoomTalkTests()
        try runAtomicGenerationDatabaseTests()
        try runSchemaSixUpgradeTest()
        try runCredentialStoreTests()
        try runProviderDefinitionTests()
        try runProviderTransportTests()
        print("PASS native database, credential lifecycle, fixed provider definitions, and bounded provider transport")
    }
}
