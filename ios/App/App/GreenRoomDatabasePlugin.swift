import Capacitor
import CryptoKit
import Foundation
import SQLite3

private let bridgeContractVersion = "iphone-native-bridge/1.0"
private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private struct DatabaseFailure: Error {
    let code: String
    let retryable: Bool
}

private final class GreenRoomDatabaseStore: @unchecked Sendable {
    private var database: OpaquePointer?
    private let lock = NSLock()

    deinit { if let database { sqlite3_close_v2(database) } }

    func open(expectedSchema: Int) throws -> [String: Any] {
        try lock.withLock {
            guard expectedSchema == 2 else { throw DatabaseFailure(code: "migration_rejected", retryable: false) }
            if database == nil {
                let directory = try applicationDirectory()
                let path = directory.appendingPathComponent("greenroom.sqlite")
                var opened: OpaquePointer?
                guard sqlite3_open_v2(path.path, &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
                      let opened else {
                    if let opened { sqlite3_close_v2(opened) }
                    throw DatabaseFailure(code: "database_unavailable", retryable: true)
                }
                database = opened
                sqlite3_busy_timeout(opened, 5_000)
                do {
                    try execute("PRAGMA foreign_keys = ON", on: opened)
                    try execute("PRAGMA journal_mode = WAL", on: opened)
                    try execute("PRAGMA synchronous = FULL", on: opened)
                    try migrate(opened)
                    try protectDatabaseFiles(path)
                } catch {
                    sqlite3_close_v2(opened)
                    database = nil
                    throw error
                }
            }
            guard let database, try scalarInt("PRAGMA user_version", on: database) == expectedSchema else {
                throw DatabaseFailure(code: "migration_rejected", retryable: false)
            }
            return ["schema": expectedSchema]
        }
    }

    func close() throws -> [String: Any] {
        try lock.withLock {
            guard let database else { return ["closed": true] }
            _ = sqlite3_wal_checkpoint_v2(database, nil, SQLITE_CHECKPOINT_FULL, nil, nil)
            guard sqlite3_close_v2(database) == SQLITE_OK else {
                throw DatabaseFailure(code: "database_unavailable", retryable: true)
            }
            self.database = nil
            return ["closed": true]
        }
    }

    func checkpoint() throws -> [String: Any] {
        try lock.withLock {
            guard let database else { throw DatabaseFailure(code: "database_unavailable", retryable: true) }
            guard sqlite3_wal_checkpoint_v2(database, nil, SQLITE_CHECKPOINT_FULL, nil, nil) == SQLITE_OK else {
                throw DatabaseFailure(code: "database_unavailable", retryable: true)
            }
            return ["checkpointed": true]
        }
    }

    func executeBatch(transactionId: String, statements: [[String: Any]]) throws -> [String: Any] {
        try lock.withLock {
            guard !transactionId.isEmpty, transactionId.count <= 256,
                  !statements.isEmpty, statements.count <= 64,
                  let database else {
                throw DatabaseFailure(code: "transaction_rejected", retryable: false)
            }
            try execute("BEGIN IMMEDIATE", on: database)
            var changes = 0
            do {
                for statement in statements {
                    guard Set(statement.keys) == Set(["sqlId", "parameters"]),
                          let sqlId = statement["sqlId"] as? String,
                          let parameters = statement["parameters"] as? [Any],
                          parameters.count <= 64,
                          let sql = Self.statements[sqlId] else {
                        throw DatabaseFailure(code: "transaction_rejected", retryable: false)
                    }
                    let prepared = try prepare(sql, on: database)
                    defer { sqlite3_finalize(prepared) }
                    guard sqlite3_bind_parameter_count(prepared) == parameters.count else {
                        throw DatabaseFailure(code: "transaction_rejected", retryable: false)
                    }
                    try bind(parameters, to: prepared)
                    guard sqlite3_step(prepared) == SQLITE_DONE else {
                        throw DatabaseFailure(code: "transaction_rejected", retryable: false)
                    }
                    changes += Int(sqlite3_changes(database))
                }
                try execute("COMMIT", on: database)
                try protectDatabaseFiles(try databaseURL())
                return ["changes": changes]
            } catch {
                _ = try? execute("ROLLBACK", on: database)
                throw error
            }
        }
    }

    func query(sqlId: String, parameters: [Any]) throws -> [String: Any] {
        try lock.withLock {
            guard parameters.count <= 64, let database else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            let sql: String
            let column: String
            switch sqlId {
            case "current_room":
                sql = """
                SELECT json_object(
                  'id', room.id,
                  'title', room.title,
                  'status', room.status,
                  'generation', room.generation,
                  'participants', json((
                    SELECT json_group_array(json_object(
                      'id', participant.id,
                      'kind', participant.kind,
                      'displayName', participant.display_name,
                      'muted', json(CASE participant.muted WHEN 1 THEN 'true' ELSE 'false' END),
                      'sortOrder', participant.sort_order,
                      'personaSlug', participant.persona_slug
                    ))
                    FROM (SELECT * FROM participants WHERE room_id = room.id ORDER BY sort_order) AS participant
                  ))
                ) AS room_json
                FROM current_room current
                JOIN rooms room ON room.id = current.room_id
                WHERE current.singleton = 1
                """
                column = "room_json"
            case "room_events":
                sql = """
                SELECT json_object('sequence', sequence, 'event', json(event_json)) AS event_record_json
                FROM events WHERE room_id = ? ORDER BY sequence LIMIT 100
                """
                column = "event_record_json"
            default:
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            let prepared = try prepare(sql, on: database)
            defer { sqlite3_finalize(prepared) }
            guard sqlite3_bind_parameter_count(prepared) == parameters.count else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            try bind(parameters, to: prepared)
            var rows: [[Any]] = []
            while true {
                let step = sqlite3_step(prepared)
                if step == SQLITE_DONE { break }
                guard step == SQLITE_ROW, rows.count < 100 else {
                    throw DatabaseFailure(code: "result_too_large", retryable: false)
                }
                guard let value = sqlite3_column_text(prepared, 0) else {
                    throw DatabaseFailure(code: "internal_failure", retryable: false)
                }
                rows.append([String(cString: value)])
            }
            return ["columns": [column], "rows": rows]
        }
    }

    private static let statements = [
        "append_event": "INSERT INTO events(room_id, sequence, event_json) SELECT id, next_event_sequence, ? FROM rooms WHERE id = ?",
        "create_room": "INSERT INTO rooms(id, title, status) VALUES (?, ?, 'active')",
        "create_human": "INSERT INTO participants(id, room_id, display_name, kind, sort_order) VALUES (?, ?, ?, 'human', 0)",
        "create_persona": "INSERT INTO participants(id, room_id, display_name, kind, sort_order, persona_slug) VALUES (?, ?, ?, 'persona', ?, ?)",
        "create_director_state": "INSERT INTO director_state(room_id) VALUES (?)",
        "select_room": "INSERT INTO current_room(singleton, room_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET room_id = excluded.room_id"
    ]

    private func applicationDirectory() throws -> URL {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = root.appendingPathComponent("GreenRoom", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try mutable.setResourceValues(values)
        return directory
    }

    private func databaseURL() throws -> URL {
        try applicationDirectory().appendingPathComponent("greenroom.sqlite")
    }

    private func protectDatabaseFiles(_ databaseURL: URL) throws {
        for url in [databaseURL, URL(fileURLWithPath: databaseURL.path + "-wal"), URL(fileURLWithPath: databaseURL.path + "-shm")] where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutable = url
            try mutable.setResourceValues(values)
        }
    }

    private func migrate(_ database: OpaquePointer) throws {
        var current = try scalarInt("PRAGMA user_version", on: database)
        guard current <= 2,
              let manifestURL = Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "Migrations"),
              let manifestData = try? Data(contentsOf: manifestURL),
              let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              manifest["schema"] as? Int == 2,
              let migrations = manifest["migrations"] as? [[String: Any]],
              migrations.count == 2 else {
            throw DatabaseFailure(code: "migration_rejected", retryable: false)
        }
        for (index, migration) in migrations.enumerated() {
            let version = index + 1
            guard migration["version"] as? Int == version,
                  let file = migration["file"] as? String,
                  file == (version == 1 ? "0001-iphone-alpha.sql" : "0002-ordered-events.sql"),
                  let expected = migration["sha256"] as? String,
                  let migrationURL = Bundle.main.url(forResource: file.replacingOccurrences(of: ".sql", with: ""), withExtension: "sql", subdirectory: "Migrations"),
                  let migrationData = try? Data(contentsOf: migrationURL),
                  expected == SHA256.hash(data: migrationData).map({ String(format: "%02x", $0) }).joined(),
                  let sql = String(data: migrationData, encoding: .utf8) else {
                throw DatabaseFailure(code: "migration_rejected", retryable: false)
            }
            if version <= current { continue }
            try execute("BEGIN IMMEDIATE", on: database)
            do {
                try execute(sql, on: database)
                try execute("PRAGMA user_version = \(version)", on: database)
                try execute("COMMIT", on: database)
                current = version
            } catch {
                _ = try? execute("ROLLBACK", on: database)
                throw DatabaseFailure(code: "migration_rejected", retryable: false)
            }
        }
        guard current == 2 else { throw DatabaseFailure(code: "migration_rejected", retryable: false) }
    }

    private func execute(_ sql: String, on database: OpaquePointer) throws -> Void {
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw DatabaseFailure(code: "database_unavailable", retryable: true)
        }
    }

    private func scalarInt(_ sql: String, on database: OpaquePointer) throws -> Int {
        let statement = try prepare(sql, on: database)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw DatabaseFailure(code: "database_unavailable", retryable: true) }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private func prepare(_ sql: String, on database: OpaquePointer) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw DatabaseFailure(code: "database_unavailable", retryable: true)
        }
        return statement
    }

    private func bind(_ parameters: [Any], to statement: OpaquePointer) throws {
        for (offset, value) in parameters.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            if let value = value as? String {
                result = sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
            } else if let value = value as? NSNumber {
                result = sqlite3_bind_int64(statement, index, value.int64Value)
            } else if value is NSNull {
                result = sqlite3_bind_null(statement, index)
            } else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            guard result == SQLITE_OK else { throw DatabaseFailure(code: "database_unavailable", retryable: true) }
        }
    }
}

@objc(GreenRoomDatabasePlugin)
final class GreenRoomDatabasePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GreenRoomDatabasePlugin"
    let jsName = "GreenRoomDatabase"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "executeBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkpoint", returnType: CAPPluginReturnPromise)
    ]
    private let store = GreenRoomDatabaseStore()

    @objc func open(_ call: CAPPluginCall) {
        respond(call, method: "database.open") { payload in
            guard Set(payload.keys) == Set(["expectedSchema"]), let schema = payload["expectedSchema"] as? NSNumber else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            return try self.store.open(expectedSchema: schema.intValue)
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        respond(call, method: "database.close") { payload in
            guard payload.isEmpty else { throw DatabaseFailure(code: "invalid_call", retryable: false) }
            return try self.store.close()
        }
    }

    @objc func checkpoint(_ call: CAPPluginCall) {
        respond(call, method: "database.checkpoint") { payload in
            guard payload.isEmpty else { throw DatabaseFailure(code: "invalid_call", retryable: false) }
            return try self.store.checkpoint()
        }
    }

    @objc func executeBatch(_ call: CAPPluginCall) {
        respond(call, method: "database.executeBatch") { payload in
            guard Set(payload.keys) == Set(["transactionId", "statements"]),
                  let transactionId = payload["transactionId"] as? String,
                  let statements = payload["statements"] as? [[String: Any]] else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            return try self.store.executeBatch(transactionId: transactionId, statements: statements)
        }
    }

    @objc func query(_ call: CAPPluginCall) {
        respond(call, method: "database.query") { payload in
            guard Set(payload.keys) == Set(["sqlId", "parameters"]),
                  let sqlId = payload["sqlId"] as? String,
                  let parameters = payload["parameters"] as? [Any] else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            return try self.store.query(sqlId: sqlId, parameters: parameters)
        }
    }

    private func respond(_ call: CAPPluginCall, method: String, operation: ([String: Any]) throws -> [String: Any]) {
        let options = call.options as? [String: Any] ?? [:]
        let callId = options["callId"] as? String ?? "invalid"
        do {
            guard Set(options.keys) == Set(["contractVersion", "callId", "method", "payload"]),
                  options["contractVersion"] as? String == bridgeContractVersion,
                  options["method"] as? String == method,
                  callId.count == 36, UUID(uuidString: callId) != nil,
                  let payload = options["payload"] as? [String: Any] else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            call.resolve(["callId": callId, "ok": true, "value": try operation(payload)])
        } catch let failure as DatabaseFailure {
            call.resolve(["callId": callId, "ok": false, "error": ["code": failure.code, "retryable": failure.retryable]])
        } catch {
            call.resolve(["callId": callId, "ok": false, "error": ["code": "internal_failure", "retryable": false]])
        }
    }
}
