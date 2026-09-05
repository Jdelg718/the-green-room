import Foundation
import SQLite3
import UIKit

struct FileCapabilityEvidence: Codable {
    let exists: Bool
    let requestedProtection: String
    let observedProtection: String
    let protectionVerified: Bool
    let excludedFromBackup: Bool?
}

struct SQLiteQualificationEvidence: Codable {
    var status: String
    let generatedAt: String
    let deviceReportedModel: String
    let deviceReportedSystemName: String
    let deviceReportedSystemVersion: String
    let sqliteVersion: String
    let compileOptions: [String]
    let strictTables: Bool
    let jsonFunctions: Bool
    let returning: Bool
    let foreignKeys: Bool
    let wal: Bool
    let busyTimeout: Bool
    let busyElapsedMilliseconds: Int
    let beginImmediateContention: Bool
    let rollback: Bool
    let checkpoint: Bool
    let reopenPersistence: Bool
    var forcedTerminationRelaunch: Bool
    let firstLaunchFiles: [String: FileCapabilityEvidence]
    var filesAfterRelaunch: [String: FileCapabilityEvidence]?
    var failure: String?
}

enum ProbeFailure: Error, CustomStringConvertible {
    case sqlite(String)
    case assertion(String)

    var description: String {
        switch self {
        case .sqlite(let message): return "sqlite failure: \(message)"
        case .assertion(let message): return "assertion failure: \(message)"
        }
    }
}

private final class CheckedSQLiteConnection {
    private(set) var handle: OpaquePointer?

    init(handle: OpaquePointer) { self.handle = handle }

    func requireHandle() throws -> OpaquePointer {
        guard let handle else { throw ProbeFailure.assertion("attempted to use a closed SQLite connection") }
        return handle
    }

    func checkedClose(_ context: String) throws {
        guard let handle else { return }
        let closeCode = sqlite3_close(handle)
        if closeCode == SQLITE_OK {
            self.handle = nil
            return
        }

        // sqlite3_close() leaves the handle valid on failure. Queue destruction as a
        // cleanup fallback, but still fail the proof because the checked close failed.
        let closeV2Code = sqlite3_close_v2(handle)
        if closeV2Code == SQLITE_OK { self.handle = nil }
        throw ProbeFailure.sqlite(
            "\(context) close rc=\(closeCode), cleanup close_v2 rc=\(closeV2Code)"
        )
    }

    deinit {
        // All normal and throwing paths close explicitly. This is a final safety net
        // for process teardown, never the basis for a successful qualification.
        if let handle { _ = sqlite3_close_v2(handle) }
    }
}

@MainActor
enum SQLiteCapabilityProbe {
    private static let directoryName = "SQLiteCapabilitySpike"
    private static let databaseName = "capability.sqlite"
    private static let evidenceName = "qualification-evidence.json"
    private static let busyTimeoutMilliseconds: Int32 = 125
    private static let busyElapsedLowerBoundMilliseconds = 80
    private static let busyElapsedUpperBoundMilliseconds = 2_000
    private static var retainedConnections: [CheckedSQLiteConnection] = []
    private static var failedCleanupQuarantine: [CheckedSQLiteConnection] = []

    private static var directory: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent(directoryName, isDirectory: true)
    }

    private static var databaseURL: URL { directory.appendingPathComponent(databaseName) }
    private static var evidenceURL: URL { directory.appendingPathComponent(evidenceName) }

    static func run() throws -> SQLiteQualificationEvidence {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )

        if FileManager.default.fileExists(atPath: evidenceURL.path) {
            let data = try Data(contentsOf: evidenceURL)
            var prior = try JSONDecoder().decode(SQLiteQualificationEvidence.self, from: data)
            if prior.status == "awaiting_forced_termination" {
                return try runRelaunch(prior: &prior)
            }
        }
        return try runFirstLaunch()
    }

    static func recordFailure(_ error: Error) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let payload: [String: Any] = [
            "status": "failed",
            "failure": String(describing: error),
            "generatedAt": ISO8601DateFormatter().string(from: Date())
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: evidenceURL, options: .atomic)
        }
    }

    private static func runRelaunch(prior: inout SQLiteQualificationEvidence) throws -> SQLiteQualificationEvidence {
        let connection = try openDatabase(databaseURL.path)
        do {
            let db = try connection.requireHandle()
            let marker = try scalarInt(db, "SELECT count(*) FROM persistence WHERE value = 4242")
            guard marker == 1 else { throw ProbeFailure.assertion("forced-relaunch marker missing") }
            try configureFiles()
            prior.status = "complete"
            prior.forcedTerminationRelaunch = true
            prior.filesAfterRelaunch = inspectFiles()
            try connection.checkedClose("forced-relaunch")
            try writeEvidence(prior)
            return prior
        } catch {
            throw cleanup([connection], after: error)
        }
    }

    private static func runFirstLaunch() throws -> SQLiteQualificationEvidence {
        guard retainedConnections.isEmpty else {
            throw ProbeFailure.assertion("first-launch proof already owns retained connections")
        }
        if FileManager.default.fileExists(atPath: databaseURL.path) {
            try FileManager.default.removeItem(at: databaseURL)
        }

        var active: [CheckedSQLiteConnection] = []
        do {
            let primary = try openDatabase(databaseURL.path)
            active.append(primary)
            let db = try primary.requireHandle()
            try exec(db, "PRAGMA foreign_keys = ON")
            try exec(db, "PRAGMA synchronous = FULL")
            let walMode = try scalarText(db, "PRAGMA journal_mode = WAL").lowercased() == "wal"
            guard walMode else { throw ProbeFailure.assertion("WAL mode unavailable") }

            let version = String(cString: sqlite3_libversion())
            let options = try rowsOfText(db, "PRAGMA compile_options").sorted()

            try exec(db, "CREATE TABLE capability_strict(value INTEGER NOT NULL) STRICT")
            let strictFailure = sqlite3_exec(db, "INSERT INTO capability_strict(value) VALUES ('not-an-integer')", nil, nil, nil)
            let strictTables = strictFailure == SQLITE_CONSTRAINT
            guard strictTables else { throw ProbeFailure.assertion("STRICT table accepted text as INTEGER") }

            let jsonFunctions = try scalarText(db, "SELECT json_extract('{\"floor\":42}', '$.floor')") == "42"
            guard jsonFunctions else { throw ProbeFailure.assertion("JSON function result mismatch") }

            try exec(db, "CREATE TABLE returning_test(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            let returning = try scalarInt(db, "INSERT INTO returning_test(value) VALUES ('ok') RETURNING id") == 1
            guard returning else { throw ProbeFailure.assertion("RETURNING result mismatch") }

            try exec(db, "CREATE TABLE parent(id INTEGER PRIMARY KEY)")
            try exec(db, "CREATE TABLE child(parent_id INTEGER NOT NULL REFERENCES parent(id))")
            let foreignKeyFailure = sqlite3_exec(db, "INSERT INTO child(parent_id) VALUES (999)", nil, nil, nil)
            let foreignKeys = foreignKeyFailure == SQLITE_CONSTRAINT
            guard foreignKeys else { throw ProbeFailure.assertion("foreign key violation was accepted") }

            try exec(db, "CREATE TABLE rollback_test(value INTEGER NOT NULL)")
            try exec(db, "BEGIN IMMEDIATE")
            try exec(db, "INSERT INTO rollback_test(value) VALUES (1)")
            try exec(db, "ROLLBACK")
            let rollback = try scalarInt(db, "SELECT count(*) FROM rollback_test") == 0
            guard rollback else { throw ProbeFailure.assertion("rollback retained an inserted row") }

            let contender = try openDatabase(databaseURL.path)
            active.append(contender)
            let contenderDB = try contender.requireHandle()
            let timeoutCode = sqlite3_busy_timeout(contenderDB, busyTimeoutMilliseconds)
            guard timeoutCode == SQLITE_OK else {
                throw ProbeFailure.sqlite("sqlite3_busy_timeout rc=\(timeoutCode)")
            }
            try exec(db, "BEGIN IMMEDIATE")
            let started = DispatchTime.now().uptimeNanoseconds
            let contentionCode = sqlite3_exec(contenderDB, "BEGIN IMMEDIATE", nil, nil, nil)
            let elapsed = Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
            if contentionCode == SQLITE_OK { try exec(contenderDB, "ROLLBACK") }
            try exec(db, "ROLLBACK")
            let contention = contentionCode == SQLITE_BUSY || contentionCode == SQLITE_LOCKED
            let busyTimeout = contention
                && elapsed >= busyElapsedLowerBoundMilliseconds
                && elapsed <= busyElapsedUpperBoundMilliseconds
            guard busyTimeout else {
                throw ProbeFailure.assertion(
                    "BEGIN IMMEDIATE busy bound failed (rc=\(contentionCode), elapsed=\(elapsed)ms, expected=\(busyElapsedLowerBoundMilliseconds)...\(busyElapsedUpperBoundMilliseconds)ms)"
                )
            }

            try exec(db, "CREATE TABLE persistence(value INTEGER NOT NULL)")
            try exec(db, "INSERT INTO persistence(value) VALUES (4242)")
            var logFrames: Int32 = -1
            var checkpointedFrames: Int32 = -1
            let checkpointCode = sqlite3_wal_checkpoint_v2(
                db, nil, SQLITE_CHECKPOINT_TRUNCATE, &logFrames, &checkpointedFrames
            )
            let checkpoint = checkpointCode == SQLITE_OK
            guard checkpoint else { throw ProbeFailure.sqlite("checkpoint rc=\(checkpointCode)") }

            try contender.checkedClose("contention connection before reopen proof")
            active.removeAll { $0 === contender }
            try primary.checkedClose("original connection before reopen proof")
            active.removeAll { $0 === primary }

            let reopened = try openDatabase(databaseURL.path)
            active.append(reopened)
            let reopenedDB = try reopened.requireHandle()
            let reopenPersistence = try scalarInt(reopenedDB, "SELECT count(*) FROM persistence WHERE value = 4242") == 1
            guard reopenPersistence else { throw ProbeFailure.assertion("reopen did not retain marker") }
            try exec(reopenedDB, "PRAGMA journal_mode = WAL")
            try exec(reopenedDB, "INSERT INTO persistence(value) VALUES (7)")

            let sidecar = try openDatabase(databaseURL.path)
            active.append(sidecar)
            _ = try scalarInt(try sidecar.requireHandle(), "SELECT count(*) FROM persistence")
            try configureFiles()

            let evidence = SQLiteQualificationEvidence(
                status: "awaiting_forced_termination",
                generatedAt: ISO8601DateFormatter().string(from: Date()),
                deviceReportedModel: UIDevice.current.model,
                deviceReportedSystemName: UIDevice.current.systemName,
                deviceReportedSystemVersion: UIDevice.current.systemVersion,
                sqliteVersion: version,
                compileOptions: options,
                strictTables: strictTables,
                jsonFunctions: jsonFunctions,
                returning: returning,
                foreignKeys: foreignKeys,
                wal: walMode,
                busyTimeout: busyTimeout,
                busyElapsedMilliseconds: elapsed,
                beginImmediateContention: contention,
                rollback: rollback,
                checkpoint: checkpoint,
                reopenPersistence: reopenPersistence,
                forcedTerminationRelaunch: false,
                firstLaunchFiles: inspectFiles(),
                filesAfterRelaunch: nil,
                failure: nil
            )
            try writeEvidence(evidence)

            // Transfer only the two deliberately live WAL connections after every
            // fallible proof/evidence operation has succeeded.
            retainedConnections = active
            active.removeAll()
            return evidence
        } catch {
            throw cleanup(active, after: error)
        }
    }

    private static func cleanup(_ connections: [CheckedSQLiteConnection], after original: Error) -> Error {
        var failures: [String] = []
        for (index, connection) in connections.reversed().enumerated() {
            do { try connection.checkedClose("throw cleanup connection \(index)") }
            catch { failures.append(String(describing: error)) }
        }
        guard !failures.isEmpty else { return original }
        return ProbeFailure.sqlite("\(original); cleanup failures: \(failures.joined(separator: "; "))")
    }

    private static func openDatabase(_ path: String) throws -> CheckedSQLiteConnection {
        var opened: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let openCode = sqlite3_open_v2(path, &opened, flags, nil)
        guard let opened else {
            throw ProbeFailure.sqlite("open rc=\(openCode): no database handle")
        }
        let connection = CheckedSQLiteConnection(handle: opened)
        guard openCode == SQLITE_OK else {
            let message = String(cString: sqlite3_errmsg(opened))
            do {
                try connection.checkedClose("failed open")
            } catch {
                // Preserve ownership if even sqlite3_close_v2 rejected the valid
                // handle. The proof fails and process teardown gets another close.
                if connection.handle != nil { failedCleanupQuarantine.append(connection) }
                throw ProbeFailure.sqlite("open rc=\(openCode): \(message); \(error)")
            }
            throw ProbeFailure.sqlite("open rc=\(openCode): \(message); failed handle closed")
        }
        return connection
    }

    private static func exec(_ db: OpaquePointer, _ sql: String) throws {
        let code = sqlite3_exec(db, sql, nil, nil, nil)
        guard code == SQLITE_OK else {
            throw ProbeFailure.sqlite("rc=\(code): \(String(cString: sqlite3_errmsg(db)))")
        }
    }

    private static func withStatement<T>(
        _ db: OpaquePointer,
        _ sql: String,
        _ body: (OpaquePointer) throws -> T
    ) throws -> T {
        var statement: OpaquePointer?
        let prepareCode = sqlite3_prepare_v2(db, sql, -1, &statement, nil)
        guard prepareCode == SQLITE_OK, let statement else {
            throw ProbeFailure.sqlite("prepare rc=\(prepareCode): \(String(cString: sqlite3_errmsg(db)))")
        }
        let result: T
        do {
            result = try body(statement)
        } catch {
            let finalizeCode = sqlite3_finalize(statement)
            if finalizeCode != SQLITE_OK {
                throw ProbeFailure.sqlite("\(error); finalize cleanup rc=\(finalizeCode)")
            }
            throw error
        }
        let finalizeCode = sqlite3_finalize(statement)
        guard finalizeCode == SQLITE_OK else {
            throw ProbeFailure.sqlite("finalize rc=\(finalizeCode): \(String(cString: sqlite3_errmsg(db)))")
        }
        return result
    }

    private static func scalarInt(_ db: OpaquePointer, _ sql: String) throws -> Int64 {
        try withStatement(db, sql) { statement in
            let stepCode = sqlite3_step(statement)
            guard stepCode == SQLITE_ROW else {
                throw ProbeFailure.sqlite("step rc=\(stepCode): \(String(cString: sqlite3_errmsg(db)))")
            }
            return sqlite3_column_int64(statement, 0)
        }
    }

    private static func scalarText(_ db: OpaquePointer, _ sql: String) throws -> String {
        try withStatement(db, sql) { statement in
            let stepCode = sqlite3_step(statement)
            guard stepCode == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else {
                throw ProbeFailure.sqlite("text step rc=\(stepCode): \(String(cString: sqlite3_errmsg(db)))")
            }
            return String(cString: text)
        }
    }

    private static func rowsOfText(_ db: OpaquePointer, _ sql: String) throws -> [String] {
        try withStatement(db, sql) { statement in
            var rows: [String] = []
            while true {
                let code = sqlite3_step(statement)
                if code == SQLITE_DONE { return rows }
                guard code == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else {
                    throw ProbeFailure.sqlite("row step rc=\(code): \(String(cString: sqlite3_errmsg(db)))")
                }
                rows.append(String(cString: text))
            }
        }
    }

    private static func sqliteFiles() -> [(String, URL)] {
        [
            ("database", databaseURL),
            ("wal", URL(fileURLWithPath: databaseURL.path + "-wal")),
            ("shm", URL(fileURLWithPath: databaseURL.path + "-shm"))
        ]
    }

    private static func configureFiles() throws {
        for (_, url) in sqliteFiles() {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw ProbeFailure.assertion("expected SQLite file missing: \(url.lastPathComponent)")
            }
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableURL = url
            try mutableURL.setResourceValues(values)
        }
    }

    private static func inspectFiles() -> [String: FileCapabilityEvidence] {
        Dictionary(uniqueKeysWithValues: sqliteFiles().map { name, url in
            let exists = FileManager.default.fileExists(atPath: url.path)
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            let protection = attributes?[.protectionKey].map { String(describing: $0) }
            let backup = try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
            let observed = protection ?? "not_exposed_by_simulator"
            return (name, FileCapabilityEvidence(
                exists: exists,
                requestedProtection: "NSFileProtectionComplete",
                observedProtection: observed,
                protectionVerified: observed == "NSFileProtectionComplete",
                excludedFromBackup: backup ?? nil
            ))
        })
    }

    private static func writeEvidence(_ evidence: SQLiteQualificationEvidence) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(evidence)
        try data.write(to: evidenceURL, options: .atomic)
    }
}
