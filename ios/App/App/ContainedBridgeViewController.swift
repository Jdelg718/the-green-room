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
        bridge?.registerPluginInstance(GreenRoomDatabasePlugin())
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
                  webView.url?.host == localOrigin?.host else {
                return
            }
            for _ in 0..<50 {
                let marker = try? await webView.evaluateJavaScript(
                    "JSON.stringify({boot:document.documentElement.dataset.localRoomBoot||'',source:document.documentElement.dataset.localRoomSource||'',castCount:document.documentElement.dataset.localRoomCastCount||'0'})"
                )
                if let marker = marker as? String,
                   let data = marker.data(using: .utf8),
                   let state = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                   let boot = state["boot"],
                   boot == "open" || boot == "picker",
                   let source = state["source"],
                   let castText = state["castCount"],
                   let castCount = Int(castText),
                   (boot == "open" && (source == "created" || source == "reopened") && (1...3).contains(castCount)) ||
                     (boot == "picker" && source == "empty" && castCount == 0) {
                    let environment = ProcessInfo.processInfo.environment
                    let networkAudit = environment["GREENROOM_NETWORK_AUDIT_LOADED"] == "true" && environment["GREENROOM_NETWORK_ATTEMPT"] == nil
                    let deviceAcceptance = environment["GREENROOM_DEVICE_ACCEPTANCE"] == "true"
                    guard networkAudit || deviceAcceptance else { return }
                    let evidence: [String: Any] = [
                        "networkPolicy": networkAudit ? "denied" : "not-measured",
                        "origin": "capacitor://localhost",
                        "roomSource": source,
                        "castCount": castCount,
                        "status": boot == "open" ? "room-open" : "picker-ready"
                    ]
                    if let encoded = try? JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]) {
                        try? encoded.write(
                            to: FileManager.default.temporaryDirectory.appendingPathComponent("local-room-evidence.json"),
                            options: .atomic
                        )
                    }
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
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
