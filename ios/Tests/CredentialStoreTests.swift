import Foundation
import Security
import SQLite3

private final class FakeCredentialSecureStore: CredentialSecureStore, @unchecked Sendable {
    struct Value { var secret: Data; var metadata: CredentialMetadata? }
    var values: [String: Value] = [:]
    var metadataReads = 0
    var writes = 0
    var deletes = 0
    var uses = 0
    var failDelete = false
    var failInventory = false
    var inventoryOverride: [CredentialStoredItem]?
    var metadataInspectionOverride: [String: CredentialMetadataInspection] = [:]

    func inspectMetadata(credentialRef: String) throws -> CredentialMetadataInspection {
        metadataReads += 1
        if let override = metadataInspectionOverride[credentialRef] { return override }
        guard let value = values[credentialRef] else { return .missing }
        guard let metadata = value.metadata else { return .invalid }
        return .valid(metadata)
    }

    func write(credentialRef: String, secret: inout Data, metadata: CredentialMetadata) throws {
        writes += 1
        guard values[credentialRef] == nil else {
            throw DatabaseFailure(code: "credential_write_failed", retryable: true)
        }
        values[credentialRef] = Value(secret: secret, metadata: metadata)
    }

    func delete(credentialRef: String) throws {
        deletes += 1
        if failDelete { throw DatabaseFailure(code: "credential_write_failed", retryable: true) }
        values.removeValue(forKey: credentialRef)
    }

    func inventory() throws -> [CredentialStoredItem] {
        if failInventory { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
        if let inventoryOverride { return inventoryOverride }
        return values.map {
            CredentialStoredItem(
                credentialRef: $0.key,
                inspection: $0.value.metadata.map(CredentialMetadataInspection.valid) ?? .invalid
            )
        }
    }

    func performWithCredential(
        credentialRef: String,
        expectedMetadata: CredentialMetadata,
        operation: (inout Data) throws -> Void
    ) throws {
        guard let value = values[credentialRef], value.metadata == expectedMetadata,
              !value.secret.isEmpty, value.secret.count <= credentialMaximumSecretBytes else {
            throw DatabaseFailure(code: "credential_missing", retryable: true)
        }
        uses += 1
        var bytes = value.secret
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        try operation(&bytes)
    }
}

private func credentialRequire(_ condition: Bool, _ message: String) {
    if !condition { fatalError(message) }
}

private func credentialFailure(_ code: String, _ operation: () throws -> Void) {
    do {
        try operation()
        fatalError("expected \(code)")
    } catch let failure as DatabaseFailure {
        credentialRequire(failure.code == code, "expected \(code), got \(failure.code)")
    } catch {
        fatalError("unexpected credential error: \(error)")
    }
}

private func reserve(
    _ store: GreenRoomDatabaseStore,
    _ request: CredentialMutationRequest,
    expectedPrior: Any = NSNull(),
    transaction: String
) throws {
    _ = try store.executeBatch(transactionId: transaction, statements: [
        [
            "sqlId": "create_connection_profile_revision",
            "parameters": [request.profileId, request.profileRevision, request.providerId, expectedPrior],
        ],
        [
            "sqlId": "reserve_credential",
            "parameters": request.baseIdentityParameters + [expectedPrior, request.mutationId],
        ],
    ])
}

func runCredentialStoreTests() throws {
    credentialRequire(credentialMaximumSecretBytes == 8 * 1024, "native secret bound is not exactly 8 KiB")
    var syntheticSteps: [Int32] = [SQLITE_ROW, SQLITE_IOERR]
    var syntheticRows = 0
    credentialFailure("credential_unavailable") {
        try consumeSQLiteRows(
            step: { syntheticSteps.removeFirst() },
            onRow: { syntheticRows += 1 },
            failureCode: "credential_unavailable"
        )
    }
    credentialRequire(syntheticRows == 1, "SQLite reconciliation swallowed a non-DONE terminal status")

    let failedOpenRoot = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-failed-reconcile-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: failedOpenRoot) }
    try FileManager.default.createDirectory(at: failedOpenRoot, withIntermediateDirectories: true)
    let failedOpenMigrations = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("ios/App/App/Resources/Migrations")
    let failedOpenDatabase = GreenRoomDatabaseStore(directory: failedOpenRoot, migrationsDirectory: failedOpenMigrations, fileProtector: { _ in })
    let failingInventory = FakeCredentialSecureStore()
    failingInventory.failInventory = true
    let failedOpenAuthority = GreenRoomNativeAuthority(database: failedOpenDatabase, secureStore: failingInventory)
    credentialFailure("credential_unavailable") { _ = try failedOpenAuthority.openDatabase(expectedSchema: 5) }
    credentialFailure("invalid_call") { _ = try failedOpenDatabase.query(sqlId: "current_room", parameters: []) }

    let inFlight = CredentialInFlightCalls()
    let duplicateCallId = "90000000-0000-4000-8000-000000000009"
    credentialRequire(inFlight.begin(duplicateCallId), "first call ID was rejected")
    credentialRequire(!inFlight.begin(duplicateCallId), "duplicate in-flight call ID was accepted")
    inFlight.finish(duplicateCallId)
    credentialRequire(inFlight.begin(duplicateCallId), "finished call ID could not be reused")
    inFlight.finish(duplicateCallId)

    let productionReference = "credential:openrouter.primary:1"
    let scopedQuery = SecurityCredentialStore.scopedQuery(
        service: "net.greenroomai.GreenRoom", credentialRef: productionReference
    )
    credentialRequire(scopedQuery[kSecClass] as! CFString == kSecClassGenericPassword, "Keychain class is not generic password")
    credentialRequire(scopedQuery[kSecAttrService] as? String == "net.greenroomai.GreenRoom", "Keychain service is not exact")
    credentialRequire(scopedQuery[kSecAttrAccount] as? String == productionReference, "Keychain account/reference is not canonical")
    credentialRequire(scopedQuery[kSecAttrSynchronizable] as? Bool == false, "Keychain query is synchronizing")
    let addQuery = SecurityCredentialStore.addQuery(
        service: "net.greenroomai.GreenRoom", credentialRef: productionReference,
        secret: Data("synthetic".utf8), metadata: Data("metadata".utf8)
    )
    credentialRequire(addQuery[kSecAttrAccessible] as! CFString == kSecAttrAccessibleWhenUnlockedThisDeviceOnly, "Keychain accessibility is not ThisDeviceOnly when unlocked")
    let deletionQuery = SecurityCredentialStore.deletionQuery(
        service: "net.greenroomai.GreenRoom", credentialRef: productionReference
    )
    credentialRequire(
        CFEqual(deletionQuery[kSecAttrSynchronizable] as CFTypeRef, kSecAttrSynchronizableAny),
        "Keychain deletion does not include malformed synchronizable variants"
    )

    let attributeReservation = CredentialReservation(
        profileId: "openrouter.primary", profileRevision: 1, providerId: "openrouter",
        credentialRef: productionReference,
        mutationId: "10000000-0000-4000-8000-000000000001",
        lifecycleState: "credential_pending", tombstoned: false
    )
    let attributeMetadata = CredentialMetadata(reservation: attributeReservation)
    var returnedAttributes: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: "net.greenroomai.GreenRoom",
        kSecAttrAccount: productionReference,
        kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecAttrSynchronizable: false,
        kSecAttrGeneric: try attributeMetadata.encoded(),
    ]
    credentialRequire(
        SecurityCredentialStore.inspectAttributes(
            returnedAttributes, service: "net.greenroomai.GreenRoom", credentialRef: productionReference
        ) == .valid(attributeMetadata),
        "exact production Keychain attributes were rejected"
    )
    returnedAttributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    credentialRequire(
        SecurityCredentialStore.inspectAttributes(
            returnedAttributes, service: "net.greenroomai.GreenRoom", credentialRef: productionReference
        ) == .invalid,
        "wrong Keychain accessibility was accepted"
    )
    returnedAttributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    returnedAttributes[kSecAttrSynchronizable] = true
    credentialRequire(
        SecurityCredentialStore.inspectAttributes(
            returnedAttributes, service: "net.greenroomai.GreenRoom", credentialRef: productionReference
        ) == .invalid,
        "synchronizing Keychain item was accepted"
    )
    var queryReturnedAttributes = returnedAttributes
    queryReturnedAttributes[kSecAttrSynchronizable] = nil
    queryReturnedAttributes[kSecClass] = nil
    queryReturnedAttributes[kSecAttrService] = nil
    queryReturnedAttributes[kSecAttrAccount] = nil
    credentialRequire(
        SecurityCredentialStore.inspectScopedAttributes(
            queryReturnedAttributes, credentialRef: productionReference
        ) == .valid(attributeMetadata),
        "query-scoped physical Keychain attributes were rejected when iOS omitted query-enforced fields"
    )
    queryReturnedAttributes[kSecAttrSynchronizable] = true
    credentialRequire(
        SecurityCredentialStore.inspectScopedAttributes(
            queryReturnedAttributes, credentialRef: productionReference
        ) == .invalid,
        "query-scoped physical Keychain attributes accepted an explicit synchronizing value"
    )

    var usableAttributes = queryReturnedAttributes
    usableAttributes[kSecAttrSynchronizable] = false
    usableAttributes[kSecValueData] = Data("production-use".utf8)
    var useQueries: [[CFString: Any]] = []
    let productionUseStore = SecurityCredentialStore(service: "net.greenroomai.GreenRoom") { query in
        useQueries.append(query)
        return (errSecSuccess, [usableAttributes])
    }
    var productionOperationCount = 0
    try productionUseStore.performWithCredential(
        credentialRef: productionReference, expectedMetadata: attributeMetadata
    ) { bytes in
        productionOperationCount += 1
        credentialRequire(bytes == Data("production-use".utf8), "production credential bytes mismatch")
    }
    credentialRequire(productionOperationCount == 1 && useQueries.count == 1, "credential use was not one serialized operation")
    credentialRequire(
        CFEqual(useQueries[0][kSecAttrSynchronizable] as CFTypeRef, kSecAttrSynchronizableAny) &&
            CFEqual(useQueries[0][kSecMatchLimit] as CFTypeRef, kSecMatchLimitAll),
        "production credential use did not atomically inventory every synchronizing variant"
    )

    var synchronizingAttributes = usableAttributes
    synchronizingAttributes[kSecAttrSynchronizable] = true
    for rows in [[usableAttributes, synchronizingAttributes], [synchronizingAttributes]] {
        let rejectingStore = SecurityCredentialStore(service: "net.greenroomai.GreenRoom") { _ in
            (errSecSuccess, rows)
        }
        credentialFailure("credential_missing") {
            try rejectingStore.performWithCredential(
                credentialRef: productionReference, expectedMetadata: attributeMetadata
            ) { _ in fatalError("synchronizing Keychain variant reached credential operation") }
        }
    }

    let fixtureURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("contracts/iphone-alpha-native-bridge-v1/fixtures/credential-lifecycle.json")
    let fixtureObject = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: Any]
    let fixtureCalls = fixtureObject["calls"] as! [[String: Any]]
    let fixtureData = try fixtureCalls.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
    credentialRequire(try CredentialBridgeCodec.decodeSave(fixtureData[0]).profileId == "openrouter.primary", "Swift save fixture codec mismatch")
    credentialRequire(try CredentialBridgeCodec.decodeStatus(fixtureData[1]).credentialRef == "credential:openrouter.primary:1", "Swift status fixture codec mismatch")
    credentialRequire(try CredentialBridgeCodec.decodeDelete(fixtureData[2]).providerId == "openrouter", "Swift delete fixture codec mismatch")
    var unknown = fixtureCalls[0]
    unknown["unexpected"] = true
    credentialFailure("invalid_call") {
        _ = try CredentialBridgeCodec.decodeSave(try JSONSerialization.data(withJSONObject: unknown))
    }
    var incompatible = fixtureCalls[0]
    incompatible["contractVersion"] = "iphone-native-bridge/2.0"
    credentialFailure("incompatible_contract") {
        _ = try CredentialBridgeCodec.decodeSave(try JSONSerialization.data(withJSONObject: incompatible))
    }
    credentialFailure("invalid_call") {
        _ = try CredentialBridgeCodec.decodeSave(Data(repeating: 0x20, count: credentialMaximumEnvelopeBytes + 1))
    }

    let root = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-credential-tests-\(UUID().uuidString)")
    let migrations = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("ios/App/App/Resources/Migrations")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let database = GreenRoomDatabaseStore(directory: root, migrationsDirectory: migrations, fileProtector: { _ in })
    _ = try database.open(expectedSchema: 5)
    let keychain = FakeCredentialSecureStore()
    let lifecycle = GreenRoomCredentialLifecycle(database: database, secureStore: keychain)

    let unauthorized = CredentialMutationRequest(
        profileId: "absent.profile", profileRevision: 1, providerId: "openrouter",
        credentialRef: "credential:absent.profile:1",
        mutationId: "80000000-0000-4000-8000-000000000008"
    )
    credentialFailure("transaction_rejected") {
        _ = try database.executeBatch(transactionId: "absent-profile-reservation", statements: [[
            "sqlId": "reserve_credential",
            "parameters": unauthorized.baseIdentityParameters + [NSNull(), unauthorized.mutationId],
        ]])
    }
    let readsBeforeUnauthorized = keychain.metadataReads
    credentialFailure("credential_unavailable") { _ = try lifecycle.prepareSave(unauthorized) }
    credentialRequire(keychain.metadataReads == readsBeforeUnauthorized, "absent profile authority reached Keychain")

    let save = CredentialMutationRequest(
        profileId: "openrouter.primary", profileRevision: 1, providerId: "openrouter",
        credentialRef: "credential:openrouter.primary:1",
        mutationId: "10000000-0000-4000-8000-000000000001"
    )
    try reserve(database, save, transaction: "reserve-openrouter-1")
    credentialRequire(try lifecycle.prepareSave(save), "absent item did not request native entry")
    var sentinel = Data(["NATIVE", "ONLY", "CREDENTIAL", "SENTINEL"].joined(separator: "_").utf8)
    let sentinelCopy = sentinel
    let response = try lifecycle.completeSave(save, secret: &sentinel)
    credentialRequire(sentinel.allSatisfy { $0 == 0 }, "transient field buffer was not cleared")
    credentialRequire(keychain.values[save.credentialRef]?.secret == sentinelCopy, "fake Keychain did not retain the sentinel")
    credentialRequire(response["credentialRef"] as? String == save.credentialRef && response["state"] as? String == "ready", "save result mismatch")
    credentialRequire(!(String(data: try JSONSerialization.data(withJSONObject: response), encoding: .utf8) ?? "").contains(String(decoding: sentinelCopy, as: UTF8.self)), "bridge result exposed sentinel")
    credentialRequire(try lifecycle.status(save)["state"] as? String == "ready", "ready item was not detected")
    credentialFailure("credential_unavailable") { _ = try lifecycle.prepareSave(save) }
    var observedSentinel = false
    try lifecycle.performWithReadyCredential(save) { bytes in
        observedSentinel = bytes == sentinelCopy
    }
    credentialRequire(observedSentinel && keychain.uses == 1, "ready credential was not usable only in native memory")
    let savedMetadata = keychain.values[save.credentialRef]?.metadata
    keychain.values[save.credentialRef]?.metadata = nil
    credentialFailure("credential_missing") {
        try lifecycle.performWithReadyCredential(save) { _ in fatalError("mismatched metadata reached credential bytes") }
    }
    keychain.values[save.credentialRef]?.metadata = savedMetadata

    let staleAuthorityOne = CredentialMutationRequest(
        profileId: "stale.profile", profileRevision: 1, providerId: "openrouter",
        credentialRef: "credential:stale.profile:1",
        mutationId: "11000000-0000-4000-8000-000000000001"
    )
    try reserve(database, staleAuthorityOne, transaction: "reserve-stale-profile-1")
    var staleAuthoritySecret = Data("stale-authority".utf8)
    _ = try lifecycle.completeSave(staleAuthorityOne, secret: &staleAuthoritySecret)
    _ = try database.executeBatch(transactionId: "create-stale-profile-2", statements: [[
        "sqlId": "create_connection_profile_revision",
        "parameters": [staleAuthorityOne.profileId, 2, staleAuthorityOne.providerId, 1],
    ]])
    let usesBeforeStaleAuthority = keychain.uses
    credentialFailure("credential_unavailable") {
        try lifecycle.performWithReadyCredential(staleAuthorityOne) { _ in fatalError("stale profile credential was used") }
    }
    credentialRequire(keychain.uses == usesBeforeStaleAuthority, "stale profile revision reached credential bytes")
    try lifecycle.reconcileAtDatabaseOpen()
    credentialRequire(keychain.values[staleAuthorityOne.credentialRef] == nil, "stale profile credential survived launch reconciliation")

    let replaceOne = CredentialMutationRequest(
        profileId: "replace.profile", profileRevision: 1, providerId: "openai",
        credentialRef: "credential:replace.profile:1",
        mutationId: "a0000000-0000-4000-8000-00000000000a"
    )
    try reserve(database, replaceOne, transaction: "reserve-replace-1")
    var replaceSecret = Data("synthetic-old-revision".utf8)
    _ = try lifecycle.completeSave(replaceOne, secret: &replaceSecret)
    let replaceTwo = CredentialMutationRequest(
        profileId: "replace.profile", profileRevision: 2, providerId: "openai",
        credentialRef: "credential:replace.profile:2",
        mutationId: "b0000000-0000-4000-8000-00000000000b"
    )
    try reserve(database, replaceTwo, expectedPrior: 1, transaction: "reserve-replace-2")
    credentialRequire(try lifecycle.prepareSave(replaceTwo), "replacement did not request new native entry")
    credentialRequire(keychain.values[replaceOne.credentialRef] == nil, "superseded Keychain item remained resident")

    let databaseBytes = try Data(contentsOf: root.appendingPathComponent("greenroom.sqlite"))
    credentialRequire(databaseBytes.range(of: sentinelCopy) == nil, "SQLite contained the sentinel")
    for relativePath in [
        "Library/Preferences/net.greenroomai.GreenRoom.plist",
        "Library/WebKit/WebsiteData.fixture",
        "Library/Logs/credential.log",
        "Diagnostics/credential.txt",
        "Backups/greenroom.sqlite.fixture",
    ] {
        let file = root.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("non-secret fixture".utf8).write(to: file)
    }
    let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
    credentialRequire(names.contains("greenroom.sqlite-wal") && names.contains("greenroom.sqlite-shm"), "WAL/SHM sentinel surfaces were not materialized")
    let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])
    while let file = enumerator?.nextObject() as? URL {
        let values = try file.resourceValues(forKeys: [.isRegularFileKey])
        if values.isRegularFile == true {
            credentialRequire(try Data(contentsOf: file).range(of: sentinelCopy) == nil, "sentinel escaped fake Keychain memory into \(file.lastPathComponent)")
        }
    }

    let crashRequest = CredentialMutationRequest(
        profileId: "anthropic.backup", profileRevision: 1, providerId: "anthropic",
        credentialRef: "credential:anthropic.backup:1",
        mutationId: "20000000-0000-4000-8000-000000000002"
    )
    try reserve(database, crashRequest, transaction: "reserve-anthropic-1")
    let crashLifecycle = GreenRoomCredentialLifecycle(database: database, secureStore: keychain, afterKeychainWrite: {
        throw DatabaseFailure(code: "credential_unavailable", retryable: true)
    })
    var crashSecret = Data("crash-only".utf8)
    credentialFailure("credential_unavailable") {
        _ = try crashLifecycle.completeSave(crashRequest, secret: &crashSecret)
    }
    credentialRequire(try lifecycle.status(crashRequest)["state"] as? String == "pending", "post-write crash enabled reservation")
    credentialRequire(try !lifecycle.prepareSave(crashRequest), "exact post-write replay prompted again")
    credentialRequire(try lifecycle.status(crashRequest)["state"] as? String == "ready", "exact post-write replay did not reconcile")

    let missingReady = CredentialMutationRequest(
        profileId: "openai.missing", profileRevision: 1, providerId: "openai",
        credentialRef: "credential:openai.missing:1",
        mutationId: "21000000-0000-4000-8000-000000000002"
    )
    try reserve(database, missingReady, transaction: "reserve-openai-missing-1")
    var missingReadySecret = Data("ready-then-missing".utf8)
    _ = try lifecycle.completeSave(missingReady, secret: &missingReadySecret)
    keychain.values.removeValue(forKey: missingReady.credentialRef)
    try lifecycle.reconcileAtDatabaseOpen()
    credentialRequire(try lifecycle.status(missingReady)["state"] as? String == "missing", "ready reservation stayed enabled after item loss")

    let mismatchedReady = CredentialMutationRequest(
        profileId: "xai.mismatch", profileRevision: 1, providerId: "xai",
        credentialRef: "credential:xai.mismatch:1",
        mutationId: "22000000-0000-4000-8000-000000000002"
    )
    try reserve(database, mismatchedReady, transaction: "reserve-xai-mismatch-1")
    var mismatchedReadySecret = Data("ready-then-mismatched".utf8)
    _ = try lifecycle.completeSave(mismatchedReady, secret: &mismatchedReadySecret)
    keychain.values[mismatchedReady.credentialRef]?.metadata = nil
    try lifecycle.reconcileAtDatabaseOpen()
    credentialRequire(keychain.values[mismatchedReady.credentialRef] == nil, "mismatched ready item survived reconciliation")
    credentialRequire(try lifecycle.status(mismatchedReady)["state"] as? String == "missing", "mismatched ready reservation stayed enabled")

    let mismatch = CredentialMutationRequest(
        profileId: "groq.mismatch", profileRevision: 1, providerId: "groq",
        credentialRef: "credential:groq.mismatch:1",
        mutationId: "30000000-0000-4000-8000-000000000003"
    )
    try reserve(database, mismatch, transaction: "reserve-groq-1")
    keychain.values[mismatch.credentialRef] = .init(secret: Data("not-used".utf8), metadata: CredentialMetadata(reservation: CredentialReservation(
        profileId: mismatch.profileId, profileRevision: 1, providerId: mismatch.providerId,
        credentialRef: mismatch.credentialRef, mutationId: "40000000-0000-4000-8000-000000000004",
        lifecycleState: "credential_pending", tombstoned: false
    )))
    credentialFailure("credential_unavailable") { _ = try lifecycle.prepareSave(mismatch) }
    credentialRequire(keychain.values[mismatch.credentialRef] == nil, "mismatched item survived")
    keychain.values[mismatch.credentialRef] = .init(secret: Data("malformed-not-used".utf8), metadata: nil)
    credentialFailure("credential_unavailable") { _ = try lifecycle.prepareSave(mismatch) }
    credentialRequire(keychain.values[mismatch.credentialRef] == nil, "unattributable item survived")
    credentialRequire(try lifecycle.status(mismatch)["state"] as? String == "pending", "mismatch enabled reservation")
    credentialFailure("credential_missing") {
        try lifecycle.performWithReadyCredential(mismatch) { _ in fatalError("pending credential was used") }
    }
    credentialRequire(keychain.uses == 1, "pending reservation reached credential bytes")

    let synchronizedSave = CredentialMutationRequest(
        profileId: "groq.synchronized", profileRevision: 1, providerId: "groq",
        credentialRef: "credential:groq.synchronized:1",
        mutationId: "32000000-0000-4000-8000-000000000003"
    )
    try reserve(database, synchronizedSave, transaction: "reserve-groq-synchronized-1")
    keychain.values[synchronizedSave.credentialRef] = .init(
        secret: Data("synchronized-invalid".utf8), metadata: nil
    )
    keychain.metadataInspectionOverride[synchronizedSave.credentialRef] = .invalid
    let writesBeforeSynchronizedSave = keychain.writes
    credentialFailure("credential_unavailable") { _ = try lifecycle.prepareSave(synchronizedSave) }
    keychain.metadataInspectionOverride.removeValue(forKey: synchronizedSave.credentialRef)
    credentialRequire(keychain.values[synchronizedSave.credentialRef] == nil, "synchronizable save variant survived preflight")
    credentialRequire(keychain.writes == writesBeforeSynchronizedSave, "synchronizable save variant allowed a second Keychain write")

    let duplicateReference = CredentialMutationRequest(
        profileId: "groq.duplicate", profileRevision: 1, providerId: "groq",
        credentialRef: "credential:groq.duplicate:1",
        mutationId: "31000000-0000-4000-8000-000000000003"
    )
    try reserve(database, duplicateReference, transaction: "reserve-groq-duplicate-1")
    let duplicateReservation = try database.credentialReservation(
        profileId: duplicateReference.profileId, profileRevision: 1,
        providerId: duplicateReference.providerId, credentialRef: duplicateReference.credentialRef
    )!
    keychain.values[duplicateReference.credentialRef] = .init(
        secret: Data("duplicate".utf8), metadata: CredentialMetadata(reservation: duplicateReservation)
    )
    keychain.inventoryOverride = keychain.values.map {
        CredentialStoredItem(
            credentialRef: $0.key,
            inspection: $0.value.metadata.map(CredentialMetadataInspection.valid) ?? .invalid
        )
    } + [CredentialStoredItem(credentialRef: duplicateReference.credentialRef, inspection: .invalid)]
    try lifecycle.reconcileAtDatabaseOpen()
    keychain.inventoryOverride = nil
    credentialRequire(keychain.values[duplicateReference.credentialRef] == nil, "duplicate Keychain variants survived reconciliation")
    credentialRequire(try lifecycle.status(duplicateReference)["state"] as? String == "pending", "duplicate Keychain variants enabled reservation")

    let registryTombstone = CredentialMutationRequest(
        profileId: "mistral.registry", profileRevision: 1, providerId: "mistral",
        credentialRef: "credential:mistral.registry:1",
        mutationId: "60000000-0000-4000-8000-000000000006"
    )
    try reserve(database, registryTombstone, transaction: "reserve-mistral-1")
    let tombstoneParameters: [Any] = registryTombstone.baseIdentityParameters + ["70000000-0000-4000-8000-000000000007"]
    let registryResult = try database.executeBatch(transactionId: "tombstone-mistral-1", statements: [[
        "sqlId": "tombstone_credential", "parameters": tombstoneParameters,
    ]])
    credentialRequire(registryResult["changes"] as? Int == 1, "allowlisted tombstone did not report one immutable insert")
    _ = try database.executeBatch(transactionId: "tombstone-mistral-1", statements: [[
        "sqlId": "tombstone_credential", "parameters": tombstoneParameters,
    ]])
    let registryRecord = try database.credentialReservation(
        profileId: registryTombstone.profileId, profileRevision: 1,
        providerId: registryTombstone.providerId, credentialRef: registryTombstone.credentialRef
    )
    credentialRequire(registryRecord?.tombstoned == true && registryRecord?.lifecycleState == "delete_pending", "allowlisted tombstone did not durably block use")

    let readsBeforeStale = keychain.metadataReads
    var stale = save
    stale = CredentialMutationRequest(
        profileId: stale.profileId, profileRevision: 2, providerId: stale.providerId,
        credentialRef: "credential:openrouter.primary:2", mutationId: stale.mutationId
    )
    credentialFailure("credential_unavailable") { _ = try lifecycle.prepareSave(stale) }
    credentialRequire(keychain.metadataReads == readsBeforeStale, "stale request reached Keychain")

    let delete = CredentialMutationRequest(
        profileId: save.profileId, profileRevision: save.profileRevision, providerId: save.providerId,
        credentialRef: save.credentialRef, mutationId: "50000000-0000-4000-8000-000000000005"
    )
    keychain.failDelete = true
    credentialFailure("credential_write_failed") { _ = try lifecycle.delete(delete) }
    let tombstoned = try database.credentialReservation(
        profileId: save.profileId, profileRevision: 1, providerId: save.providerId, credentialRef: save.credentialRef
    )
    credentialRequire(tombstoned?.tombstoned == true && tombstoned?.lifecycleState == "delete_pending", "Keychain failure preceded durable tombstone")
    credentialRequire(try lifecycle.status(save)["state"] as? String == "delete_pending", "pending deletion was hidden")
    keychain.failDelete = false
    credentialRequire(try lifecycle.delete(delete)["state"] as? String == "missing", "delete replay did not finish")
    credentialRequire(try lifecycle.status(save)["state"] as? String == "missing", "deleted item was not missing")
    let deletedRecord = try database.credentialReservation(
        profileId: save.profileId, profileRevision: 1, providerId: save.providerId, credentialRef: save.credentialRef
    )
    credentialRequire(deletedRecord?.tombstoned == true && deletedRecord?.lifecycleState == "missing", "completed deletion was not durable missing state")

    keychain.values["credential:orphan:1"] = .init(secret: Data("orphan".utf8), metadata: nil)
    try lifecycle.reconcileAtDatabaseOpen()
    credentialRequire(keychain.values["credential:orphan:1"] == nil, "launch reconciliation retained orphan")

    let reinstallRoot = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-reinstall-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: reinstallRoot) }
    try FileManager.default.createDirectory(at: reinstallRoot, withIntermediateDirectories: true)
    let reinstallDatabase = GreenRoomDatabaseStore(directory: reinstallRoot, migrationsDirectory: migrations, fileProtector: { _ in })
    _ = try reinstallDatabase.open(expectedSchema: 5)
    keychain.values[crashRequest.credentialRef] = .init(secret: Data("persisted-by-ios".utf8), metadata: keychain.values[crashRequest.credentialRef]?.metadata)
    let reinstall = GreenRoomCredentialLifecycle(database: reinstallDatabase, secureStore: keychain)
    try reinstall.reconcileAtDatabaseOpen()
    credentialRequire(keychain.values[crashRequest.credentialRef] == nil, "fresh database did not remove uninstall-persisted orphan")

    let independentlyTombstonedRoot = FileManager.default.temporaryDirectory.appendingPathComponent("greenroom-independent-tombstone-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: independentlyTombstonedRoot) }
    try FileManager.default.createDirectory(at: independentlyTombstonedRoot, withIntermediateDirectories: true)
    let independentlyTombstonedDatabase = GreenRoomDatabaseStore(
        directory: independentlyTombstonedRoot, migrationsDirectory: migrations, fileProtector: { _ in }
    )
    _ = try independentlyTombstonedDatabase.open(expectedSchema: 5)
    let independentlyTombstonedKeychain = FakeCredentialSecureStore()
    let independentlyTombstonedLifecycle = GreenRoomCredentialLifecycle(
        database: independentlyTombstonedDatabase, secureStore: independentlyTombstonedKeychain
    )
    let independentlyTombstoned = CredentialMutationRequest(
        profileId: "openai.disabled", profileRevision: 1, providerId: "openai",
        credentialRef: "credential:openai.disabled:1",
        mutationId: "71000000-0000-4000-8000-000000000007"
    )
    try reserve(independentlyTombstonedDatabase, independentlyTombstoned, transaction: "reserve-openai-disabled-1")
    var independentlyTombstonedSecret = Data("independently-tombstoned".utf8)
    _ = try independentlyTombstonedLifecycle.completeSave(
        independentlyTombstoned, secret: &independentlyTombstonedSecret
    )
    _ = try independentlyTombstonedDatabase.close()
    var rawDatabase: OpaquePointer?
    let rawPath = independentlyTombstonedRoot.appendingPathComponent("greenroom.sqlite").path
    credentialRequire(sqlite3_open_v2(rawPath, &rawDatabase, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, "could not open tombstone regression database")
    defer { if let rawDatabase { sqlite3_close_v2(rawDatabase) } }
    credentialRequire(
        sqlite3_exec(
            rawDatabase,
            "UPDATE connection_profile_revisions SET tombstoned = 1 WHERE profile_id = 'openai.disabled' AND profile_revision = 1",
            nil, nil, nil
        ) == SQLITE_OK,
        "could not create independently tombstoned profile regression"
    )
    if let rawDatabase { sqlite3_close_v2(rawDatabase) }
    rawDatabase = nil
    _ = try independentlyTombstonedDatabase.open(expectedSchema: 5)
    credentialFailure("credential_unavailable") {
        try independentlyTombstonedLifecycle.performWithReadyCredential(independentlyTombstoned) { _ in
            fatalError("independently tombstoned profile reached credential bytes")
        }
    }
    try independentlyTombstonedLifecycle.reconcileAtDatabaseOpen()
    credentialRequire(
        independentlyTombstonedKeychain.values[independentlyTombstoned.credentialRef] == nil,
        "independently tombstoned profile retained Keychain bytes"
    )

    credentialFailure("invalid_call") {
        _ = try validateCredentialIdentity(CredentialMutationRequest(
            profileId: "../bad", profileRevision: 1, providerId: "openrouter",
            credentialRef: "credential:../bad:1", mutationId: save.mutationId
        ))
    }
    var oversized = Data(repeating: 1, count: credentialMaximumSecretBytes + 1)
    credentialFailure("invalid_call") { _ = try lifecycle.completeSave(mismatch, secret: &oversized) }
    credentialRequire(oversized.allSatisfy { $0 == 0 }, "oversized rejected secret buffer was not cleared")
}
