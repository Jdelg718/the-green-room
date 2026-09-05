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
    let runIdentifier: String
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
    var qualificationPlatform: String?
    var allSQLiteHandlesClosedBeforeLock: Bool?
    var protectedDataAvailableBeforeLock: Bool?
    var lockedProtectedDataUnavailable: Bool?
    var lockedRawReadDenied: Bool?
    var lockedSQLiteOpenDenied: Bool?
    var lockedSQLiteOpenCode: Int32?
    var lockedUnprotectedControlRawReadSucceeded: Bool?
    var lockedUnprotectedControlSQLiteOpenSucceeded: Bool?
    var unlockedProtectedDataAvailable: Bool?
    var reopenAfterUnlock: Bool?
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

    private static let unprotectedControlDatabaseName = "control.sqlite"

    // Intentionally unprotected evidence transport. Its locked readability is
    // transport behavior, not the independent unprotected control proof.
    private static var evidenceTransportDirectory: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent(directoryName, isDirectory: true)
    }

    private static var databaseDirectory: URL {
        evidenceTransportDirectory.appendingPathComponent("ProtectedDatabase", isDirectory: true)
    }

    private static var unprotectedControlDirectory: URL {
        evidenceTransportDirectory.appendingPathComponent("UnprotectedControl", isDirectory: true)
    }

    private static var databaseURL: URL { databaseDirectory.appendingPathComponent(databaseName) }
    private static var unprotectedControlDatabaseURL: URL {
        unprotectedControlDirectory.appendingPathComponent(unprotectedControlDatabaseName)
    }
    private static var evidenceURL: URL { evidenceTransportDirectory.appendingPathComponent(evidenceName) }

    static func run() throws -> SQLiteQualificationEvidence {
        try FileManager.default.createDirectory(
            at: evidenceTransportDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.none]
        )
        try FileManager.default.createDirectory(
            at: databaseDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        try FileManager.default.createDirectory(
            at: unprotectedControlDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.none]
        )

        if FileManager.default.fileExists(atPath: evidenceURL.path) {
            let data = try Data(contentsOf: evidenceURL)
            var prior = try JSONDecoder().decode(SQLiteQualificationEvidence.self, from: data)
#if !targetEnvironment(simulator)
            guard prior.runIdentifier == (try requiredRunIdentifier()) else {
                throw ProbeFailure.assertion("physical run identifier changed across launch")
            }
#endif
            if prior.status == "awaiting_forced_termination" {
                return try runRelaunch(prior: &prior)
            }
#if !targetEnvironment(simulator)
            if prior.status == "awaiting_lock" {
                return UIApplication.shared.isProtectedDataAvailable ? prior : try recordLockedAttempt(prior: &prior)
            }
            if prior.status == "awaiting_unlock" {
                return UIApplication.shared.isProtectedDataAvailable ? try recordUnlockedReopen(prior: &prior) : prior
            }
#endif
        }
        return try runFirstLaunch()
    }

    static func protectedDataWillBecomeUnavailable() throws -> SQLiteQualificationEvidence {
        var prior = try readEvidence()
        guard prior.status == "awaiting_lock" else {
            throw ProbeFailure.assertion("lock event received in unexpected state: \(prior.status)")
        }
        return try recordLockedAttempt(prior: &prior)
    }

    static func protectedDataDidBecomeAvailable() throws -> SQLiteQualificationEvidence {
        var prior = try readEvidence()
        guard prior.status == "awaiting_unlock" else {
            throw ProbeFailure.assertion("unlock event received in unexpected state: \(prior.status)")
        }
        return try recordUnlockedReopen(prior: &prior)
    }

    static func recordFailure(_ error: Error) {
        try? FileManager.default.createDirectory(
            at: evidenceTransportDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.none]
        )
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
        var active = [connection]
        do {
            let db = try connection.requireHandle()
            let marker = try scalarInt(db, "SELECT count(*) FROM persistence WHERE value = 4242")
            guard marker == 1 else { throw ProbeFailure.assertion("forced-relaunch marker missing") }
            try exec(db, "PRAGMA journal_mode = WAL")
            try exec(db, "INSERT INTO persistence(value) VALUES (8)")
            let sidecar = try openDatabase(databaseURL.path)
            active.append(sidecar)
            _ = try scalarInt(try sidecar.requireHandle(), "SELECT count(*) FROM persistence")
            try configureFiles()
#if targetEnvironment(simulator)
            prior.status = "complete"
#else
            prior.status = "awaiting_lock"
#endif
            prior.forcedTerminationRelaunch = true
            prior.filesAfterRelaunch = inspectFiles()
            try sidecar.checkedClose("forced-relaunch sidecar before lock")
            active.removeAll { $0 === sidecar }
            try connection.checkedClose("forced-relaunch primary before lock")
            active.removeAll { $0 === connection }
#if targetEnvironment(simulator)
            prior.qualificationPlatform = "simulator"
#else
            prior.qualificationPlatform = "physical"
            prior.allSQLiteHandlesClosedBeforeLock = true
            prior.protectedDataAvailableBeforeLock = UIApplication.shared.isProtectedDataAvailable
            guard prior.protectedDataAvailableBeforeLock == true else {
                throw ProbeFailure.assertion("protected data was unavailable before manual lock gate")
            }
#endif
            try writeEvidence(prior)
            return prior
        } catch {
            throw cleanup(active, after: error)
        }
    }

    private static func runFirstLaunch() throws -> SQLiteQualificationEvidence {
        guard retainedConnections.isEmpty else {
            throw ProbeFailure.assertion("first-launch proof already owns retained connections")
        }
        if FileManager.default.fileExists(atPath: databaseURL.path) {
            try FileManager.default.removeItem(at: databaseURL)
        }
        try initializeUnprotectedControl()

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
                runIdentifier: try requiredRunIdentifier(),
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
                qualificationPlatform: {
#if targetEnvironment(simulator)
                    "simulator"
#else
                    "physical"
#endif
                }(),
                allSQLiteHandlesClosedBeforeLock: nil,
                protectedDataAvailableBeforeLock: nil,
                lockedProtectedDataUnavailable: nil,
                lockedRawReadDenied: nil,
                lockedSQLiteOpenDenied: nil,
                lockedSQLiteOpenCode: nil,
                lockedUnprotectedControlRawReadSucceeded: nil,
                lockedUnprotectedControlSQLiteOpenSucceeded: nil,
                unlockedProtectedDataAvailable: nil,
                reopenAfterUnlock: nil,
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

    private static func initializeUnprotectedControl() throws {
        if FileManager.default.fileExists(atPath: unprotectedControlDatabaseURL.path) {
            try FileManager.default.removeItem(at: unprotectedControlDatabaseURL)
        }
        let connection = try openDatabase(unprotectedControlDatabaseURL.path)
        do {
            let db = try connection.requireHandle()
            try exec(db, "CREATE TABLE control(value INTEGER NOT NULL)")
            try exec(db, "INSERT INTO control(value) VALUES (4242)")
            try connection.checkedClose("unprotected control initialization")
        } catch {
            throw cleanup([connection], after: error)
        }
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.none], ofItemAtPath: unprotectedControlDatabaseURL.path
        )
#if !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(atPath: unprotectedControlDatabaseURL.path)
        guard String(describing: attributes[.protectionKey] ?? "") == "NSFileProtectionNone" else {
            throw ProbeFailure.assertion("unprotected control did not verify NSFileProtectionNone")
        }
#endif
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

    private static func readEvidence() throws -> SQLiteQualificationEvidence {
        try JSONDecoder().decode(SQLiteQualificationEvidence.self, from: Data(contentsOf: evidenceURL))
    }

    private static func requiredRunIdentifier() throws -> String {
#if targetEnvironment(simulator)
        return "simulator-run"
#else
        guard let value = ProcessInfo.processInfo.environment["SQLITE_CAPABILITY_RUN_ID"],
              value.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            throw ProbeFailure.assertion("missing or invalid physical run identifier")
        }
        return value
#endif
    }

    private static func recordLockedAttempt(prior: inout SQLiteQualificationEvidence) throws -> SQLiteQualificationEvidence {
        guard prior.qualificationPlatform == "physical" else {
            throw ProbeFailure.assertion("physical lock proof cannot consume non-physical evidence")
        }
        guard prior.allSQLiteHandlesClosedBeforeLock == true else {
            throw ProbeFailure.assertion("SQLite handles were not proven closed before lock")
        }
        guard !UIApplication.shared.isProtectedDataAvailable else {
            throw ProbeFailure.assertion("lock callback ran while protected data remained available")
        }

        let rawReadDenied: Bool
        do {
            _ = try Data(contentsOf: databaseURL)
            rawReadDenied = false
        } catch {
            rawReadDenied = true
        }
        var lockedHandle: OpaquePointer?
        let openCode = sqlite3_open_v2(
            databaseURL.path, &lockedHandle, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil
        )
        let sqliteDenied = openCode != SQLITE_OK
        if let lockedHandle {
            try CheckedSQLiteConnection(handle: lockedHandle).checkedClose("locked read-only open cleanup")
        }
        guard rawReadDenied && sqliteDenied else {
            throw ProbeFailure.assertion(
                "protected database remained accessible while locked (rawDenied=\(rawReadDenied), sqliteCode=\(openCode))"
            )
        }

        let controlData = try Data(contentsOf: unprotectedControlDatabaseURL)
        guard !controlData.isEmpty else {
            throw ProbeFailure.assertion("unprotected control raw read returned no bytes while locked")
        }
        var controlHandle: OpaquePointer?
        let controlOpenCode = sqlite3_open_v2(
            unprotectedControlDatabaseURL.path,
            &controlHandle,
            SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX,
            nil
        )
        guard controlOpenCode == SQLITE_OK, let controlHandle else {
            if let controlHandle {
                try CheckedSQLiteConnection(handle: controlHandle).checkedClose(
                    "failed locked unprotected control open cleanup"
                )
            }
            throw ProbeFailure.assertion(
                "unprotected control SQLite open failed while locked (rc=\(controlOpenCode))"
            )
        }
        let controlConnection = CheckedSQLiteConnection(handle: controlHandle)
        do {
            let marker = try scalarInt(controlHandle, "SELECT count(*) FROM control WHERE value = 4242")
            guard marker == 1 else {
                throw ProbeFailure.assertion("unprotected control marker missing while locked")
            }
            try controlConnection.checkedClose("locked unprotected control read")
        } catch {
            throw cleanup([controlConnection], after: error)
        }
        prior.lockedProtectedDataUnavailable = true
        prior.lockedRawReadDenied = true
        prior.lockedSQLiteOpenDenied = true
        prior.lockedSQLiteOpenCode = openCode
        prior.lockedUnprotectedControlRawReadSucceeded = true
        prior.lockedUnprotectedControlSQLiteOpenSucceeded = true
        prior.status = "awaiting_unlock"
        try writeEvidence(prior)
        return prior
    }

    private static func recordUnlockedReopen(prior: inout SQLiteQualificationEvidence) throws -> SQLiteQualificationEvidence {
        guard prior.qualificationPlatform == "physical",
              prior.lockedProtectedDataUnavailable == true,
              prior.lockedRawReadDenied == true,
              prior.lockedSQLiteOpenDenied == true,
              prior.lockedUnprotectedControlRawReadSucceeded == true,
              prior.lockedUnprotectedControlSQLiteOpenSucceeded == true else {
            throw ProbeFailure.assertion("unlock proof lacks locked denial and unprotected control success")
        }
        guard UIApplication.shared.isProtectedDataAvailable else {
            throw ProbeFailure.assertion("protected data is still unavailable after unlock")
        }
        let connection = try openDatabase(databaseURL.path)
        do {
            let marker = try scalarInt(
                try connection.requireHandle(), "SELECT count(*) FROM persistence WHERE value = 4242"
            )
            guard marker == 1 else { throw ProbeFailure.assertion("marker missing after unlock") }
            try connection.checkedClose("post-unlock reopen")
        } catch {
            throw cleanup([connection], after: error)
        }
        prior.unlockedProtectedDataAvailable = true
        prior.reopenAfterUnlock = true
        prior.status = "complete"
        try writeEvidence(prior)
        return prior
    }

    private static func writeEvidence(_ evidence: SQLiteQualificationEvidence) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(evidence)
        try data.write(to: evidenceURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.none], ofItemAtPath: evidenceURL.path
        )
    }
}
