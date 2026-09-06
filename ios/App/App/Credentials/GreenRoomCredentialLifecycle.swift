import Foundation

let credentialEnvelopeVersion = 1
let credentialMaximumEnvelopeBytes = 256 * 1024
let credentialMaximumSecretBytes = 8 * 1024

struct CredentialMutationRequest: Equatable, Sendable {
    let profileId: String
    let profileRevision: Int
    let providerId: String
    let credentialRef: String
    let mutationId: String

    var baseIdentityParameters: [Any] {
        [profileId, profileRevision, providerId, credentialRef]
    }

    var identityParameters: [Any] { baseIdentityParameters + [mutationId] }
}

struct CredentialReservation: Equatable, Sendable {
    let profileId: String
    let profileRevision: Int
    let providerId: String
    let credentialRef: String
    let mutationId: String
    let lifecycleState: String
    let tombstoned: Bool

    var identityParameters: [Any] {
        [profileId, profileRevision, providerId, credentialRef, mutationId]
    }

    var mutationRequest: CredentialMutationRequest {
        CredentialMutationRequest(
            profileId: profileId,
            profileRevision: profileRevision,
            providerId: providerId,
            credentialRef: credentialRef,
            mutationId: mutationId
        )
    }
}

struct CredentialMetadata: Codable, Equatable, Sendable {
    let version: Int
    let profileId: String
    let profileRevision: Int
    let providerId: String
    let credentialRef: String
    let mutationId: String

    init(reservation: CredentialReservation) {
        version = credentialEnvelopeVersion
        profileId = reservation.profileId
        profileRevision = reservation.profileRevision
        providerId = reservation.providerId
        credentialRef = reservation.credentialRef
        mutationId = reservation.mutationId
    }

    var mutationRequest: CredentialMutationRequest {
        CredentialMutationRequest(
            profileId: profileId,
            profileRevision: profileRevision,
            providerId: providerId,
            credentialRef: credentialRef,
            mutationId: mutationId
        )
    }

    func encoded() throws -> Data {
        let data = try JSONEncoder.sorted.encode(self)
        guard data.count <= credentialMaximumEnvelopeBytes else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: false)
        }
        return data
    }

    static func decodeClosed(_ data: Data) throws -> CredentialMetadata {
        guard data.count <= credentialMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["version", "profileId", "profileRevision", "providerId", "credentialRef", "mutationId"]),
              let value = try? JSONDecoder().decode(CredentialMetadata.self, from: data),
              value.version == credentialEnvelopeVersion,
              (try? validateCredentialIdentity(value.mutationRequest)) != nil else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: false)
        }
        return value
    }
}

private extension JSONEncoder {
    static var sorted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

struct CredentialStoredItem: Sendable {
    let credentialRef: String
    let inspection: CredentialMetadataInspection
}

enum CredentialMetadataInspection: Equatable, Sendable {
    case missing
    case valid(CredentialMetadata)
    case invalid
}

protocol CredentialSecureStore: Sendable {
    func inspectMetadata(credentialRef: String) throws -> CredentialMetadataInspection
    func write(credentialRef: String, secret: inout Data, metadata: CredentialMetadata) throws
    func delete(credentialRef: String) throws
    func inventory() throws -> [CredentialStoredItem]
    func performWithCredential(
        credentialRef: String,
        expectedMetadata: CredentialMetadata,
        operation: (inout Data) throws -> Void
    ) throws
}

@MainActor
protocol NativeCredentialSecretSource: AnyObject {
    func requestSecret(
        for request: CredentialMutationRequest,
        completion: @escaping (Result<Data, DatabaseFailure>) -> Void
    )
}

final class CredentialInFlightCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var callIds = Set<String>()

    func begin(_ callId: String) -> Bool {
        lock.withLock { callIds.insert(callId).inserted }
    }

    func finish(_ callId: String) {
        _ = lock.withLock { callIds.remove(callId) }
    }
}

struct CredentialStatusRequest: Codable, Equatable, Sendable {
    let profileId: String
    let profileRevision: Int
    let providerId: String
    let credentialRef: String
}

private struct CredentialSavePayload: Codable {
    let profileId: String
    let profileRevision: Int
    let providerId: String
    let mutationId: String
}

private struct CredentialDeletePayload: Codable {
    let profileId: String
    let profileRevision: Int
    let providerId: String
    let credentialRef: String
    let mutationId: String
}

private struct CredentialWireEnvelope<Payload: Codable>: Codable {
    let contractVersion: String
    let callId: String
    let method: String
    let payload: Payload
}

enum CredentialBridgeCodec {
    static func decodeSave(_ data: Data) throws -> CredentialMutationRequest {
        let envelope: CredentialWireEnvelope<CredentialSavePayload> = try decodeClosed(
            data, method: "credential.presentSaveSheet",
            payloadKeys: ["profileId", "profileRevision", "providerId", "mutationId"]
        )
        return try validateCredentialIdentity(CredentialMutationRequest(
            profileId: envelope.payload.profileId,
            profileRevision: envelope.payload.profileRevision,
            providerId: envelope.payload.providerId,
            credentialRef: canonicalCredentialReference(
                profileId: envelope.payload.profileId, revision: envelope.payload.profileRevision
            ),
            mutationId: envelope.payload.mutationId
        ))
    }

    static func decodeStatus(_ data: Data) throws -> CredentialStatusRequest {
        let envelope: CredentialWireEnvelope<CredentialStatusRequest> = try decodeClosed(
            data, method: "credential.status",
            payloadKeys: ["profileId", "profileRevision", "providerId", "credentialRef"]
        )
        let syntheticMutation = "00000000-0000-4000-8000-000000000000"
        _ = try validateCredentialIdentity(CredentialMutationRequest(
            profileId: envelope.payload.profileId,
            profileRevision: envelope.payload.profileRevision,
            providerId: envelope.payload.providerId,
            credentialRef: envelope.payload.credentialRef,
            mutationId: syntheticMutation
        ))
        return envelope.payload
    }

    static func decodeDelete(_ data: Data) throws -> CredentialMutationRequest {
        let envelope: CredentialWireEnvelope<CredentialDeletePayload> = try decodeClosed(
            data, method: "credential.delete",
            payloadKeys: ["profileId", "profileRevision", "providerId", "credentialRef", "mutationId"]
        )
        return try validateCredentialIdentity(CredentialMutationRequest(
            profileId: envelope.payload.profileId,
            profileRevision: envelope.payload.profileRevision,
            providerId: envelope.payload.providerId,
            credentialRef: envelope.payload.credentialRef,
            mutationId: envelope.payload.mutationId
        ))
    }

    private static func decodeClosed<Payload: Codable>(
        _ data: Data,
        method: String,
        payloadKeys: Set<String>
    ) throws -> CredentialWireEnvelope<Payload> {
        guard data.count <= credentialMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["contractVersion", "callId", "method", "payload"]),
              object["method"] as? String == method,
              canonicalBridgeCallId(object["callId"]) != "invalid",
              let payload = object["payload"] as? [String: Any],
              Set(payload.keys) == payloadKeys else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        guard object["contractVersion"] as? String == bridgeContractVersion else {
            throw DatabaseFailure(code: "incompatible_contract", retryable: false)
        }
        guard let decoded = try? JSONDecoder().decode(CredentialWireEnvelope<Payload>.self, from: data) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        return decoded
    }
}

func canonicalCredentialReference(profileId: String, revision: Int) -> String {
    "credential:\(profileId):\(revision)"
}

@discardableResult
func validateCredentialIdentity(_ request: CredentialMutationRequest) throws -> CredentialMutationRequest {
    let identifier = try NSRegularExpression(pattern: "^[a-z][a-z0-9._-]{0,127}$")
    func matches(_ value: String) -> Bool {
        identifier.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
    guard matches(request.profileId), matches(request.providerId),
          (1...2_147_483_647).contains(request.profileRevision),
          request.credentialRef == canonicalCredentialReference(profileId: request.profileId, revision: request.profileRevision),
          request.mutationId.count == 36,
          request.mutationId == request.mutationId.lowercased(),
          UUID(uuidString: request.mutationId)?.uuidString.lowercased() == request.mutationId,
          request.mutationId[request.mutationId.index(request.mutationId.startIndex, offsetBy: 14)] == "4" else {
        throw DatabaseFailure(code: "invalid_call", retryable: false)
    }
    return request
}

final class GreenRoomCredentialLifecycle: @unchecked Sendable {
    private let database: GreenRoomDatabaseStore
    private let secureStore: any CredentialSecureStore
    private let operationLock: NSRecursiveLock
    private let afterKeychainWrite: @Sendable () throws -> Void

    init(
        database: GreenRoomDatabaseStore,
        secureStore: any CredentialSecureStore,
        afterKeychainWrite: @escaping @Sendable () throws -> Void = {}
    ) {
        self.database = database
        self.secureStore = secureStore
        operationLock = database.serializationLock
        self.afterKeychainWrite = afterKeychainWrite
    }

    // Called before native UI is presented. It never accepts secret material.
    func prepareSave(_ supplied: CredentialMutationRequest) throws -> Bool {
        try operationLock.withLock {
            let request = try validateCredentialIdentity(supplied)
            let reservation = try exactReservation(request)
            guard !reservation.tombstoned,
                  reservation.lifecycleState == "credential_pending" else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: false)
            }
            for supersededReference in try database.supersededCredentialReferences(
                profileId: request.profileId, before: request.profileRevision
            ) {
                try secureStore.delete(credentialRef: supersededReference)
            }
            let inspection = try secureStore.inspectMetadata(credentialRef: request.credentialRef)
            if inspection == .invalid {
                try secureStore.delete(credentialRef: request.credentialRef)
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
            let metadata: CredentialMetadata? = if case .valid(let value) = inspection { value } else { nil }
            if let metadata {
                if metadata == CredentialMetadata(reservation: reservation) {
                    try database.markCredentialReady(reservation)
                    return false
                }
                try secureStore.delete(credentialRef: request.credentialRef)
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
            return true
        }
    }

    func completeSave(_ supplied: CredentialMutationRequest, secret: inout Data) throws -> [String: Any] {
        defer { secret.resetBytes(in: 0..<secret.count) }
        return try operationLock.withLock {
            let request = try validateCredentialIdentity(supplied)
            guard !secret.isEmpty, secret.count <= credentialMaximumSecretBytes else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            let reservation = try exactReservation(request)
            guard reservation.lifecycleState == "credential_pending", !reservation.tombstoned else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: false)
            }
            let inspection = try secureStore.inspectMetadata(credentialRef: request.credentialRef)
            if inspection == .invalid {
                try secureStore.delete(credentialRef: request.credentialRef)
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
            if case .valid(let metadata) = inspection {
                if metadata == CredentialMetadata(reservation: reservation) {
                    try database.markCredentialReady(reservation)
                    return ["credentialRef": request.credentialRef, "state": "ready"]
                }
                try secureStore.delete(credentialRef: request.credentialRef)
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
            try secureStore.write(
                credentialRef: request.credentialRef,
                secret: &secret,
                metadata: CredentialMetadata(reservation: reservation)
            )
            try afterKeychainWrite()
            try database.markCredentialReady(reservation)
            return ["credentialRef": request.credentialRef, "state": "ready"]
        }
    }

    func readyResult(_ request: CredentialMutationRequest) -> [String: Any] {
        ["credentialRef": request.credentialRef, "state": "ready"]
    }

    func status(_ supplied: CredentialMutationRequest) throws -> [String: Any] {
        try operationLock.withLock {
            let request = try validateCredentialIdentity(supplied)
            guard let reservation = try database.credentialReservation(
                profileId: request.profileId,
                profileRevision: request.profileRevision,
                providerId: request.providerId,
                credentialRef: request.credentialRef
            ) else { return ["state": "missing"] }
            guard reservation.mutationId == request.mutationId else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: false)
            }
            let present = try secureStore.inspectMetadata(credentialRef: request.credentialRef) == .valid(CredentialMetadata(reservation: reservation))
            if reservation.tombstoned || reservation.lifecycleState == "delete_pending" {
                return ["state": present ? "delete_pending" : "missing"]
            }
            if reservation.lifecycleState == "ready" {
                return ["state": present ? "ready" : "missing"]
            }
            if reservation.lifecycleState == "missing" {
                return ["state": "missing"]
            }
            return ["state": "pending"]
        }
    }

    func delete(_ supplied: CredentialMutationRequest) throws -> [String: Any] {
        try operationLock.withLock {
            let request = try validateCredentialIdentity(supplied)
            let reservation: CredentialReservation
            do {
                reservation = try database.beginCredentialDelete(request)
            } catch let failure as DatabaseFailure where failure.code == "credential_missing" {
                return ["state": "missing"]
            }
            do {
                try secureStore.delete(credentialRef: request.credentialRef)
            } catch {
                throw DatabaseFailure(code: "credential_write_failed", retryable: true)
            }
            try database.markCredentialMissing(reservation)
            return ["state": "missing"]
        }
    }

    // The provider boundary supplies this closure after its request-plan checks.
    // Credential bytes never become a bridge result or a stored provider value.
    func performWithReadyCredential(
        _ supplied: CredentialMutationRequest,
        operation: (inout Data) throws -> Void
    ) throws {
        try operationLock.withLock {
            let request = try validateCredentialIdentity(supplied)
            let reservation = try exactReservation(request)
            guard reservation.lifecycleState == "ready", !reservation.tombstoned else {
                throw DatabaseFailure(code: "credential_missing", retryable: true)
            }
            try secureStore.performWithCredential(
                credentialRef: request.credentialRef,
                expectedMetadata: CredentialMetadata(reservation: reservation),
                operation: operation
            )
        }
    }

    // database.open invokes this before reporting open success.
    func reconcileAtDatabaseOpen() throws {
        try operationLock.withLock {
            let reservations = try database.credentialReservationsForReconciliation()
            let byReference = Dictionary(uniqueKeysWithValues: reservations.map { ($0.credentialRef, $0) })
            let items = try secureStore.inventory()
            var groupedItems: [String: [CredentialStoredItem]] = [:]
            for item in items {
                groupedItems[item.credentialRef, default: []].append(item)
            }
            var itemByReference: [String: CredentialStoredItem] = [:]
            for (reference, matchingItems) in groupedItems {
                guard matchingItems.count == 1, let item = matchingItems.first else {
                    try secureStore.delete(credentialRef: reference)
                    continue
                }
                if byReference[reference] == nil {
                    try secureStore.delete(credentialRef: reference)
                } else {
                    itemByReference[reference] = item
                }
            }
            for reservation in reservations {
                let inspection = itemByReference[reservation.credentialRef]?.inspection ?? .missing
                if reservation.tombstoned || reservation.lifecycleState == "delete_pending" {
                    try secureStore.delete(credentialRef: reservation.credentialRef)
                    try database.markCredentialMissing(reservation)
                    continue
                }
                if reservation.lifecycleState == "missing" {
                    try secureStore.delete(credentialRef: reservation.credentialRef)
                    continue
                }
                let expected = CredentialMetadata(reservation: reservation)
                switch (reservation.lifecycleState, inspection) {
                case ("credential_pending", .valid(let metadata)) where metadata == expected:
                    try database.markCredentialReady(reservation)
                case ("credential_pending", .invalid),
                     ("credential_pending", .valid):
                    try secureStore.delete(credentialRef: reservation.credentialRef)
                case ("credential_pending", .missing):
                    break
                case ("ready", .valid(let metadata)) where metadata == expected:
                    break
                case ("ready", .missing):
                    try database.markCredentialUnavailable(reservation)
                case ("ready", .invalid),
                     ("ready", .valid):
                    try secureStore.delete(credentialRef: reservation.credentialRef)
                    try database.markCredentialUnavailable(reservation)
                default:
                    throw DatabaseFailure(code: "credential_unavailable", retryable: false)
                }
            }
        }
    }

    private func exactReservation(_ request: CredentialMutationRequest) throws -> CredentialReservation {
        guard let reservation = try database.credentialReservation(
            profileId: request.profileId,
            profileRevision: request.profileRevision,
            providerId: request.providerId,
            credentialRef: request.credentialRef
        ), reservation.mutationId == request.mutationId else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: false)
        }
        return reservation
    }
}
