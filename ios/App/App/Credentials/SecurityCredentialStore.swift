import Foundation
import Security

final class SecurityCredentialStore: CredentialSecureStore, @unchecked Sendable {
    private let service: String
    private let credentialUseLock = NSLock()
    private let copyMatching: ([CFString: Any]) -> (OSStatus, Any?)

    init(service: String = "net.greenroomai.GreenRoom") {
        self.service = service
        copyMatching = { query in
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return (status, result)
        }
    }

    init(service: String, copyMatching: @escaping ([CFString: Any]) -> (OSStatus, Any?)) {
        self.service = service
        self.copyMatching = copyMatching
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
              attributes[kSecAttrAccount] as? String == credentialRef else {
            return .invalid
        }
        return inspectScopedAttributes(attributes, credentialRef: credentialRef)
    }

    static func inspectScopedAttributes(
        _ attributes: [CFString: Any],
        credentialRef: String
    ) -> CredentialMetadataInspection {
        guard attributes[kSecAttrAccessible] as? String == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
              (attributes[kSecAttrSynchronizable] == nil || attributes[kSecAttrSynchronizable] as? Bool == false),
              let bytes = attributes[kSecAttrGeneric] as? Data,
              let metadata = try? CredentialMetadata.decodeClosed(bytes),
              metadata.credentialRef == credentialRef else {
            return .invalid
        }
        return .valid(metadata)
    }

    func inspectMetadata(credentialRef: String) throws -> CredentialMetadataInspection {
        var query = Self.deletionQuery(service: service, credentialRef: credentialRef)
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitAll
        let (status, result) = copyMatching(query)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let rows = result as? [[CFString: Any]] else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: true)
        }
        guard rows.count == 1, let attributes = rows.first,
              try !hasSynchronizingItem(credentialRef: credentialRef) else { return .invalid }
        return Self.inspectScopedAttributes(attributes, credentialRef: credentialRef)
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
        var query = Self.scopedQuery(service: service)
        query[kSecAttrSynchronizable] = kSecAttrSynchronizableAny
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitAll
        let (status, result) = copyMatching(query)
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
                inspection: try hasSynchronizingItem(credentialRef: reference)
                    ? .invalid
                    : Self.inspectScopedAttributes(row, credentialRef: reference)
            ))
        }
        return items
    }

    func performWithCredential(
        credentialRef: String,
        expectedMetadata: CredentialMetadata,
        operation: (inout Data) throws -> Void
    ) throws {
        try credentialUseLock.withLock {
            var query = Self.deletionQuery(service: service, credentialRef: credentialRef)
            query[kSecReturnAttributes] = kCFBooleanTrue
            query[kSecReturnData] = kCFBooleanTrue
            query[kSecMatchLimit] = kSecMatchLimitAll
            let (status, result) = copyMatching(query)
            guard status == errSecSuccess,
                  let rows = result as? [[CFString: Any]],
                  rows.count == 1,
                  let attributes = rows.first,
                  attributes[kSecAttrSynchronizable] as? Bool == false,
                  Self.inspectScopedAttributes(attributes, credentialRef: credentialRef) == .valid(expectedMetadata),
                  var bytes = attributes[kSecValueData] as? Data,
                  !bytes.isEmpty,
                  bytes.count <= credentialMaximumSecretBytes else {
                throw DatabaseFailure(code: "credential_missing", retryable: status != errSecParam)
            }
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            try operation(&bytes)
        }
    }

    private func hasSynchronizingItem(credentialRef: String) throws -> Bool {
        var query = Self.scopedQuery(service: service, credentialRef: credentialRef)
        query[kSecAttrSynchronizable] = kCFBooleanTrue
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        let (status, _) = copyMatching(query)
        if status == errSecSuccess { return true }
        if status == errSecItemNotFound { return false }
        throw DatabaseFailure(code: "credential_unavailable", retryable: true)
    }
}

#if DEBUG
struct CredentialAttributeEvidence {
    let exactAccessibility: Bool
    let nonSynchronizing: Bool
    let itemCount: Int
}

extension SecurityCredentialStore {
    func acceptanceAttributeEvidence(credentialRef: String) throws -> CredentialAttributeEvidence {
        var query = Self.deletionQuery(service: service, credentialRef: credentialRef)
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitAll
        let (status, result) = copyMatching(query)
        if status == errSecItemNotFound {
            return CredentialAttributeEvidence(exactAccessibility: false, nonSynchronizing: false, itemCount: 0)
        }
        guard status == errSecSuccess, let rows = result as? [[CFString: Any]] else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: true)
        }
        let exactAccessibility = rows.allSatisfy {
            $0[kSecAttrAccessible] as? String == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        }
        let nonSynchronizing = try !hasSynchronizingItem(credentialRef: credentialRef)
        return CredentialAttributeEvidence(
            exactAccessibility: exactAccessibility,
            nonSynchronizing: nonSynchronizing,
            itemCount: rows.count
        )
    }

    func acceptanceLockedReadDenied(credentialRef: String) throws -> Bool {
        var query = Self.scopedQuery(service: service, credentialRef: credentialRef)
        query[kSecReturnAttributes] = kCFBooleanTrue
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        let (status, result) = copyMatching(query)
        if status == errSecInteractionNotAllowed || status == errSecNotAvailable {
            return true
        }
        if status == errSecSuccess, let attributes = result as? [CFString: Any],
           var bytes = attributes[kSecValueData] as? Data {
            bytes.resetBytes(in: 0..<bytes.count)
            return false
        }
        throw DatabaseFailure(code: "credential_unavailable", retryable: true)
    }
}
#endif
