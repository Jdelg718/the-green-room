import CryptoKit
import Foundation
import Security
import XCTest
@testable import GreenRoomLauncher

final class LauncherTests: XCTestCase {
    private var temporaryDirectories: [URL] = []

    override func tearDownWithError() throws {
        for directory in temporaryDirectories {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func testReadinessTokenGenerationIsExactly256BitsAndFailsClosed() throws {
        let token = try ReadinessToken.generate { raw in
            raw.initializeMemory(as: UInt8.self, repeating: 0xa5)
            return errSecSuccess
        }
        XCTAssertEqual(token, Data(repeating: 0xa5, count: 32))
        XCTAssertThrowsError(try ReadinessToken.generate { _ in errSecParam }) { error in
            XCTAssertEqual(error as? LauncherError, .randomFailed)
        }
    }

    func testReadinessProtocolAuthenticatesExactFragmentedPIDBoundFrame() throws {
        let token = Data((0..<32).map(UInt8.init))
        let challenge = ReadinessProtocol.challengeFrame(token: token)
        XCTAssertEqual(challenge.count, 40)
        XCTAssertEqual(Array(challenge.prefix(8)), [0x47, 0x52, 0x52, 0x44, 1, 1, 0, 32])
        let ready = ReadinessProtocol.readyFrameForTest(token: token, pid: 0x01020304)
        XCTAssertNoThrow(try ReadinessProtocol.validateReady(ready, token: token, pid: 0x01020304))
        XCTAssertEqual(ready.count, 44)
    }

    func testReadinessProtocolRejectsWrongTokenPIDHeaderTruncationTrailingAndDuplicate() throws {
        let token = Data(repeating: 0x5a, count: 32)
        let valid = ReadinessProtocol.readyFrameForTest(token: token, pid: 42)
        var badHeader = valid; badHeader[0] = 0
        var wrongVersion = valid; wrongVersion[4] = 2
        var wrongType = valid; wrongType[5] = 1
        var wrongLength = valid; wrongLength[7] = 35
        let cases = [
            badHeader, wrongVersion, wrongType, wrongLength, Data(valid.dropLast()),
            valid + Data([0]), valid + valid,
            ReadinessProtocol.readyFrameForTest(token: Data(repeating: 0x5b, count: 32), pid: 42),
            ReadinessProtocol.readyFrameForTest(token: token, pid: 43),
        ]
        for frame in cases {
            XCTAssertThrowsError(try ReadinessProtocol.validateReady(frame, token: token, pid: 42))
        }
    }

    func testResolvesOnlySignedBundleRelativeLayout() throws {
        let bundle = try makeBundle()
        let executable = bundle.appendingPathComponent("Contents/MacOS/GreenRoomLauncher")

        XCTAssertEqual(try LauncherPreflight.bundleRoot(forExecutable: executable), bundle)
        XCTAssertThrowsError(
            try LauncherPreflight.bundleRoot(
                forExecutable: bundle.appendingPathComponent("GreenRoomLauncher")
            )
        ) { error in
            XCTAssertEqual(error as? LauncherError, .invalidBundleLayout)
        }
    }

    func testMissingAndTamperedManifestFailClosed() throws {
        let bundle = try makeBundle()

        XCTAssertThrowsError(try LauncherPreflight.validate(bundleRoot: bundle)) { error in
            XCTAssertEqual(error as? LauncherError, .manifestMissing)
        }

        let payload = bundle.appendingPathComponent("Contents/Resources/runtime/node")
        try write(Data("trusted payload".utf8), to: payload)
        try writeManifest(to: bundle, files: [
            ["path": "Contents/Resources/runtime/node", "sha256": sha256(Data("trusted payload".utf8))],
        ])
        _ = try LauncherPreflight.validate(bundleRoot: bundle)

        try Data("tampered payload".utf8).write(to: payload)
        XCTAssertThrowsError(try LauncherPreflight.validate(bundleRoot: bundle)) { error in
            guard case .payloadInvalid(let code) = error as? LauncherError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(code, "digest_mismatch:Contents/Resources/runtime/node")
        }
    }

    func testManifestRejectsUnknownFieldsMalformedPathsAndSymlinks() throws {
        let bundle = try makeBundle()
        let payload = bundle.appendingPathComponent("Contents/Resources/runtime/node")
        try write(Data("payload".utf8), to: payload)

        try writeManifest(to: bundle, files: [
            ["path": "Contents/../escape", "sha256": sha256(Data("payload".utf8))],
        ])
        XCTAssertThrowsError(try LauncherPreflight.validate(bundleRoot: bundle))

        try writeManifest(to: bundle, files: [
            ["path": "Contents/Resources/runtime/node", "sha256": sha256(Data("payload".utf8)), "extra": true],
        ])
        XCTAssertThrowsError(try LauncherPreflight.validate(bundleRoot: bundle))

        let target = bundle.appendingPathComponent("Contents/Resources/runtime/target")
        try write(Data("payload".utf8), to: target)
        try FileManager.default.removeItem(at: payload)
        try FileManager.default.createSymbolicLink(at: payload, withDestinationURL: target)
        try writeManifest(to: bundle, files: [
            ["path": "Contents/Resources/runtime/node", "sha256": sha256(Data("payload".utf8))],
        ])
        XCTAssertThrowsError(try LauncherPreflight.validate(bundleRoot: bundle))
    }

    func testInvocationRejectsArgumentsAndInheritedRuntimeOverrides() throws {
        let executable = "/Applications/The Green Room.app/Contents/MacOS/GreenRoomLauncher"
        XCTAssertNoThrow(try LauncherInvocation.validate(arguments: [executable], environment: [:]))
        XCTAssertThrowsError(try LauncherInvocation.validate(arguments: ["GreenRoomLauncher"], environment: [:]))
        XCTAssertThrowsError(
            try LauncherInvocation.validate(arguments: [executable, "--host", "127.0.0.1"], environment: [:])
        )

        let forbidden = [
            "GREENROOM_PACKAGE_PAYLOAD_ROOT", "GREENROOM_HOST", "GREENROOM_ALLOWED_ORIGIN",
            "GREENROOM_PERSONA_VALIDATOR_EXECUTABLE", "GREENROOM_DATA_DIR", "GREENROOM_RUNTIME_MODE",
            "GREENROOM_READINESS_TOKEN", "GREENROOM_READINESS_FD", "GREENROOM_READINESS_TIMEOUT_MS",
            "NODE_OPTIONS", "NODE_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
        ]
        for key in forbidden {
            XCTAssertThrowsError(
                try LauncherInvocation.validate(arguments: [executable], environment: [key: "attacker"]),
                "expected \(key) to be rejected"
            )
        }
        XCTAssertThrowsError(
            try LauncherInvocation.validate(arguments: [executable], environment: ["GREENROOM_FUTURE_OVERRIDE": "attacker"])
        )
    }

    func testDarwinSpawnUsesPrivateGroupLiteralArgumentsMinimalEnvironmentAndSafeCWD() throws {
        let cwd = try makeDirectory(named: "safe cwd ;$()")
        let result = try SupervisedProcess.runForTest(
            executable: try fixtureExecutable(),
            arguments: ["report", "space ;$(touch nope)", "雪"],
            environment: ["LANG": "C.UTF-8", "GREENROOM_RUNTIME_MODE": "packaged-macos"],
            cwd: cwd.path,
            grace: .milliseconds(200)
        )
        let output = String(decoding: result.stdout.retained, as: UTF8.self)
        XCTAssertTrue(output.contains("pgid=\(result.pid)"), output)
        XCTAssertTrue(output.contains("cwd=\(try canonicalPath(cwd.path))"), output)
        XCTAssertTrue(output.contains("space ;$(touch nope)|雪"), output)
        XCTAssertTrue(output.contains("env=GREENROOM_RUNTIME_MODE,LANG"), output)
        for forbidden in ["PATH", "NODE_OPTIONS", "NODE_PATH", "DYLD_", "npm_", "PYTHON", "PEX_", "SECRET_SENTINEL"] {
            XCTAssertFalse(output.contains(forbidden), "leaked \(forbidden): \(output)")
        }
        XCTAssertTrue(output.contains("fds=0,1,2"), output)
        XCTAssertEqual(result.stdout.discardedBytes, 0)
    }

    func testConcurrentBoundedDrainsContinueThroughBinaryFlood() throws {
        let result = try SupervisedProcess.runForTest(
            executable: try fixtureExecutable(), arguments: ["flood"], environment: [:],
            cwd: try makeDirectory(named: "flood").path, grace: .milliseconds(200), outputLimit: 8_192
        )
        XCTAssertLessThanOrEqual(result.stdout.retained.count, 8_192)
        XCTAssertLessThanOrEqual(result.stderr.retained.count, 8_192)
        XCTAssertGreaterThan(result.stdout.discardedBytes, 1_000_000)
        XCTAssertGreaterThan(result.stderr.discardedBytes, 1_000_000)
    }

    func testTERMThenKILLRemovesStubbornGroupAndReapsLeader() throws {
        let started = ContinuousClock.now
        let result = try SupervisedProcess.runForTest(
            executable: try fixtureExecutable(), arguments: ["stubborn"], environment: [:],
            cwd: try makeDirectory(named: "stubborn").path, grace: .milliseconds(150), shutdownAfter: .milliseconds(30)
        )
        XCTAssertTrue(result.termSent)
        XCTAssertTrue(result.killSent)
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - started, .milliseconds(150))
        XCTAssertEqual(killpg(result.pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
    }

    func testLauncherLifetimeEOFTriggersCooperativeGroupShutdown() throws {
        var lifetime = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(pipe(&lifetime), 0)
        let writer = lifetime[1]
        DispatchQueue.global().async {
            usleep(40_000)
            close(writer)
        }
        defer { close(lifetime[0]) }
        let result = try SupervisedProcess.runForTest(
            executable: try fixtureExecutable(), arguments: ["descendant"], environment: [:],
            cwd: try makeDirectory(named: "lifetime").path, grace: .milliseconds(200), lifetimeFD: lifetime[0]
        )
        XCTAssertTrue(result.termSent)
        XCTAssertFalse(result.killSent)
        XCTAssertEqual(killpg(result.pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
    }

    func testTERMStopsLiveCooperativeLeaderAndDescendantWithoutKILL() throws {
        let result = try SupervisedProcess.runForTest(
            executable: try fixtureExecutable(), arguments: ["cooperative-descendant"], environment: [:],
            cwd: try makeDirectory(named: "cooperative-descendant").path,
            grace: .milliseconds(500), shutdownAfter: .milliseconds(500)
        )
        let output = String(decoding: result.stdout.retained, as: UTF8.self)
        let processIDs = output.split(separator: "\n").compactMap { line -> pid_t? in
            guard line.hasPrefix("ready "), let value = line.split(separator: " ").last else { return nil }
            return pid_t(value)
        }
        XCTAssertEqual(processIDs.count, 2, output)
        XCTAssertTrue(result.termSent)
        XCTAssertFalse(result.killSent)
        for processID in processIDs {
            XCTAssertEqual(kill(processID, 0), -1, "PID \(processID) survived TERM")
            XCTAssertEqual(errno, ESRCH)
        }
        XCTAssertEqual(killpg(result.pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
    }

    func testLeaderExitTriggersCleanupOfStubbornDescendant() throws {
        let result = try SupervisedProcess.runForTest(
            executable: try fixtureExecutable(), arguments: ["stubborn-descendant"], environment: [:],
            cwd: try makeDirectory(named: "descendant").path, grace: .milliseconds(150)
        )
        XCTAssertTrue(result.termSent)
        XCTAssertTrue(result.killSent)
        XCTAssertEqual(killpg(result.pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
    }

    func testFastExitIsReapedAndDoesNotLeakGroup() throws {
        let result = try SupervisedProcess.runForTest(
            executable: try fixtureExecutable(), arguments: ["fast-exit"], environment: [:],
            cwd: try makeDirectory(named: "fast").path, grace: .milliseconds(100)
        )
        XCTAssertTrue(result.reaped)
        XCTAssertEqual(killpg(result.pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
    }

    private func fixtureExecutable() throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let candidate = packageRoot.appendingPathComponent(".build/debug/ProcessFixture").resolvingSymlinksInPath().path
        guard FileManager.default.isExecutableFile(atPath: candidate) else {
            XCTFail("fixture executable unavailable at \(candidate)")
            throw CocoaError(.fileNoSuchFile)
        }
        return candidate
    }

    private func makeDirectory(named name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("GreenRoomSupervisor-\(UUID().uuidString)")
        let directory = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        temporaryDirectories.append(root)
        return directory
    }

    private func canonicalPath(_ path: String) throws -> String {
        guard let pointer = realpath(path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(pointer) }
        return String(cString: pointer)
    }

    private func makeBundle() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("Green Room Launcher Tests-\(UUID().uuidString)", isDirectory: true)
        let bundle = root.appendingPathComponent("The Green Room.app", isDirectory: true)
        try FileManager.default.createDirectory(
            at: bundle.appendingPathComponent("Contents/MacOS", isDirectory: true),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: bundle.appendingPathComponent("Contents/Resources", isDirectory: true),
            withIntermediateDirectories: true
        )
        temporaryDirectories.append(root)
        return bundle
    }

    private func writeManifest(to bundle: URL, files: [[String: Any]]) throws {
        let manifest: [String: Any] = [
            "schemaVersion": 1,
            "bundleIdentifier": "net.greenroomai.GreenRoom",
            "appVersion": "0.1.0-alpha.1",
            "sourceCommit": String(repeating: "a", count: 40),
            "buildEpoch": 1_788_255_600,
            "targetTriple": "arm64-apple-darwin",
            "runtimes": [
                "nodeVersion": "24.20.0",
                "pythonVersion": "3.11.15",
                "validatorVersion": "0.1.0",
            ],
            "databaseSchema": ["minimum": 1, "maximum": 3],
            "files": files,
        ]
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        try data.write(to: bundle.appendingPathComponent(LauncherPreflight.manifestRelativePath))
    }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
