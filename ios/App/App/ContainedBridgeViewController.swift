import Capacitor
import Foundation
import WebKit

/// Keeps every WebKit document inside Capacitor's signed, bundled origin.
/// Provider networking is isolated in a separate native bridge; the shell
/// itself has no external-navigation handoff or browser surface.
@MainActor
final class ContainedBridgeViewController: CAPBridgeViewController {
    private var containmentDelegate: LocalOnlyWebViewDelegate?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(GreenRoomDatabasePlugin())
        bridge?.registerPluginInstance(GreenRoomCredentialPlugin())
        bridge?.registerPluginInstance(GreenRoomProviderPlugin())
        bridge?.registerPluginInstance(GreenRoomLifecyclePlugin())
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
#if DEBUG && targetEnvironment(simulator)
    private var directorAcceptancePrepared = false
#endif

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
            let environment = ProcessInfo.processInfo.environment
#if DEBUG && targetEnvironment(simulator)
            if environment["GREENROOM_SIMULATOR_DIRECTOR_ACCEPTANCE"] == "true",
               !directorAcceptancePrepared {
                directorAcceptancePrepared = true
                let script = """
                const runtime = await import('./room-runtime.js');
                const plugin = globalThis.Capacitor?.Plugins?.GreenRoomDatabase;
                let opened = await runtime.openLocalRoom(plugin);
                const hasDirectedProof = opened.events.length === 3 &&
                  opened.events[0]?.event.type === 'human_message' &&
                  opened.events[0]?.event.text === 'Simulator director continuity proof' &&
                  opened.events[1]?.event.type === 'director_decision' &&
                  opened.events[1]?.event.reason === 'directed' &&
                  opened.events[1]?.event.speaker === 'isaac-newton' &&
                  opened.events[2]?.event.type === 'persona_message' &&
                  opened.events[2]?.event.personaSlug === 'isaac-newton';
                if (opened.room === null || !hasDirectedProof) {
                  opened = await runtime.createLocalRoom(plugin, ['ada-lovelace', 'isaac-newton']);
                }
                if (opened.events.length === 0) {
                  const room = opened.room;
                  const human = room.participants.find(({ kind }) => kind === 'human');
                  const state = JSON.stringify({
                    acceptedHumanEventNumber: 1,
                    autonomousTurns: 1,
                    cancelled: false,
                    fallbackIndex: 0,
                    lastSelectedAt: [['isaac-newton', 1]],
                    maxAutonomousTurns: 10,
                    seen: [[`iphone-room:${room.id}`, '40000000-0000-4000-8000-000000000177']],
                    version: 1
                  });
                  const humanEvent = JSON.stringify({ participantId: human.id, text: 'Simulator director continuity proof', type: 'human_message' });
                  const directorEvent = JSON.stringify({ generation: 0, reason: 'directed', sourceEventSequence: 1, speaker: 'isaac-newton', type: 'director_decision' });
                  const personaEvent = JSON.stringify({ generation: 0, personaSlug: 'isaac-newton', sourceEventSequence: 1, text: 'A stubbed reply crossed the signed room runtime.', type: 'persona_message' });
                  const callId = crypto.randomUUID().toLowerCase();
                  const response = await plugin.executeBatch({
                    contractVersion: 'iphone-native-bridge/1.0',
                    callId,
                    method: 'database.executeBatch',
                    payload: {
                      transactionId: `simulator-director-${room.id}`,
                      statements: [
                        { sqlId: 'update_director_state', parameters: [state, 1, 'isaac-newton', 'isaac-newton', 1, 0, room.id, 0, 1] },
                        { sqlId: 'append_event', parameters: [humanEvent, room.id] },
                        { sqlId: 'append_event', parameters: [directorEvent, room.id] },
                        { sqlId: 'append_persona_event', parameters: [personaEvent, room.id, 0, 3, 2, 1, 'isaac-newton'] }
                      ]
                    }
                  });
                  if (response?.ok !== true || response.callId !== callId) throw new Error('Simulator director transaction failed');
                }
                return true;
                """
                do {
                    _ = try await webView.callAsyncJavaScript(
                        script,
                        arguments: [:],
                        in: nil,
                        contentWorld: .page
                    )
                    webView.reload()
                } catch {
                    return
                }
                return
            }
#endif
            for _ in 0..<50 {
                let marker = try? await webView.evaluateJavaScript(
                    "JSON.stringify({boot:document.documentElement.dataset.localRoomBoot||'',source:document.documentElement.dataset.localRoomSource||'',castCount:document.documentElement.dataset.localRoomCastCount||'0',eventCount:document.documentElement.dataset.localRoomEventCount||'0'})"
                )
                if let marker = marker as? String,
                   let data = marker.data(using: .utf8),
                   let state = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                   let boot = state["boot"],
                   boot == "open" || boot == "picker",
                   let source = state["source"],
                   let castText = state["castCount"],
                   let castCount = Int(castText),
                   let eventText = state["eventCount"],
                   let eventCount = Int(eventText),
                   (boot == "open" && (source == "created" || source == "reopened") && (1...3).contains(castCount)) ||
                     (boot == "picker" && source == "empty" && castCount == 0) {
                    let networkAudit = environment["GREENROOM_NETWORK_AUDIT_LOADED"] == "true" && environment["GREENROOM_NETWORK_ATTEMPT"] == nil
#if DEBUG
                    let deviceAcceptance = environment["GREENROOM_DEVICE_ACCEPTANCE"] == "true"
#else
                    let deviceAcceptance = false
#endif
#if DEBUG && targetEnvironment(simulator)
                    let directorAcceptance = environment["GREENROOM_SIMULATOR_DIRECTOR_ACCEPTANCE"] == "true"
#else
                    let directorAcceptance = false
#endif
                    guard networkAudit || deviceAcceptance || directorAcceptance else { return }
                    let evidence: [String: Any] = [
                        "networkPolicy": networkAudit ? "denied" : "not-measured",
                        "origin": "capacitor://localhost",
                        "roomSource": source,
                        "castCount": castCount,
                        "eventCount": eventCount,
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
