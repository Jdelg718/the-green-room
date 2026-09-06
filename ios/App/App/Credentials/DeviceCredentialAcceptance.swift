#if DEBUG
import Foundation
import Security
import UIKit

@MainActor
final class DeviceCredentialAcceptance {
    private static let launchPrefix = "greenroom-credential-device-acceptance="
    private static let evidenceName = "credential-acceptance-evidence.json"
    private static let service = "net.greenroomai.GreenRoom.device-credential-acceptance"

    private let secureStore = SecurityCredentialStore(service: service)
    private var database: GreenRoomDatabaseStore?
    private var lifecycle: GreenRoomCredentialLifecycle?
    private var recoveryRequest: CredentialMutationRequest?
    private var expectedMetadata: CredentialMetadata?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var lockedDenialObserved = false
    private var failureState = "failed_start"

    static func requested() -> DeviceCredentialAcceptance? {
        let stages = ProcessInfo.processInfo.arguments.compactMap { argument -> String? in
            guard argument.hasPrefix(launchPrefix) else { return nil }
            return String(argument.dropFirst(launchPrefix.count))
        }
        guard stages.count == 1, ["prepare", "recover-lock-cycle", "cleanup"].contains(stages[0]) else {
            return nil
        }
        return DeviceCredentialAcceptance()
    }

    func start(application: UIApplication) {
        guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(Self.launchPrefix) }) else {
            return
        }
        do {
            if argument == "\(Self.launchPrefix)prepare" {
                try prepareTerminationRecovery()
            } else if argument == "\(Self.launchPrefix)recover-lock-cycle" {
                try recoverAndAwaitLock(application: application)
            } else if argument == "\(Self.launchPrefix)cleanup" {
                let cleanup = try removePriorAcceptanceState()
                try writeEvidence([
                    "status": "clean",
                    "keychainItemCount": cleanup.keychainItemCount,
                    "acceptanceStatePresent": cleanup.acceptanceStatePresent,
                ])
            }
        } catch {
            do {
                let cleanup = try removePriorAcceptanceState()
                try writeEvidence([
                    "status": failureState,
                    "keychainItemCount": cleanup.keychainItemCount,
                    "acceptanceStatePresent": cleanup.acceptanceStatePresent,
                ])
            } catch {
                try? writeEvidence(["status": "failed_cleanup"])
            }
        }
    }

    func protectedDataWillBecomeUnavailable(application: UIApplication) {
        guard lifecycle != nil, recoveryRequest != nil, expectedMetadata != nil else { return }
        if backgroundTask == .invalid {
            backgroundTask = application.beginBackgroundTask { [weak self] in
                Task { @MainActor in self?.finishBackgroundTask(application: application) }
            }
        }
        observeLockedDenial(application: application, attemptsRemaining: 50)
    }

    func protectedDataDidBecomeAvailable(application: UIApplication) {
        guard lockedDenialObserved else { return }
        do {
            failureState = "failed_post_unlock"
            try finishAfterUnlock()
        } catch {
            do {
                let cleanup = try removePriorAcceptanceState()
                try writeEvidence([
                    "status": failureState,
                    "keychainItemCount": cleanup.keychainItemCount,
                    "acceptanceStatePresent": cleanup.acceptanceStatePresent,
                ])
            } catch {
                try? writeEvidence(["status": "failed_cleanup"])
            }
        }
        finishBackgroundTask(application: application)
    }

    private func prepareTerminationRecovery() throws {
        failureState = "failed_cleanup"
        try removePriorAcceptanceState()
        failureState = "failed_database_open"
        let database = GreenRoomDatabaseStore(directory: try acceptanceDirectory())
        _ = try database.open(expectedSchema: 5)
        let lifecycle = GreenRoomCredentialLifecycle(database: database, secureStore: secureStore)

        let lifecycleRequest = request(
            profile: "device.acceptance.lifecycle",
            mutation: "16000000-0000-4000-8000-000000000001"
        )
        failureState = "failed_lifecycle_reserve"
        try reserve(database, lifecycleRequest, transaction: "device-acceptance-lifecycle")
        failureState = "failed_lifecycle_save"
        var lifecycleSecret = try randomSecret()
        _ = try lifecycle.completeSave(lifecycleRequest, secret: &lifecycleSecret)
        failureState = "failed_attribute_inspection"
        let attributes = try secureStore.acceptanceAttributeEvidence(credentialRef: lifecycleRequest.credentialRef)
        failureState = "failed_lifecycle_use"
        var useSucceeded = false
        try lifecycle.performWithReadyCredential(lifecycleRequest) { bytes in
            useSucceeded = !bytes.isEmpty && bytes.count <= credentialMaximumSecretBytes
        }
        let deleteRequest = CredentialMutationRequest(
            profileId: lifecycleRequest.profileId,
            profileRevision: lifecycleRequest.profileRevision,
            providerId: lifecycleRequest.providerId,
            credentialRef: lifecycleRequest.credentialRef,
            mutationId: "16000000-0000-4000-8000-000000000002"
        )
        failureState = "failed_lifecycle_delete"
        let deleteResult = try lifecycle.delete(deleteRequest)

        let recovery = request(
            profile: "device.acceptance.recovery",
            mutation: "16000000-0000-4000-8000-000000000003"
        )
        failureState = "failed_recovery_reserve"
        try reserve(database, recovery, transaction: "device-acceptance-recovery")
        let interruptedLifecycle = GreenRoomCredentialLifecycle(
            database: database,
            secureStore: secureStore,
            afterKeychainWrite: { throw DatabaseFailure(code: "credential_unavailable", retryable: true) }
        )
        failureState = "failed_recovery_write"
        var recoverySecret = try randomSecret()
        var interruptionObserved = false
        do {
            _ = try interruptedLifecycle.completeSave(recovery, secret: &recoverySecret)
        } catch {
            interruptionObserved = true
        }
        failureState = "failed_recovery_inspection"
        let pending = try lifecycle.status(recovery)["state"] as? String == "pending"
        let recoveryAttributes = try secureStore.acceptanceAttributeEvidence(credentialRef: recovery.credentialRef)
        _ = try database.close()

        try writeEvidence([
            "status": "awaiting_termination",
            "saveSucceeded": true,
            "useSucceeded": useSucceeded,
            "deleteSucceeded": deleteResult["state"] as? String == "missing",
            "exactAccessibility": attributes.exactAccessibility && recoveryAttributes.exactAccessibility,
            "nonSynchronizing": attributes.nonSynchronizing && recoveryAttributes.nonSynchronizing,
            "exactAttributeItemCount": attributes.itemCount + recoveryAttributes.itemCount,
            "interruptionObserved": interruptionObserved,
            "recoveryState": pending ? "pending" : "failed",
            "recoveryItemCount": recoveryAttributes.itemCount,
        ])
    }

    private func recoverAndAwaitLock(application: UIApplication) throws {
        failureState = "failed_recovery_open"
        let database = GreenRoomDatabaseStore(directory: try acceptanceDirectory())
        let authority = GreenRoomNativeAuthority(database: database, secureStore: secureStore)
        _ = try authority.openDatabase(expectedSchema: 5)
        let recovery = request(
            profile: "device.acceptance.recovery",
            mutation: "16000000-0000-4000-8000-000000000003"
        )
        lifecycle = authority.credentials
        self.database = database
        recoveryRequest = recovery
        guard let reservation = try database.credentialReservation(
            profileId: recovery.profileId,
            profileRevision: recovery.profileRevision,
            providerId: recovery.providerId,
            credentialRef: recovery.credentialRef
        ) else { throw DatabaseFailure(code: "credential_unavailable", retryable: false) }
        expectedMetadata = CredentialMetadata(reservation: reservation)

        failureState = "failed_recovery_use"
        if priorEvidenceObservedLockedDenial() {
            lockedDenialObserved = true
            try finishAfterUnlock()
            return
        }

        let recovered = try authority.credentials.status(recovery)["state"] as? String == "ready"
        var useSucceeded = false
        try authority.credentials.performWithReadyCredential(recovery) { bytes in
            useSucceeded = !bytes.isEmpty && bytes.count <= credentialMaximumSecretBytes
        }
        let attributes = try secureStore.acceptanceAttributeEvidence(credentialRef: recovery.credentialRef)
        try writeEvidence([
            "status": "awaiting_lock",
            "reconciledState": recovered ? "ready" : "failed",
            "useSucceeded": useSucceeded,
            "exactAccessibility": attributes.exactAccessibility,
            "nonSynchronizing": attributes.nonSynchronizing,
            "itemCount": attributes.itemCount,
            "protectedDataAvailable": application.isProtectedDataAvailable,
            "lockedDenialObserved": false,
        ])
    }

    private func observeLockedDenial(application: UIApplication, attemptsRemaining: Int) {
        guard attemptsRemaining > 0 else {
            try? writeEvidence(["status": "failed_lock_observation"])
            finishBackgroundTask(application: application)
            return
        }
        guard !application.isProtectedDataAvailable,
              let expectedMetadata,
              let recoveryRequest else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.observeLockedDenial(application: application, attemptsRemaining: attemptsRemaining - 1)
            }
            return
        }
        do {
            guard try secureStore.acceptanceLockedReadDenied(credentialRef: recoveryRequest.credentialRef) else {
                try? writeEvidence(["status": "failed_locked_read_succeeded"])
                return
            }
            lockedDenialObserved = true
            try writeEvidence([
                "status": "awaiting_unlock",
                "protectedDataAvailable": false,
                "lockedDenialObserved": true,
            ])
        } catch {
            try? writeEvidence(["status": "failed_locked_read"])
        }
    }

    private func finishAfterUnlock() throws {
        guard let lifecycle, let recoveryRequest else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: false)
        }
        var postUnlockUseSucceeded = false
        try lifecycle.performWithReadyCredential(recoveryRequest) { bytes in
            postUnlockUseSucceeded = !bytes.isEmpty && bytes.count <= credentialMaximumSecretBytes
        }
        let deleteRequest = CredentialMutationRequest(
            profileId: recoveryRequest.profileId,
            profileRevision: recoveryRequest.profileRevision,
            providerId: recoveryRequest.providerId,
            credentialRef: recoveryRequest.credentialRef,
            mutationId: "16000000-0000-4000-8000-000000000004"
        )
        let deleteSucceeded = try lifecycle.delete(deleteRequest)["state"] as? String == "missing"
        let itemCount = try secureStore.inventory().count
        _ = try database?.close()
        let directory = try acceptanceDirectoryURL(create: false)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        guard !FileManager.default.fileExists(atPath: directory.path), itemCount == 0 else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: true)
        }
        database = nil
        self.lifecycle = nil
        self.recoveryRequest = nil
        expectedMetadata = nil
        try writeEvidence([
            "status": "pass",
            "terminationRecovery": true,
            "lockedDenialObserved": true,
            "postUnlockUseSucceeded": postUnlockUseSucceeded,
            "deleteSucceeded": deleteSucceeded,
            "remainingItemCount": itemCount,
            "acceptanceStatePresent": false,
        ])
    }

    private func priorEvidenceObservedLockedDenial() -> Bool {
        guard let data = try? Data(contentsOf: evidenceURL()),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return object["status"] as? String == "awaiting_unlock" && object["lockedDenialObserved"] as? Bool == true
    }

    private func request(profile: String, mutation: String) -> CredentialMutationRequest {
        CredentialMutationRequest(
            profileId: profile,
            profileRevision: 1,
            providerId: "openrouter",
            credentialRef: canonicalCredentialReference(profileId: profile, revision: 1),
            mutationId: mutation
        )
    }

    private func reserve(_ database: GreenRoomDatabaseStore, _ request: CredentialMutationRequest, transaction: String) throws {
        _ = try database.executeBatch(transactionId: transaction, statements: [
            [
                "sqlId": "create_connection_profile_revision",
                "parameters": [request.profileId, request.profileRevision, request.providerId, NSNull()],
            ],
            ["sqlId": "reserve_credential", "parameters": request.baseIdentityParameters + [NSNull(), request.mutationId]],
        ])
    }

    private func randomSecret() throws -> Data {
        var bytes = Data(count: 64)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            bytes.resetBytes(in: 0..<bytes.count)
            throw DatabaseFailure(code: "credential_unavailable", retryable: true)
        }
        return bytes
    }

    private func removePriorAcceptanceState() throws -> (keychainItemCount: Int, acceptanceStatePresent: Bool) {
        _ = try database?.close()
        database = nil
        lifecycle = nil
        recoveryRequest = nil
        expectedMetadata = nil
        for item in try secureStore.inventory() {
            try secureStore.delete(credentialRef: item.credentialRef)
        }
        let remainingItems = try secureStore.inventory()
        let directory = try acceptanceDirectoryURL(create: false)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        let evidence = evidenceURL()
        if FileManager.default.fileExists(atPath: evidence.path) {
            try FileManager.default.removeItem(at: evidence)
        }
        let statePresent = FileManager.default.fileExists(atPath: directory.path)
        guard remainingItems.isEmpty, !statePresent else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: true)
        }
        return (remainingItems.count, statePresent)
    }

    private func acceptanceDirectory() throws -> URL {
        try acceptanceDirectoryURL(create: true)
    }

    private func acceptanceDirectoryURL(create: Bool) throws -> URL {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: create
        )
        let directory = root.appendingPathComponent("GreenRoomCredentialAcceptance", isDirectory: true)
        if create {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutable = directory
            try mutable.setResourceValues(values)
        }
        return directory
    }

    private func evidenceURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(Self.evidenceName)
    }

    private func writeEvidence(_ evidence: [String: Any]) throws {
        let allowedKeys = Set([
            "status", "saveSucceeded", "useSucceeded", "deleteSucceeded", "exactAccessibility",
            "nonSynchronizing", "exactAttributeItemCount", "interruptionObserved", "recoveryState",
            "recoveryItemCount", "reconciledState", "itemCount", "protectedDataAvailable",
            "lockedDenialObserved", "terminationRecovery", "postUnlockUseSucceeded", "remainingItemCount",
            "keychainItemCount", "acceptanceStatePresent",
        ])
        let allowedStates = Set([
            "awaiting_termination", "pending", "awaiting_lock", "ready", "awaiting_unlock", "pass", "clean", "failed",
            "failed_start", "failed_cleanup", "failed_database_open", "failed_lifecycle_reserve",
            "failed_lifecycle_save", "failed_attribute_inspection", "failed_lifecycle_use",
            "failed_lifecycle_delete", "failed_recovery_reserve", "failed_recovery_write",
            "failed_recovery_inspection", "failed_recovery_open", "failed_recovery_use",
            "failed_lock_observation", "failed_locked_read_succeeded", "failed_locked_read",
            "failed_post_unlock",
        ])
        guard Set(evidence.keys).isSubset(of: allowedKeys),
              evidence.allSatisfy({ key, value in
                  if let value = value as? Bool { return value == true || value == false }
                  if let value = value as? Int { return key.hasSuffix("Count") && value >= 0 }
                  if let value = value as? String { return allowedStates.contains(value) }
                  return false
              }),
              JSONSerialization.isValidJSONObject(evidence),
              JSONSerialization.isValidJSONObject(evidence) else {
            throw DatabaseFailure(code: "credential_unavailable", retryable: false)
        }
        let encoded = try JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys])
        try encoded.write(to: evidenceURL(), options: [.atomic])
    }

    private func finishBackgroundTask(application: UIApplication) {
        guard backgroundTask != .invalid else { return }
        application.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
#endif
