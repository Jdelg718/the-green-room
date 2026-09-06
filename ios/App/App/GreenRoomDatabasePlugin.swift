#if canImport(Capacitor)
import Capacitor
#endif
import CryptoKit
import Foundation
import SQLite3

let bridgeContractVersion = "iphone-native-bridge/1.0"
private let bridgeMaximumBytes = 256 * 1024
private let maximumQueryRows = 500
private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct DatabaseFailure: Error {
    let code: String
    let retryable: Bool
}

func encodedBridgeJSONObject(_ value: Any, code: String, maximumBytes: Int = bridgeMaximumBytes) throws -> Data {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          data.count <= maximumBytes else {
        throw DatabaseFailure(code: code, retryable: false)
    }
    return data
}

func bridgeSuccessValueBudget(callId: String) throws -> Int {
    let placeholder: [String: Any] = ["callId": callId, "ok": true, "value": NSNull()]
    let encoded = try encodedBridgeJSONObject(placeholder, code: "result_too_large")
    return bridgeMaximumBytes - (encoded.count - 4)
}

func canonicalBridgeCallId(_ value: Any?) -> String {
    guard let supplied = value as? String,
          supplied.count == 36,
          supplied == supplied.lowercased(),
          UUID(uuidString: supplied)?.uuidString.lowercased() == supplied else {
        return "invalid"
    }
    return supplied
}

func consumeSQLiteRows(
    step: () -> Int32,
    onRow: () -> Void,
    failureCode: String
) throws {
    while true {
        let result = step()
        if result == SQLITE_DONE { return }
        guard result == SQLITE_ROW else {
            throw DatabaseFailure(code: failureCode, retryable: true)
        }
        onRow()
    }
}

final class GreenRoomDatabaseStore: @unchecked Sendable {
    private var database: OpaquePointer?
    let serializationLock: NSRecursiveLock
    private let directoryOverride: URL?
    private let migrationsDirectoryOverride: URL?
    private let fileProtector: (URL) throws -> Void

    init(
        directory: URL? = nil,
        migrationsDirectory: URL? = nil,
        serializationLock: NSRecursiveLock = NSRecursiveLock(),
        fileProtector: ((URL) throws -> Void)? = nil
    ) {
        self.directoryOverride = directory
        self.migrationsDirectoryOverride = migrationsDirectory
        self.serializationLock = serializationLock
        self.fileProtector = fileProtector ?? Self.applyDatabaseFileProtection
    }

    deinit { if let database { sqlite3_close_v2(database) } }

    func open(expectedSchema: Int) throws -> [String: Any] {
        try serializationLock.withLock {
            guard expectedSchema == 5 else { throw DatabaseFailure(code: "migration_rejected", retryable: false) }
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
        try serializationLock.withLock {
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
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "database_unavailable", retryable: true) }
            guard sqlite3_wal_checkpoint_v2(database, nil, SQLITE_CHECKPOINT_FULL, nil, nil) == SQLITE_OK else {
                throw DatabaseFailure(code: "database_unavailable", retryable: true)
            }
            return ["checkpointed": true]
        }
    }

    func executeBatch(transactionId: String, statements: [[String: Any]]) throws -> [String: Any] {
        try serializationLock.withLock {
            guard !transactionId.isEmpty, transactionId.utf8.count <= 256,
                  transactionId.trimmingCharacters(in: .whitespacesAndNewlines) == transactionId,
                  !statements.isEmpty, statements.count <= 64,
                  let database else {
                throw DatabaseFailure(code: "transaction_rejected", retryable: false)
            }
            try requireEncodedBudget(["transactionId": transactionId, "statements": statements], code: "invalid_call")
            let requestDigest = try digest(statements)
            try execute("BEGIN IMMEDIATE", on: database)
            var changes = 0
            do {
                if let prior = try priorTransaction(transactionId, on: database) {
                    guard prior.digest == requestDigest else {
                        throw DatabaseFailure(code: "transaction_rejected", retryable: false)
                    }
                    try execute("ROLLBACK", on: database)
                    return prior.result
                }
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
                    let statementChanges = Int(sqlite3_changes(database))
                    if Self.requiredSingleChangeStatements.contains(sqlId), statementChanges != 1 {
                        throw DatabaseFailure(code: "transaction_rejected", retryable: false)
                    }
                    changes += statementChanges
                }
                let result: [String: Any] = ["changes": changes]
                let resultData = try encodedJSONObject(result, code: "result_too_large")
                let resultJSON = String(decoding: resultData, as: UTF8.self)
                let registration = try prepare(
                    "INSERT INTO bridge_transactions(transaction_id, request_digest, result_json) VALUES (?, ?, ?)",
                    on: database
                )
                defer { sqlite3_finalize(registration) }
                try bind([transactionId, requestDigest, resultJSON], to: registration)
                guard sqlite3_step(registration) == SQLITE_DONE else {
                    throw DatabaseFailure(code: "transaction_rejected", retryable: false)
                }
                try protectDatabaseFiles(try databaseURL())
                try execute("COMMIT", on: database)
                return result
            } catch {
                _ = try? execute("ROLLBACK", on: database)
                throw error
            }
        }
    }

    func query(
        sqlId: String,
        parameters: [Any],
        maximumResultBytes: Int = bridgeMaximumBytes
    ) throws -> [String: Any] {
        try serializationLock.withLock {
            guard parameters.count <= 64, let database else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            try requireEncodedBudget(["sqlId": sqlId, "parameters": parameters], code: "invalid_call")
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
                FROM (
                  SELECT sequence, event_json FROM events
                  WHERE room_id = ? ORDER BY sequence DESC LIMIT 100
                ) AS recent_events
                ORDER BY sequence ASC
                """
                column = "event_record_json"
            case "director_context":
                sql = """
                SELECT json_object(
                  'roomId', room.id,
                  'generation', room.generation,
                  'nextEventSequence', room.next_event_sequence,
                  'state', json(director.state_json),
                  'personas', json((
                    SELECT json_group_array(json_object(
                      'id', participant.id,
                      'personaSlug', participant.persona_slug,
                      'displayName', participant.display_name,
                      'muted', json(CASE participant.muted WHEN 1 THEN 'true' ELSE 'false' END),
                      'sortOrder', participant.sort_order
                    ))
                    FROM (SELECT * FROM participants WHERE room_id = room.id AND kind = 'persona' ORDER BY sort_order) AS participant
                  ))
                ) AS director_context_json
                FROM rooms room JOIN director_state director ON director.room_id = room.id
                WHERE room.id = ?
                """
                column = "director_context_json"
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
                guard step == SQLITE_ROW, rows.count < maximumQueryRows else {
                    throw DatabaseFailure(code: "result_too_large", retryable: false)
                }
                guard let value = sqlite3_column_text(prepared, 0) else {
                    throw DatabaseFailure(code: "internal_failure", retryable: false)
                }
                let byteCount = Int(sqlite3_column_bytes(prepared, 0))
                guard byteCount <= bridgeMaximumBytes else {
                    throw DatabaseFailure(code: "result_too_large", retryable: false)
                }
                let bytes = UnsafeRawBufferPointer(start: value, count: byteCount)
                guard let decoded = String(bytes: bytes, encoding: .utf8) else {
                    throw DatabaseFailure(code: "internal_failure", retryable: false)
                }
                let candidate = rows + [[decoded]]
                try requireEncodedBudget(
                    ["columns": [column], "rows": candidate],
                    code: "result_too_large",
                    maximumBytes: maximumResultBytes
                )
                rows.append([decoded])
            }
            let result: [String: Any] = ["columns": [column], "rows": rows]
            try requireEncodedBudget(result, code: "result_too_large", maximumBytes: maximumResultBytes)
            return result
        }
    }

    func supersededCredentialReferences(profileId: String, before revision: Int) throws -> [String] {
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            let statement = try prepare(
                "SELECT credential_ref FROM credential_revisions WHERE profile_id = ? AND profile_revision < ? ORDER BY profile_revision",
                on: database
            )
            defer { sqlite3_finalize(statement) }
            try bind([profileId, revision], to: statement)
            var references: [String] = []
            while true {
                let step = sqlite3_step(statement)
                if step == SQLITE_DONE { return references }
                guard step == SQLITE_ROW else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
                references.append(columnText(statement, 0))
            }
        }
    }

    func credentialReservation(
        profileId: String,
        profileRevision: Int,
        providerId: String,
        credentialRef: String
    ) throws -> CredentialReservation? {
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            let statement = try prepare(
                """
                SELECT profile_id, profile_revision, provider_id, credential_ref, mutation_id,
                       lifecycle_state, tombstoned
                FROM credential_revisions
                WHERE profile_id = ? AND profile_revision = ? AND provider_id = ? AND credential_ref = ?
                  AND profile_revision = (
                    SELECT max(profile_revision) FROM credential_revisions WHERE profile_id = ?
                  )
                  AND EXISTS (
                    SELECT 1 FROM connection_profile_revisions profile
                    WHERE profile.profile_id = credential_revisions.profile_id
                      AND profile.profile_revision = credential_revisions.profile_revision
                      AND profile.provider_id = credential_revisions.provider_id
                      AND profile.profile_revision = (
                        SELECT max(current.profile_revision)
                        FROM connection_profile_revisions current
                        WHERE current.profile_id = profile.profile_id
                      )
                  )
                """,
                on: database
            )
            defer { sqlite3_finalize(statement) }
            try bind([profileId, profileRevision, providerId, credentialRef, profileId], to: statement)
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { return nil }
            guard step == SQLITE_ROW else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            return CredentialReservation(
                profileId: columnText(statement, 0),
                profileRevision: Int(sqlite3_column_int64(statement, 1)),
                providerId: columnText(statement, 2),
                credentialRef: columnText(statement, 3),
                mutationId: columnText(statement, 4),
                lifecycleState: columnText(statement, 5),
                tombstoned: sqlite3_column_int(statement, 6) == 1
            )
        }
    }

    func markCredentialReady(_ reservation: CredentialReservation) throws {
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            let statement = try prepare(
                """
                UPDATE credential_revisions
                SET lifecycle_state = 'ready', ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP)
                WHERE profile_id = ? AND profile_revision = ? AND provider_id = ?
                  AND credential_ref = ? AND mutation_id = ?
                  AND lifecycle_state = 'credential_pending' AND tombstoned = 0
                """,
                on: database
            )
            defer { sqlite3_finalize(statement) }
            try bind(reservation.identityParameters, to: statement)
            guard sqlite3_step(statement) == SQLITE_DONE, sqlite3_changes(database) == 1 else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
        }
    }

    func beginCredentialDelete(_ request: CredentialMutationRequest) throws -> CredentialReservation {
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            guard let existing = try credentialReservation(
                profileId: request.profileId,
                profileRevision: request.profileRevision,
                providerId: request.providerId,
                credentialRef: request.credentialRef
            ) else { throw DatabaseFailure(code: "credential_missing", retryable: false) }
            if existing.tombstoned {
                guard try tombstoneMutationId(existing, on: database) == request.mutationId else {
                    throw DatabaseFailure(code: "credential_unavailable", retryable: false)
                }
                return existing
            }
            try execute("BEGIN IMMEDIATE", on: database)
            do {
                let tombstone = try prepare(
                    """
                    INSERT INTO credential_tombstones(
                      profile_id, profile_revision, provider_id, credential_ref, mutation_id
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    on: database
                )
                defer { sqlite3_finalize(tombstone) }
                try bind(request.identityParameters, to: tombstone)
                guard sqlite3_step(tombstone) == SQLITE_DONE else {
                    throw DatabaseFailure(code: "credential_unavailable", retryable: false)
                }
                try execute("COMMIT", on: database)
            } catch {
                _ = try? execute("ROLLBACK", on: database)
                throw error
            }
            guard let result = try credentialReservation(
                profileId: request.profileId,
                profileRevision: request.profileRevision,
                providerId: request.providerId,
                credentialRef: request.credentialRef
            ) else { throw DatabaseFailure(code: "internal_failure", retryable: false) }
            return result
        }
    }

    func markCredentialMissing(_ reservation: CredentialReservation) throws {
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            let statement = try prepare(
                """
                UPDATE credential_revisions
                SET lifecycle_state = 'missing'
                WHERE profile_id = ? AND profile_revision = ? AND provider_id = ?
                  AND credential_ref = ? AND mutation_id = ?
                  AND lifecycle_state IN ('delete_pending', 'missing') AND tombstoned = 1
                  AND EXISTS (
                    SELECT 1 FROM credential_tombstones
                    WHERE profile_id = credential_revisions.profile_id
                      AND profile_revision = credential_revisions.profile_revision
                  )
                """,
                on: database
            )
            defer { sqlite3_finalize(statement) }
            try bind(reservation.identityParameters, to: statement)
            guard sqlite3_step(statement) == SQLITE_DONE, sqlite3_changes(database) == 1 else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
        }
    }

    func markCredentialUnavailable(_ reservation: CredentialReservation) throws {
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            let statement = try prepare(
                """
                UPDATE credential_revisions
                SET lifecycle_state = 'missing'
                WHERE profile_id = ? AND profile_revision = ? AND provider_id = ?
                  AND credential_ref = ? AND mutation_id = ?
                  AND lifecycle_state = 'ready' AND tombstoned = 0
                """,
                on: database
            )
            defer { sqlite3_finalize(statement) }
            try bind(reservation.identityParameters, to: statement)
            guard sqlite3_step(statement) == SQLITE_DONE, sqlite3_changes(database) == 1 else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
        }
    }

    func credentialReservationsForReconciliation() throws -> [CredentialReservation] {
        try serializationLock.withLock {
            guard let database else { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
            let statement = try prepare(
                """
                SELECT profile_id, profile_revision, provider_id, credential_ref, mutation_id,
                       lifecycle_state, tombstoned
                FROM credential_revisions current
                WHERE profile_revision = (
                  SELECT max(profile_revision) FROM credential_revisions
                  WHERE profile_id = current.profile_id
                )
                  AND EXISTS (
                    SELECT 1 FROM connection_profile_revisions profile
                    WHERE profile.profile_id = current.profile_id
                      AND profile.profile_revision = current.profile_revision
                      AND profile.provider_id = current.provider_id
                      AND profile.profile_revision = (
                        SELECT max(latest.profile_revision)
                        FROM connection_profile_revisions latest
                        WHERE latest.profile_id = profile.profile_id
                      )
                  )
                ORDER BY profile_id, profile_revision
                """,
                on: database
            )
            defer { sqlite3_finalize(statement) }
            var values: [CredentialReservation] = []
            try consumeSQLiteRows(step: { sqlite3_step(statement) }, onRow: {
                values.append(CredentialReservation(
                    profileId: columnText(statement, 0),
                    profileRevision: Int(sqlite3_column_int64(statement, 1)),
                    providerId: columnText(statement, 2),
                    credentialRef: columnText(statement, 3),
                    mutationId: columnText(statement, 4),
                    lifecycleState: columnText(statement, 5),
                    tombstoned: sqlite3_column_int(statement, 6) == 1
                ))
            }, failureCode: "credential_unavailable")
            return values
        }
    }

    private static let statements = [
        "append_event": "INSERT INTO events(room_id, sequence, event_json) SELECT id, next_event_sequence, ? FROM rooms WHERE id = ?",
        "create_room": "INSERT INTO rooms(id, title, status) VALUES (?, ?, 'active')",
        "create_human": "INSERT INTO participants(id, room_id, display_name, kind, sort_order) VALUES (?, ?, ?, 'human', 0)",
        "create_persona": "INSERT INTO participants(id, room_id, display_name, kind, sort_order, persona_slug) VALUES (?, ?, ?, 'persona', ?, ?)",
        "create_director_state": "INSERT INTO director_state(room_id) VALUES (?)",
        "create_connection_profile_revision": """
          INSERT INTO connection_profile_revisions(
            profile_id, profile_revision, provider_id, expected_prior_revision
          ) VALUES (?, ?, ?, ?)
          """,
        "reserve_credential": """
          INSERT INTO credential_revisions(
            profile_id, profile_revision, provider_id, credential_ref,
            expected_prior_revision, mutation_id, lifecycle_state
          ) VALUES (?, ?, ?, ?, ?, ?, 'credential_pending')
          """,
        "tombstone_credential": """
          INSERT INTO credential_tombstones(
            profile_id, profile_revision, provider_id, credential_ref, mutation_id
          ) VALUES (?, ?, ?, ?, ?)
          """,
        "select_room": "INSERT INTO current_room(singleton, room_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET room_id = excluded.room_id",
        "update_director_state": """
          UPDATE director_state
          SET state_json = ?, last_human_event_sequence = ?,
              last_speaker_id = CASE WHEN ? IS NULL THEN last_speaker_id ELSE ? END,
              autonomous_turns = ?, scheduling_window_generation = ?, updated_at = CURRENT_TIMESTAMP
          WHERE room_id = ? AND EXISTS (
            SELECT 1 FROM rooms WHERE id = director_state.room_id
              AND generation = ? AND next_event_sequence = ?
          )
          """
    ]

    private static let requiredSingleChangeStatements = Set([
        "append_event", "update_director_state", "create_connection_profile_revision", "reserve_credential",
        "tombstone_credential"
    ])

    private func applicationDirectory() throws -> URL {
        if let directoryOverride {
            try FileManager.default.createDirectory(at: directoryOverride, withIntermediateDirectories: true)
            return directoryOverride
        }
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
        try fileProtector(databaseURL)
    }

    private static func applyDatabaseFileProtection(_ databaseURL: URL) throws {
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
        let expectedFiles = [
            "0001-iphone-alpha.sql", "0002-ordered-events.sql",
            "0003-shared-director-state.sql", "0004-transaction-replay.sql",
            "0005-credential-lifecycle.sql"
        ]
        guard current <= 5,
              let manifestURL = migrationURL(file: "manifest.json"),
              let manifestData = try? Data(contentsOf: manifestURL),
              let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              manifest["schema"] as? Int == 5,
              let migrations = manifest["migrations"] as? [[String: Any]],
              migrations.count == expectedFiles.count else {
            throw DatabaseFailure(code: "migration_rejected", retryable: false)
        }
        for (index, migration) in migrations.enumerated() {
            let version = index + 1
            guard migration["version"] as? Int == version,
                  let file = migration["file"] as? String,
                  file == expectedFiles[index],
                  let expected = migration["sha256"] as? String,
                  let migrationURL = migrationURL(file: file),
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
        guard current == 5 else { throw DatabaseFailure(code: "migration_rejected", retryable: false) }
    }

    private func migrationURL(file: String) -> URL? {
        if let migrationsDirectoryOverride {
            return migrationsDirectoryOverride.appendingPathComponent(file)
        }
        let extensionName = (file as NSString).pathExtension
        let resource = (file as NSString).deletingPathExtension
        return Bundle.main.url(forResource: resource, withExtension: extensionName, subdirectory: "Migrations")
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

    private func encodedJSONObject(_ value: Any, code: String) throws -> Data {
        try encodedBridgeJSONObject(value, code: code)
    }

    private func requireEncodedBudget(
        _ value: Any,
        code: String,
        maximumBytes: Int = bridgeMaximumBytes
    ) throws {
        _ = try encodedBridgeJSONObject(value, code: code, maximumBytes: maximumBytes)
    }

    private func digest(_ statements: [[String: Any]]) throws -> String {
        let data = try encodedJSONObject(statements, code: "transaction_rejected")
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func priorTransaction(
        _ transactionId: String,
        on database: OpaquePointer
    ) throws -> (digest: String, result: [String: Any])? {
        let statement = try prepare(
            "SELECT request_digest, result_json FROM bridge_transactions WHERE transaction_id = ?",
            on: database
        )
        defer { sqlite3_finalize(statement) }
        try bind([transactionId], to: statement)
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW,
              let digestBytes = sqlite3_column_text(statement, 0),
              let resultBytes = sqlite3_column_text(statement, 1) else {
            throw DatabaseFailure(code: "database_unavailable", retryable: true)
        }
        let digest = String(cString: digestBytes)
        let resultLength = Int(sqlite3_column_bytes(statement, 1))
        guard resultLength <= bridgeMaximumBytes,
              let result = try? JSONSerialization.jsonObject(
                with: Data(bytes: resultBytes, count: resultLength)
              ) as? [String: Any] else {
            throw DatabaseFailure(code: "database_unavailable", retryable: false)
        }
        return (digest, result)
    }

    private func prepare(_ sql: String, on database: OpaquePointer) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw DatabaseFailure(code: "database_unavailable", retryable: true)
        }
        return statement
    }

    private func columnText(_ statement: OpaquePointer, _ index: Int32) -> String {
        guard let value = sqlite3_column_text(statement, index) else { return "" }
        return String(cString: value)
    }

    private func tombstoneMutationId(_ reservation: CredentialReservation, on database: OpaquePointer) throws -> String? {
        let statement = try prepare(
            "SELECT mutation_id FROM credential_tombstones WHERE profile_id = ? AND profile_revision = ?",
            on: database
        )
        defer { sqlite3_finalize(statement) }
        try bind([reservation.profileId, reservation.profileRevision], to: statement)
        if sqlite3_step(statement) == SQLITE_ROW { return columnText(statement, 0) }
        return nil
    }

    private func bind(_ parameters: [Any], to statement: OpaquePointer) throws {
        for (offset, value) in parameters.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            if let value = value as? String {
                let data = Data(value.utf8)
                guard data.count <= bridgeMaximumBytes else {
                    throw DatabaseFailure(code: "invalid_call", retryable: false)
                }
                if data.isEmpty {
                    result = sqlite3_bind_text(statement, index, "", 0, sqliteTransient)
                } else {
                    result = data.withUnsafeBytes { bytes in
                        sqlite3_bind_text(
                            statement,
                            index,
                            bytes.baseAddress!.assumingMemoryBound(to: CChar.self),
                            Int32(data.count),
                            sqliteTransient
                        )
                    }
                }
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

#if canImport(Capacitor)
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
    private let store = GreenRoomNativeAuthority.shared.database

    @objc func open(_ call: CAPPluginCall) {
        respond(call, method: "database.open") { payload in
            guard Set(payload.keys) == Set(["expectedSchema"]), let schema = payload["expectedSchema"] as? NSNumber else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            return try GreenRoomNativeAuthority.shared.openDatabase(expectedSchema: schema.intValue)
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        respond(call, method: "database.close") { payload in
            guard payload.isEmpty else { throw DatabaseFailure(code: "invalid_call", retryable: false) }
            return try GreenRoomNativeAuthority.shared.closeDatabase()
        }
    }

    @objc func checkpoint(_ call: CAPPluginCall) {
        respond(call, method: "database.checkpoint") { payload in
            guard payload.isEmpty else { throw DatabaseFailure(code: "invalid_call", retryable: false) }
            return try GreenRoomNativeAuthority.shared.withReconciledDatabase { try self.store.checkpoint() }
        }
    }

    @objc func executeBatch(_ call: CAPPluginCall) {
        respond(call, method: "database.executeBatch") { payload in
            guard Set(payload.keys) == Set(["transactionId", "statements"]),
                  let transactionId = payload["transactionId"] as? String,
                  let statements = payload["statements"] as? [[String: Any]] else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            return try GreenRoomNativeAuthority.shared.withReconciledDatabase {
                try self.store.executeBatch(transactionId: transactionId, statements: statements)
            }
        }
    }

    @objc func query(_ call: CAPPluginCall) {
        respond(call, method: "database.query") { payload in
            guard Set(payload.keys) == Set(["sqlId", "parameters"]),
                  let sqlId = payload["sqlId"] as? String,
                  let parameters = payload["parameters"] as? [Any] else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            let options = call.options as? [String: Any] ?? [:]
            let callId = options["callId"] as? String ?? "invalid"
            return try GreenRoomNativeAuthority.shared.withReconciledDatabase {
                try self.store.query(
                    sqlId: sqlId,
                    parameters: parameters,
                    maximumResultBytes: bridgeSuccessValueBudget(callId: callId)
                )
            }
        }
    }

    private func respond(_ call: CAPPluginCall, method: String, operation: ([String: Any]) throws -> [String: Any]) {
        let options = call.options as? [String: Any] ?? [:]
        let callId = canonicalBridgeCallId(options["callId"])
        guard callId != "invalid", GreenRoomNativeAuthority.shared.inFlightCalls.begin(callId) else {
            call.resolve(["callId": callId, "ok": false, "error": ["code": "invalid_call", "retryable": false]])
            return
        }
        defer { GreenRoomNativeAuthority.shared.inFlightCalls.finish(callId) }
        do {
            guard Set(options.keys) == Set(["contractVersion", "callId", "method", "payload"]),
                  options["method"] as? String == method,
                  callId != "invalid",
                  let payload = options["payload"] as? [String: Any] else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            guard options["contractVersion"] as? String == bridgeContractVersion else {
                throw DatabaseFailure(code: "incompatible_contract", retryable: false)
            }
            _ = try encodedBridgeJSONObject(options, code: "invalid_call")
            let response: [String: Any] = ["callId": callId, "ok": true, "value": try operation(payload)]
            _ = try encodedBridgeJSONObject(response, code: "result_too_large")
            call.resolve(response)
        } catch let failure as DatabaseFailure {
            call.resolve(["callId": callId, "ok": false, "error": ["code": failure.code, "retryable": failure.retryable]])
        } catch {
            call.resolve(["callId": callId, "ok": false, "error": ["code": "internal_failure", "retryable": false]])
        }
    }
}
#endif
