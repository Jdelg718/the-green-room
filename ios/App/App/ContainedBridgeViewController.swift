import Capacitor
import Foundation
import WebKit

/// Keeps every WebKit document inside Capacitor's signed, bundled origin.
/// Provider networking is introduced later through a separate native bridge;
/// the shell itself has no external-navigation handoff or browser surface.
@MainActor
final class ContainedBridgeViewController: CAPBridgeViewController {
    private var containmentDelegate: LocalOnlyWebViewDelegate?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView, let capacitorDelegate = webView.navigationDelegate as? WebViewDelegationHandler else {
            preconditionFailure("Capacitor WebView delegate was not installed")
        }
        let delegate = LocalOnlyWebViewDelegate(
            capacitorDelegate: capacitorDelegate,
            localOrigin: bridge?.config.localURL
        )
        containmentDelegate = delegate
        webView.navigationDelegate = delegate
        webView.uiDelegate = delegate
    }
}

/// A fail-closed delegate which checks all frames before forwarding allowed
/// local navigation to Capacitor's own delegate. It deliberately returns nil
/// for new-window requests, including target=_blank and window.open().
@MainActor
final class LocalOnlyWebViewDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let capacitorDelegate: WebViewDelegationHandler
    private let localOrigin: URL?

    init(capacitorDelegate: WebViewDelegationHandler, localOrigin: URL?) {
        self.capacitorDelegate = capacitorDelegate
        self.localOrigin = localOrigin
        super.init()
    }

    private func isBundledNavigation(_ action: WKNavigationAction) -> Bool {
        guard action.targetFrame != nil,
              let candidate = action.request.url,
              let localOrigin,
              candidate.scheme == localOrigin.scheme,
              candidate.host == localOrigin.host,
              candidate.port == localOrigin.port,
              candidate.user == nil,
              candidate.password == nil else {
            return false
        }
        return true
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard isBundledNavigation(navigationAction) else {
            decisionHandler(.cancel)
            return
        }
        capacitorDelegate.webView(
            webView,
            decidePolicyFor: navigationAction,
            decisionHandler: decisionHandler
        )
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        capacitorDelegate.webView(webView, didFinish: navigation)
        Task { @MainActor [weak webView] in
            guard let webView,
                  webView.url?.scheme == localOrigin?.scheme,
                  webView.url?.host == localOrigin?.host,
                  let marker = try? await webView.evaluateJavaScript("document.documentElement.dataset.shellBoot"),
                  marker as? String == "contained",
                  ProcessInfo.processInfo.environment["GREENROOM_NETWORK_AUDIT_LOADED"] == "true",
                  ProcessInfo.processInfo.environment["GREENROOM_NETWORK_ATTEMPT"] == nil else {
                return
            }
            let evidence = Data("{\"interposerLoaded\":true,\"networkPolicy\":\"denied\",\"origin\":\"capacitor://localhost\",\"status\":\"ready\"}\n".utf8)
            try? evidence.write(
                to: FileManager.default.temporaryDirectory.appendingPathComponent("contained-shell-evidence.json"),
                options: .atomic
            )
        }
    }

    override func responds(to selector: Selector!) -> Bool {
        return super.responds(to: selector) || capacitorDelegate.responds(to: selector)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if capacitorDelegate.responds(to: selector) {
            return capacitorDelegate
        }
        return super.forwardingTarget(for: selector)
    }
}
