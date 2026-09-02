import CryptoKit
import Foundation
import XCTest
@testable import GreenRoomLauncher

final class LauncherTests: XCTestCase {
    private var temporaryDirectories: [URL] = []

    override func tearDownWithError() throws {
        for directory in temporaryDirectories {
            try? FileManager.default.removeItem(at: directory)
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
