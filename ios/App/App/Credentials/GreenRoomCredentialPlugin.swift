import Foundation

#if canImport(Capacitor) && canImport(UIKit)
import Capacitor
import UIKit
#endif

final class GreenRoomNativeAuthority: @unchecked Sendable {
    static let shared = GreenRoomNativeAuthority()

    let database: GreenRoomDatabaseStore
    let credentials: GreenRoomCredentialLifecycle
    let inFlightCalls = CredentialInFlightCalls()
    private var databaseReconciled = false

    init(
        database: GreenRoomDatabaseStore = GreenRoomDatabaseStore(),
        secureStore: any CredentialSecureStore = SecurityCredentialStore()
    ) {
        self.database = database
        credentials = GreenRoomCredentialLifecycle(database: database, secureStore: secureStore)
    }

    func openDatabase(expectedSchema: Int) throws -> [String: Any] {
        try database.serializationLock.withLock {
            databaseReconciled = false
            let result = try database.open(expectedSchema: expectedSchema)
            do {
                try credentials.reconcileAtDatabaseOpen()
                databaseReconciled = true
                return result
            } catch {
                _ = try? database.close()
                throw error
            }
        }
    }

    func closeDatabase() throws -> [String: Any] {
        try database.serializationLock.withLock {
            databaseReconciled = false
            return try database.close()
        }
    }

    func withReconciledDatabase<T>(
        unavailableCode: String = "database_unavailable",
        _ operation: () throws -> T
    ) throws -> T {
        try database.serializationLock.withLock {
            guard databaseReconciled else {
                throw DatabaseFailure(code: unavailableCode, retryable: true)
            }
            return try operation()
        }
    }
}

#if canImport(Capacitor) && canImport(UIKit)
private final class NativeCredentialAlertSource: NativeCredentialSecretSource {
    private weak var presenter: UIViewController?

    init(presenter: UIViewController) { self.presenter = presenter }

    func requestSecret(
        for request: CredentialMutationRequest,
        completion: @escaping (Result<Data, DatabaseFailure>) -> Void
    ) {
        guard let presenter, presenter.presentedViewController == nil else {
            completion(.failure(DatabaseFailure(code: "credential_unavailable", retryable: true)))
            return
        }
        let alert = UIAlertController(
            title: "Save provider credential",
            message: "Stored only in this iPhone's Keychain for \(request.providerId).",
            preferredStyle: .alert
        )
        alert.addTextField { field in
            field.isSecureTextEntry = true
            field.textContentType = .password
            field.autocorrectionType = .no
            field.autocapitalizationType = .none
            field.spellCheckingType = .no
            field.placeholder = "API key"
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
            alert.textFields?.first?.text = nil
            completion(.failure(DatabaseFailure(code: "canceled", retryable: true)))
        })
        alert.addAction(UIAlertAction(title: "Save", style: .default) { _ in
            guard let field = alert.textFields?.first,
                  let value = field.text,
                  !value.isEmpty,
                  value.utf8.count <= credentialMaximumSecretBytes else {
                alert.textFields?.first?.text = nil
                completion(.failure(DatabaseFailure(code: "invalid_call", retryable: false)))
                return
            }
            var bytes = Data(value.utf8)
            field.text = nil
            completion(.success(bytes))
            bytes.resetBytes(in: 0..<bytes.count)
        })
        presenter.present(alert, animated: true)
    }
}

@objc(GreenRoomCredentialPlugin)
final class GreenRoomCredentialPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GreenRoomCredentialPlugin"
    let jsName = "GreenRoomCredential"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "presentSaveSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
    ]
    private let lifecycle = GreenRoomNativeAuthority.shared.credentials
    private let inFlightCalls = GreenRoomNativeAuthority.shared.inFlightCalls

    @objc @MainActor func presentSaveSheet(_ call: CAPPluginCall) {
        let callId = canonicalBridgeCallId((call.options as? [String: Any])?["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "invalid_call", retryable: false))
            return
        }
        var completionOwnsCallId = false
        defer {
            if !completionOwnsCallId { inFlightCalls.finish(callId) }
        }
        do {
            let request = try parseMutation(call, method: "credential.presentSaveSheet", includeReference: false)
            if try !GreenRoomNativeAuthority.shared.withReconciledDatabase(
                unavailableCode: "credential_unavailable",
                { try lifecycle.prepareSave(request) }
            ) {
                resolve(call, callId: callId, value: lifecycle.readyResult(request))
                return
            }
            guard let presenter = bridge?.viewController else {
                throw DatabaseFailure(code: "credential_unavailable", retryable: true)
            }
            completionOwnsCallId = true
            NativeCredentialAlertSource(presenter: presenter).requestSecret(for: request) { [weak self, weak call] outcome in
                guard let self else { return }
                defer { self.inFlightCalls.finish(callId) }
                guard let call else { return }
                switch outcome {
                case .success(var secret):
                    do {
                        let value = try GreenRoomNativeAuthority.shared.withReconciledDatabase(
                            unavailableCode: "credential_unavailable"
                        ) {
                            try self.lifecycle.completeSave(request, secret: &secret)
                        }
                        self.resolve(call, callId: callId, value: value)
                    } catch let failure as DatabaseFailure {
                        self.reject(call, callId: callId, failure: failure)
                    } catch {
                        self.reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false))
                    }
                case .failure(let failure):
                    self.reject(call, callId: callId, failure: failure)
                }
            }
        } catch let failure as DatabaseFailure {
            reject(call, callId: callId, failure: failure)
        } catch {
            reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false))
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        let callId = canonicalBridgeCallId((call.options as? [String: Any])?["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "invalid_call", retryable: false))
            return
        }
        defer { inFlightCalls.finish(callId) }
        do {
            let request = try parseStatus(call, method: "credential.status")
            let value = try GreenRoomNativeAuthority.shared.withReconciledDatabase(
                unavailableCode: "credential_unavailable"
            ) { () -> [String: Any] in
                guard let reservation = try GreenRoomNativeAuthority.shared.database.credentialReservation(
                    profileId: request.profileId,
                    profileRevision: request.profileRevision,
                    providerId: request.providerId,
                    credentialRef: request.credentialRef
                ) else {
                    return ["state": "missing"]
                }
                return try lifecycle.status(reservation.mutationRequest)
            }
            resolve(call, callId: callId, value: value)
        } catch let failure as DatabaseFailure {
            reject(call, callId: callId, failure: failure)
        } catch {
            reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false))
        }
    }

    @objc func delete(_ call: CAPPluginCall) {
        let callId = canonicalBridgeCallId((call.options as? [String: Any])?["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "invalid_call", retryable: false))
            return
        }
        defer { inFlightCalls.finish(callId) }
        do {
            let request = try parseMutation(call, method: "credential.delete", includeReference: true)
            resolve(call, callId: callId, value: try GreenRoomNativeAuthority.shared.withReconciledDatabase(
                unavailableCode: "credential_unavailable"
            ) {
                try lifecycle.delete(request)
            })
        } catch let failure as DatabaseFailure {
            reject(call, callId: callId, failure: failure)
        } catch {
            reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false))
        }
    }

    private func encodedEnvelope(_ call: CAPPluginCall) throws -> Data {
        let options = call.options as? [String: Any] ?? [:]
        return try encodedBridgeJSONObject(
            options,
            code: "invalid_call",
            maximumBytes: credentialMaximumEnvelopeBytes
        )
    }

    private func parseMutation(_ call: CAPPluginCall, method: String, includeReference: Bool) throws -> CredentialMutationRequest {
        let data = try encodedEnvelope(call)
        if method == "credential.presentSaveSheet", !includeReference {
            return try CredentialBridgeCodec.decodeSave(data)
        }
        if method == "credential.delete", includeReference {
            return try CredentialBridgeCodec.decodeDelete(data)
        }
        throw DatabaseFailure(code: "invalid_call", retryable: false)
    }

    private func parseStatus(_ call: CAPPluginCall, method: String) throws -> CredentialStatusRequest {
        guard method == "credential.status" else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        return try CredentialBridgeCodec.decodeStatus(try encodedEnvelope(call))
    }

    private func resolve(_ call: CAPPluginCall, callId: String, value: [String: Any]) {
        let response: [String: Any] = ["callId": callId, "ok": true, "value": value]
        guard (try? encodedBridgeJSONObject(response, code: "result_too_large")) != nil else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false))
            return
        }
        call.resolve(response)
    }

    private func reject(_ call: CAPPluginCall, callId: String, failure: DatabaseFailure) {
        call.resolve(["callId": callId, "ok": false, "error": ["code": failure.code, "retryable": failure.retryable]])
    }
}
#endif
