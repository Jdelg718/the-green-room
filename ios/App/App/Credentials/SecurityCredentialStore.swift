import Foundation
import Security

final class SecurityCredentialStore: CredentialSecureStore, @unchecked Sendable {
    private let service: String

    init(service: String = "net.greenroomai.GreenRoom") {
        self.service = service
    }

    static func scopedQuery(service: String, credentialRef: String? = nil) -> [CFString: Any] {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
        if let credentialRef { query[kSecAttrAccount] = credentialRef }
        return query
    }

    static func addQuery(
        service: String,
        credentialRef: String,
        secret: Data,
        metadata: Data
    ) -> [CFString: Any] {
        var query = scopedQuery(service: service, credentialRef: credentialRef)
        query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        query[kSecAttrGeneric] = metadata
        query[kSecValueData] = secret
        return query
    }

    static func deletionQuery(service: String, credentialRef: String) -> [CFString: Any] {
        var query = scopedQuery(service: service, credentialRef: credentialRef)
        query[kSecAttrSynchronizable] = kSecAttrSynchronizableAny
        return query
    }

    static func inspectAttributes(
        _ attributes: [CFString: Any],
        service: String,
        credentialRef: String
    ) -> CredentialMetadataInspection {
        guard attributes[kSecClass] as? String == (kSecClassGenericPassword as String),
              attributes[kSecAttrService] as? String == service,
              attributes[kSecAttrAccount] as? String == credentialRef,
              attributes[kSecAttrAccessible] as? String == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
              attributes[kSecAttrSynchronizable] as? Bool == false,
              let bytes = attributes[kSecAttrGeneric] as? Data,
              let metadata = try? CredentialMetadata.decodeClosed(bytes),
              metadata.credentialRef == credentialRef else {
            return .invalid
        }
        return .valid(metadata)
    }

    func inspectMetadata(credentialRef: String) throws -> CredentialMetadataInspection {
        var result: CFTypeRef?
        var query = Self.deletionQuery(service: service, credentialRef: credentialRef)
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitAll
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let rows = result as? [[CFString: Any]] else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: true)
        }
        guard rows.count == 1, let attributes = rows.first else { return .invalid }
        return Self.inspectAttributes(attributes, service: service, credentialRef: credentialRef)
    }

    func write(credentialRef: String, secret: inout Data, metadata: CredentialMetadata) throws {
        let status = SecItemAdd(Self.addQuery(
            service: service, credentialRef: credentialRef, secret: secret,
            metadata: try metadata.encoded()
        ) as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw DatabaseFailure(code: "credential_write_failed", retryable: status != errSecParam)
        }
    }

    func delete(credentialRef: String) throws {
        let status = SecItemDelete(Self.deletionQuery(service: service, credentialRef: credentialRef) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw DatabaseFailure(code: "credential_write_failed", retryable: true)
        }
    }

    func inventory() throws -> [CredentialStoredItem] {
        var result: CFTypeRef?
        var query = Self.scopedQuery(service: service)
        query[kSecAttrSynchronizable] = kSecAttrSynchronizableAny
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitAll
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let rows = result as? [[CFString: Any]] else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: true)
        }
        var items: [CredentialStoredItem] = []
        for row in rows {
            guard let reference = row[kSecAttrAccount] as? String else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
            items.append(CredentialStoredItem(
                credentialRef: reference,
                inspection: Self.inspectAttributes(row, service: service, credentialRef: reference)
            ))
        }
        return items
    }

    func performWithCredential(
        credentialRef: String,
        expectedMetadata: CredentialMetadata,
        operation: (inout Data) throws -> Void
    ) throws {
        var result: CFTypeRef?
        var query = Self.scopedQuery(service: service, credentialRef: credentialRef)
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let attributes = result as? [CFString: Any],
              Self.inspectAttributes(attributes, service: service, credentialRef: credentialRef) == .valid(expectedMetadata),
              var bytes = attributes[kSecValueData] as? Data,
              !bytes.isEmpty,
              bytes.count <= credentialMaximumSecretBytes else {
            throw DatabaseFailure(code: "credential_missing", retryable: status != errSecParam)
        }
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        try operation(&bytes)
    }
}
