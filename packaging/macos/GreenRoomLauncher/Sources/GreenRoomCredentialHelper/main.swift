import Foundation
import Security

let credentialService = "net.greenroomai.GreenRoom.provider-key"
let maximumCredentialFrameBytes = 1_048_576
let maximumCredentialBytes = 65_536

struct CredentialRequest: Decodable {
    let version: Int
    let operation: String
    let account: String
    let secret: String?
}

struct CredentialResponse: Encodable, Equatable {
    let version: Int
    let status: String
    let secret: String?

    init(status: String, secret: String? = nil) {
        self.version = 1; self.status = status; self.secret = secret
    }
}

protocol CredentialBackend {
    func add(account: String, secret: Data) -> OSStatus
    func get(account: String) -> (OSStatus, Data?)
    func replace(account: String, secret: Data) -> OSStatus
    func delete(account: String) -> OSStatus
}

struct SecurityCredentialBackend: CredentialBackend {
    private func base(_ account: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: credentialService,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
    }

    func add(account: String, secret: Data) -> OSStatus {
        var query = base(account)
        query[kSecValueData] = secret
        query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil)
    }

    func get(account: String) -> (OSStatus, Data?) {
        var query = base(account)
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }

    func replace(account: String, secret: Data) -> OSStatus {
        SecItemUpdate(base(account) as CFDictionary, [kSecValueData: secret] as CFDictionary)
    }

    func delete(account: String) -> OSStatus { SecItemDelete(base(account) as CFDictionary) }
}

enum CredentialProtocolError: Error { case invalid }

enum CredentialProtocol {
    static func canonicalAccount(_ account: String) -> Bool {
        guard account.utf8.count <= 256 else { return false }
        return account.range(of: #"^credential:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[1-9][0-9]{0,9}$"#, options: .regularExpression) != nil
    }

    static func handle(_ data: Data, backend: CredentialBackend) throws -> CredentialResponse {
        guard let text = String(data: data, encoding: .utf8),
              !text.contains("\\"),
              !["version", "operation", "account", "secret", "status"].contains(where: {
                  text.components(separatedBy: "\"\($0)\"").count > 2
              })
        else { throw CredentialProtocolError.invalid }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["version"] as? Int == 1,
              let operation = object["operation"] as? String,
              let account = object["account"] as? String,
              canonicalAccount(account)
        else { throw CredentialProtocolError.invalid }
        let needsSecret = operation == "put" || operation == "replace"
        let expected = Set(needsSecret ? ["version", "operation", "account", "secret"] : ["version", "operation", "account"])
        guard Set(object.keys) == expected else { throw CredentialProtocolError.invalid }
        var secret = Data()
        if needsSecret {
            guard let encoded = object["secret"] as? String,
                  let decoded = Data(base64Encoded: encoded), !decoded.isEmpty,
                  decoded.count <= maximumCredentialBytes,
                  decoded.base64EncodedString() == encoded
            else { throw CredentialProtocolError.invalid }
            secret = decoded
        }
        defer { secret.resetBytes(in: 0..<secret.count) }
        switch operation {
        case "put": return status(backend.add(account: account, secret: secret), duplicate: true)
        case "get":
            let (code, found) = backend.get(account: account)
            if code == errSecItemNotFound { return .init(status: "missing") }
            guard code == errSecSuccess, var bytes = found, !bytes.isEmpty, bytes.count <= maximumCredentialBytes else { return .init(status: "unavailable") }
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            return .init(status: "ok", secret: bytes.base64EncodedString())
        case "replace": return status(backend.replace(account: account, secret: secret))
        case "delete": return status(backend.delete(account: account), missingIsOkay: true)
        default: throw CredentialProtocolError.invalid
        }
    }

    private static func status(_ code: OSStatus, duplicate: Bool = false, missingIsOkay: Bool = false) -> CredentialResponse {
        if code == errSecSuccess { return .init(status: "ok") }
        if code == errSecItemNotFound { return .init(status: "missing") }
        if duplicate && code == errSecDuplicateItem { return .init(status: "duplicate") }
        return .init(status: "unavailable")
    }

    private static func readExactly(_ count: Int, from input: FileHandle) throws -> Data {
        var result = Data(); result.reserveCapacity(count)
        while result.count < count {
            guard let chunk = try input.read(upToCount: count - result.count), !chunk.isEmpty else {
                throw CredentialProtocolError.invalid
            }
            result.append(chunk)
        }
        return result
    }

    static func readFrame(_ input: FileHandle) throws -> Data {
        let header = try readExactly(4, from: input)
        let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length > 0, length <= maximumCredentialFrameBytes else { throw CredentialProtocolError.invalid }
        let body = try readExactly(Int(length), from: input)
        guard (try input.read(upToCount: 1) ?? Data()).isEmpty else { throw CredentialProtocolError.invalid }
        return body
    }

    static func frame(_ response: CredentialResponse) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let body = try encoder.encode(response)
        guard body.count <= maximumCredentialFrameBytes else { throw CredentialProtocolError.invalid }
        var length = UInt32(body.count).bigEndian
        var output = Data(bytes: &length, count: 4); output.append(body); return output
    }
}

@main
struct GreenRoomCredentialHelperMain {
    static func main() {
        do {
            var request = try CredentialProtocol.readFrame(.standardInput)
            defer { request.resetBytes(in: 0..<request.count) }
            let response = try CredentialProtocol.handle(request, backend: SecurityCredentialBackend())
            try FileHandle.standardOutput.write(contentsOf: CredentialProtocol.frame(response))
        } catch {
            // Protocol and Security failures are intentionally not printed.
            exit(20)
        }
    }
}
