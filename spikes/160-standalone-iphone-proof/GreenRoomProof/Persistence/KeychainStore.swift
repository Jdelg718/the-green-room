import Foundation
import Security

struct KeychainStore: Sendable {
    enum StoreError: Error, Equatable {
        case unexpectedStatus(OSStatus)
        case invalidData
    }

    let service: String

    init(service: String = "net.greenroomai.spike.iphoneproof160.synthetic") {
        self.service = service
    }

    private func baseQuery(account: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kCFBooleanFalse as Any
        ]
    }

    func set(_ value: String, account: String) throws {
        try delete(account: account, allowMissing: true)
        var query = baseQuery(account: account)
        query[kSecValueData] = Data(value.utf8)
        query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoreError.unexpectedStatus(status) }
    }

    func get(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw StoreError.unexpectedStatus(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw StoreError.invalidData
        }
        return value
    }

    func delete(account: String) throws {
        try delete(account: account, allowMissing: false)
    }

    private func delete(account: String, allowMissing: Bool) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        if status == errSecSuccess || (allowMissing && status == errSecItemNotFound) { return }
        guard status != errSecItemNotFound else { return }
        throw StoreError.unexpectedStatus(status)
    }

    func runSyntheticSentinelCheck() throws -> Bool {
        let account = "proof-sentinel"
        let sentinel = "GREENROOM-SYNTHETIC-KEYCHAIN-SENTINEL-160"
        try set(sentinel, account: account)
        let matches: Bool
        do {
            matches = try get(account: account) == sentinel
        } catch {
            let readError = error
            try delete(account: account)
            throw readError
        }
        try delete(account: account)
        return matches
    }
}
