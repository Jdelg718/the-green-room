import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

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

        do {
            let evidence = try SQLiteCapabilityProbe.run()
            label.text = evidence.status == "complete"
                ? "SQLite capability probe complete"
                : "SQLite probe ready for forced termination"
        } catch {
            label.text = "SQLite capability probe failed"
            SQLiteCapabilityProbe.recordFailure(error)
        }
        return true
    }
}
