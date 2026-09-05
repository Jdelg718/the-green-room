import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private weak var statusLabel: UILabel?
    private var lockBackgroundTask: UIBackgroundTaskIdentifier = .invalid

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        let label = UILabel(frame: controller.view.bounds.insetBy(dx: 24, dy: 24))
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        label.numberOfLines = 0
        label.textAlignment = .center
        label.text = "Running repository-owned system SQLite capability probe…"
        controller.view.addSubview(label)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        self.statusLabel = label

        do {
            let evidence = try SQLiteCapabilityProbe.run()
            show(evidence.status)
        } catch {
            label.text = "SQLite capability probe failed"
            SQLiteCapabilityProbe.recordFailure(error)
        }
        return true
    }

    func applicationProtectedDataWillBecomeUnavailable(_ application: UIApplication) {
        if lockBackgroundTask == .invalid {
            lockBackgroundTask = application.beginBackgroundTask(withName: "SQLiteProtectedDataLock") { [weak self] in
                self?.endLockBackgroundTask(application)
            }
        }
        waitForProtectedDataLock(application, attempt: 0)
    }

    func applicationProtectedDataDidBecomeAvailable(_ application: UIApplication) {
        do { show(try SQLiteCapabilityProbe.protectedDataDidBecomeAvailable().status) }
        catch { fail(error) }
    }

    private func show(_ status: String) {
        switch status {
        case "awaiting_forced_termination": statusLabel?.text = "Base SQLite proof passed. Ready for forced termination."
        case "awaiting_lock": statusLabel?.text = "Forced relaunch passed. Lock this iPhone now and leave it locked for 10 seconds."
        case "awaiting_unlock": statusLabel?.text = "Locked protected-data denial passed. Unlock this iPhone."
        case "complete": statusLabel?.text = "Physical SQLite qualification complete."
        default: statusLabel?.text = "SQLite capability status: \(status)"
        }
    }

    private func fail(_ error: Error) {
        statusLabel?.text = "SQLite capability probe failed"
        SQLiteCapabilityProbe.recordFailure(error)
    }

    private func waitForProtectedDataLock(_ application: UIApplication, attempt: Int) {
        if !application.isProtectedDataAvailable {
            do { show(try SQLiteCapabilityProbe.protectedDataWillBecomeUnavailable().status) }
            catch { fail(error) }
            endLockBackgroundTask(application)
            return
        }
        guard attempt < 40 else {
            fail(ProbeFailure.assertion("protected data did not become unavailable within 10 seconds of lock callback"))
            endLockBackgroundTask(application)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.waitForProtectedDataLock(application, attempt: attempt + 1)
        }
    }

    private func endLockBackgroundTask(_ application: UIApplication) {
        guard lockBackgroundTask != .invalid else { return }
        application.endBackgroundTask(lockBackgroundTask)
        lockBackgroundTask = .invalid
    }
}
