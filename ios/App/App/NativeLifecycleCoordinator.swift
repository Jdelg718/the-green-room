import Capacitor
import Foundation
import Network
import UIKit

final class NativeLifecycleCoordinator: @unchecked Sendable {
    static let shared = NativeLifecycleCoordinator()
    private let lock = NSLock()
    private let availabilityPublicationLock = NSLock()
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "net.greenroomai.lifecycle.path")
    private var active = false
    private var protectedDataAvailable = false
    private var pathAvailable = false
    private var epoch = 0
    private var started = false

    func start(application: UIApplication) {
        let publication = mutateAndPublishAvailability {
            active = application.applicationState == .active
            protectedDataAvailable = application.isProtectedDataAvailable
            guard !started else { return false }
            started = true
            return true
        }
        guard publication.marker else { return }
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let publication = self.mutateAndPublishAvailability {
                let hadPath = self.pathAvailable
                self.pathAvailable = path.status == .satisfied
                self.epoch += 1
                return hadPath && !self.pathAvailable
            }
            if publication.marker {
                try? GreenRoomNativeAuthority.shared.withReconciledDatabase {
                    try GreenRoomNativeAuthority.shared.database.interruptInFlightGenerationCommands()
                }
            }
        }
        monitor.start(queue: monitorQueue)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        mutateAndPublishAvailability { active = false; epoch += 1; return false }
        cancelCloseAndFence()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        mutateAndPublishAvailability { active = false; epoch += 1; return false }
        cancelCloseAndFence()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        mutateAndPublishAvailability {
            active = true
            protectedDataAvailable = application.isProtectedDataAvailable
            epoch += 1
            return false
        }
        if application.isProtectedDataAvailable {
            _ = try? GreenRoomNativeAuthority.shared.openDatabase(expectedSchema: 8)
        }
    }

    func applicationProtectedDataWillBecomeUnavailable(_ application: UIApplication) {
        mutateAndPublishAvailability { protectedDataAvailable = false; epoch += 1; return false }
        cancelCloseAndFence()
    }

    func applicationProtectedDataDidBecomeAvailable(_ application: UIApplication) {
        mutateAndPublishAvailability { protectedDataAvailable = true; epoch += 1; return false }
        if application.applicationState == .active {
            _ = try? GreenRoomNativeAuthority.shared.openDatabase(expectedSchema: 8)
        }
    }

    @discardableResult
    func synchronizeProviderAvailability() -> Bool {
        mutateAndPublishAvailability { false }.available
    }

    func status(application: UIApplication) -> [String: Any] {
        synchronizeProviderAvailability()
        return lock.withLock {
            [
                "active": active && application.applicationState == .active,
                "protectedDataAvailable": protectedDataAvailable && application.isProtectedDataAvailable,
                "pathAvailable": pathAvailable,
                "databaseReady": GreenRoomNativeAuthority.shared.isDatabaseReconciled,
                "epoch": epoch,
            ]
        }
    }

    private func mutateAndPublishAvailability(_ mutation: () -> Bool) -> (marker: Bool, available: Bool) {
        availabilityPublicationLock.withLock {
            let snapshot = lock.withLock { () -> (marker: Bool, available: Bool) in
                let marker = mutation()
                return (marker, active && protectedDataAvailable && pathAvailable)
            }
            ProviderTaskRegistry.shared.updateLifecycleAvailability(snapshot.available)
            return snapshot
        }
    }

    private func cancelCloseAndFence() {
        synchronizeProviderAvailability()
        try? GreenRoomNativeAuthority.shared.withReconciledDatabase {
            try GreenRoomNativeAuthority.shared.database.interruptInFlightGenerationCommands()
            _ = try GreenRoomNativeAuthority.shared.database.checkpoint()
        }
        _ = try? GreenRoomNativeAuthority.shared.closeDatabase()
    }
}

@objc(GreenRoomLifecyclePlugin)
final class GreenRoomLifecyclePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GreenRoomLifecyclePlugin"
    let jsName = "GreenRoomLifecycle"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]
    private let inFlightCalls = GreenRoomNativeAuthority.shared.inFlightCalls

    @objc func status(_ call: CAPPluginCall) {
        let options = call.options as? [String: Any] ?? [:]
        let callId = canonicalBridgeCallId(options["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            call.resolve(["callId": callId, "ok": false, "error": ["code": "invalid_call", "retryable": false]])
            return
        }
        defer { inFlightCalls.finish(callId) }
        do {
            _ = try ProviderBridgeDispatch.lifecycleStatus(options)
            call.resolve(try ProviderBridgeDispatch.success(
                callId: callId,
                value: NativeLifecycleCoordinator.shared.status(application: UIApplication.shared),
                kind: .lifecycle
            ))
        } catch let failure as DatabaseFailure {
            call.resolve(ProviderBridgeDispatch.failure(callId: callId, failure: failure, kind: .lifecycle))
        } catch {
            call.resolve(ProviderBridgeDispatch.failure(
                callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false),
                kind: .lifecycle
            ))
        }
    }
}
