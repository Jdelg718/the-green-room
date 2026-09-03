import Foundation
import Security
import XCTest
@testable import GreenRoomCredentialHelper

private final class FakeCredentialBackend: CredentialBackend {
    var values: [String: Data] = [:]
    var nextStatus: OSStatus?
    func add(account: String, secret: Data) -> OSStatus {
        if let status = nextStatus { nextStatus = nil; return status }
        guard values[account] == nil else { return errSecDuplicateItem }
        values[account] = secret; return errSecSuccess
    }
    func get(account: String) -> (OSStatus, Data?) {
        guard let value = values[account] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, value)
    }
    func replace(account: String, secret: Data) -> OSStatus {
        if let status = nextStatus { nextStatus = nil; return status }
        guard values[account] != nil else { return errSecItemNotFound }
        values[account] = secret; return errSecSuccess
    }
    func delete(account: String) -> OSStatus {
        values.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess
    }
}

final class CredentialHelperTests: XCTestCase {
    private let account = "credential:alpha:1"
    private func request(_ operation: String, secret: Data? = nil) throws -> Data {
        var object: [String: Any] = ["version": 1, "operation": operation, "account": account]
        if let secret { object["secret"] = secret.base64EncodedString() }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    func testAddGetAtomicReplaceDeleteAndIdempotentAbsent() throws {
        let backend = FakeCredentialBackend()
        XCTAssertEqual(try CredentialProtocol.handle(request("put", secret: Data("one".utf8)), backend: backend), .init(status: "ok"))
        XCTAssertEqual(try CredentialProtocol.handle(request("get"), backend: backend), .init(status: "ok", secret: Data("one".utf8).base64EncodedString()))
        XCTAssertEqual(try CredentialProtocol.handle(request("replace", secret: Data("two".utf8)), backend: backend), .init(status: "ok"))
        XCTAssertEqual(try CredentialProtocol.handle(request("get"), backend: backend), .init(status: "ok", secret: Data("two".utf8).base64EncodedString()))
        XCTAssertEqual(try CredentialProtocol.handle(request("delete"), backend: backend), .init(status: "ok"))
        XCTAssertEqual(try CredentialProtocol.handle(request("delete"), backend: backend), .init(status: "missing"))
        XCTAssertEqual(try CredentialProtocol.handle(request("get"), backend: backend), .init(status: "missing"))
    }

    func testDuplicateAndFailedReplacePreserveOldCredential() throws {
        let backend = FakeCredentialBackend(); backend.values[account] = Data("old".utf8)
        XCTAssertEqual(try CredentialProtocol.handle(request("put", secret: Data("new".utf8)), backend: backend), .init(status: "duplicate"))
        backend.nextStatus = errSecInteractionNotAllowed
        XCTAssertEqual(try CredentialProtocol.handle(request("replace", secret: Data("new".utf8)), backend: backend), .init(status: "unavailable"))
        XCTAssertEqual(backend.values[account], Data("old".utf8))
    }

    func testRejectsMalformedExtraOversizedAndNoncanonicalRequests() throws {
        let backend = FakeCredentialBackend()
        for object: [String: Any] in [
            ["version": 2, "operation": "get", "account": account],
            ["version": 1, "operation": "get", "account": account, "extra": true],
            ["version": 1, "operation": "get", "account": "../secret"],
            ["version": 1, "operation": "put", "account": account, "secret": Data(repeating: 1, count: maximumCredentialBytes + 1).base64EncodedString()],
        ] { XCTAssertThrowsError(try CredentialProtocol.handle(JSONSerialization.data(withJSONObject: object), backend: backend)) }
        XCTAssertThrowsError(try CredentialProtocol.handle(Data(#"{"version":2,"\u0076ersion":1,"operation":"get","account":"credential:alpha:1"}"#.utf8), backend: backend))
    }

    func testResponseFramesNeverEscapeBase64Slashes() throws {
        let frame = try CredentialProtocol.frame(.init(status: "ok", secret: "/w=="))
        XCTAssertFalse(String(decoding: frame.dropFirst(4), as: UTF8.self).contains("\\"))
    }

    func testSecurityQueryContractIsFixedInSource() throws {
        let source = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/GreenRoomLauncherTests/CredentialHelperTests.swift", with: "Sources/GreenRoomCredentialHelper/main.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("net.greenroomai.GreenRoom.provider-key"))
        XCTAssertTrue(source.contains("kSecAttrSynchronizable: kCFBooleanFalse"))
        XCTAssertTrue(source.contains("kSecAttrAccessibleWhenUnlockedThisDeviceOnly"))
        XCTAssertTrue(source.contains("SecItemAdd")); XCTAssertTrue(source.contains("SecItemCopyMatching"))
        XCTAssertTrue(source.contains("SecItemUpdate")); XCTAssertTrue(source.contains("SecItemDelete"))
    }
}
