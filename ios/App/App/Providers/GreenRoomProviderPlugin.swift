import Foundation

#if canImport(Capacitor)
import Capacitor
#endif

let providerMaximumEnvelopeBytes = 256 * 1024
let providerMaximumMessageCount = 32
let providerMaximumMessageBytes = 64 * 1024
let providerMaximumResponseBytes = 64 * 1024
let providerMaximumTextBytes = 16 * 1024

struct ProviderMessage: Codable, Equatable, Sendable {
    let role: String
    let content: String
}

struct ProviderGeneratePayload: Codable, Equatable, Sendable {
    let roomId: String
    let sourceEventSequence: Int
    let personaSlug: String
    let messages: [ProviderMessage]
    let model: String
    let temperature: Double
    let maxOutputTokens: Int
    let profileId: String
}

struct ProviderGenerateEnvelope: Codable, Equatable, Sendable {
    let contractVersion: String
    let callId: String
    let method: String
    let payload: ProviderGeneratePayload
}

enum ProviderBridgeCodec {
    private static let payloadKeys = Set([
        "roomId", "sourceEventSequence", "personaSlug", "messages", "model",
        "temperature", "maxOutputTokens", "profileId",
    ])

    static func decodeGenerate(_ data: Data) throws -> ProviderGenerateEnvelope {
        guard data.count <= providerMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["contractVersion", "callId", "method", "payload"]),
              object["method"] as? String == "provider.generate",
              canonicalBridgeCallId(object["callId"]) != "invalid",
              let payloadObject = object["payload"] as? [String: Any],
              Set(payloadObject.keys) == payloadKeys,
              let messageObjects = payloadObject["messages"] as? [[String: Any]],
              messageObjects.allSatisfy({ Set($0.keys) == Set(["role", "content"]) }) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        guard object["contractVersion"] as? String == bridgeContractVersion else {
            throw DatabaseFailure(code: "incompatible_contract", retryable: false)
        }
        guard let envelope = try? JSONDecoder().decode(ProviderGenerateEnvelope.self, from: data) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        try validate(envelope.payload)
        return envelope
    }

    private static func validate(_ payload: ProviderGeneratePayload) throws {
        let profilePattern = try NSRegularExpression(pattern: "^[a-z][a-z0-9._-]{0,127}$")
        let slugPattern = try NSRegularExpression(pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$")
        let roomPattern = try NSRegularExpression(
            pattern: "^(?:room-local-default|room-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"
        )
        func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
            expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
        }
        func isForbiddenModelScalar(_ scalar: Unicode.Scalar) -> Bool {
            if CharacterSet.whitespacesAndNewlines.contains(scalar) {
                return true
            }
            switch scalar.properties.generalCategory {
            case .control, .format, .surrogate, .privateUse, .unassigned:
                return true
            default:
                return false
            }
        }
        let modelScalars = payload.model.unicodeScalars
        guard matches(roomPattern, payload.roomId),
              matches(profilePattern, payload.profileId),
              payload.personaSlug.unicodeScalars.count <= 128,
              matches(slugPattern, payload.personaSlug),
              (1...9_007_199_254_740_991).contains(payload.sourceEventSequence),
              payload.temperature.isFinite, (0...2).contains(payload.temperature),
              (1...32_768).contains(payload.maxOutputTokens),
              !payload.model.isEmpty,
              payload.model.utf8.elementsEqual(payload.model.precomposedStringWithCanonicalMapping.utf8),
              payload.model.utf8.count <= 256,
              !modelScalars.contains(where: isForbiddenModelScalar),
              (1...providerMaximumMessageCount).contains(payload.messages.count) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        var totalBytes = 0
        for message in payload.messages {
            guard ["system", "user", "assistant"].contains(message.role),
                  !message.content.isEmpty,
                  !message.content.unicodeScalars.contains("\0") else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            totalBytes += message.content.utf8.count
            guard totalBytes <= providerMaximumMessageBytes else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
        }
    }
}

private final class ProviderRequestDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var body = Data()
    private var response: HTTPURLResponse?
    private var redirected = false
    private var tooLarge = false
    private var completed = false
    private let completion: (Result<(HTTPURLResponse, Data), DatabaseFailure>) -> Void

    init(completion: @escaping (Result<(HTTPURLResponse, Data), DatabaseFailure>) -> Void) {
        self.completion = completion
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        lock.withLock { redirected = true }
        completionHandler(nil)
        finish(.failure(DatabaseFailure(code: "provider_rejected", retryable: false)), session: session)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            finish(.failure(DatabaseFailure(code: "invalid_response", retryable: false)), session: session)
            completionHandler(.cancel)
            return
        }
        let declared = http.value(forHTTPHeaderField: "Content-Length").flatMap(Int.init)
        if let declared, declared > providerMaximumResponseBytes {
            lock.withLock { tooLarge = true }
            completionHandler(.cancel)
            return
        }
        lock.withLock { self.response = http }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let exceeded = lock.withLock { () -> Bool in
            guard body.count + data.count <= providerMaximumResponseBytes else {
                tooLarge = true
                return true
            }
            body.append(data)
            return false
        }
        if exceeded { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let outcome: Result<(HTTPURLResponse, Data), DatabaseFailure> = lock.withLock {
            if tooLarge {
                return .failure(DatabaseFailure(code: "response_too_large", retryable: false))
            }
            if redirected {
                return .failure(DatabaseFailure(code: "provider_rejected", retryable: false))
            }
            if let urlError = error as? URLError {
                if urlError.code == .notConnectedToInternet {
                    return .failure(DatabaseFailure(code: "offline", retryable: true))
                }
                if urlError.code == .timedOut {
                    return .failure(DatabaseFailure(code: "timeout", retryable: true))
                }
            }
            if error != nil {
                return .failure(DatabaseFailure(code: "provider_unreachable", retryable: true))
            }
            guard let response else {
                return .failure(DatabaseFailure(code: "invalid_response", retryable: false))
            }
            return .success((response, body))
        }
        finish(outcome, session: session)
    }

    private func finish(
        _ result: Result<(HTTPURLResponse, Data), DatabaseFailure>,
        session: URLSession
    ) {
        let shouldFinish = lock.withLock { () -> Bool in
            guard !completed else { return false }
            completed = true
            return true
        }
        guard shouldFinish else { return }
        completion(result)
        session.finishTasksAndInvalidate()
    }
}

final class ProviderTransport: @unchecked Sendable {
    private let definition: ApprovedProviderDefinition
    private let configuration: URLSessionConfiguration
    private let authorizationValue: String

    init(
        definition: ApprovedProviderDefinition,
        configuration: URLSessionConfiguration = ProviderTransport.ephemeralConfiguration(),
        authorizationValue: String
    ) {
        self.definition = definition
        self.configuration = configuration
        self.authorizationValue = authorizationValue
    }

    static func ephemeralConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60
        return configuration
    }

    func generate(
        _ payload: ProviderGeneratePayload,
        completion: @escaping (Result<String, DatabaseFailure>) -> Void
    ) {
        do {
            let request = try makeRequest(payload)
            var delegate: ProviderRequestDelegate?
            delegate = ProviderRequestDelegate { [definition, model = payload.model] result in
                defer { delegate = nil }
                switch result {
                case .failure(let failure): completion(.failure(failure))
                case .success(let (response, data)):
                    completion(Self.parse(response: response, data: data, model: model, definition: definition))
                }
            }
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
            session.dataTask(with: request).resume()
        } catch let failure as DatabaseFailure {
            completion(.failure(failure))
        } catch {
            completion(.failure(DatabaseFailure(code: "internal_failure", retryable: false)))
        }
    }

    private func makeRequest(_ payload: ProviderGeneratePayload) throws -> URLRequest {
        guard let url = URL(string: "\(definition.scheme)://\(definition.hostname)\(definition.chatPath)"),
              url.scheme == definition.scheme, url.host == definition.hostname,
              url.port == nil, url.path == definition.chatPath,
              !authorizationValue.contains("\r"), !authorizationValue.contains("\n"), !authorizationValue.contains("\0") else {
            throw DatabaseFailure(code: "internal_failure", retryable: false)
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.httpBody = try requestBody(payload)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(authorizationValue, forHTTPHeaderField: definition.authorization.header)
        return request
    }

    func requestBody(_ payload: ProviderGeneratePayload) throws -> Data {
        let messages = payload.messages.map { ["role": $0.role, "content": $0.content] }
        var body: [String: Any] = [
            "model": payload.model,
            "messages": messages,
            "temperature": payload.temperature,
            definition.outputTokenField: payload.maxOutputTokens,
            "stream": false,
        ]
        if definition.id == .openrouter { body["provider"] = ["allow_fallbacks": false] }
        guard JSONSerialization.isValidJSONObject(body),
              let bodyData = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        return bodyData
    }

    private static func parse(
        response: HTTPURLResponse,
        data: Data,
        model: String,
        definition: ApprovedProviderDefinition
    ) -> Result<String, DatabaseFailure> {
        guard response.statusCode == 200 else {
            let retryable = response.statusCode == 408 || response.statusCode == 429 || response.statusCode >= 500
            return .failure(DatabaseFailure(code: "provider_rejected", retryable: retryable))
        }
        guard response.mimeType?.lowercased() == "application/json",
              data.count <= providerMaximumResponseBytes,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["model"] as? String == model,
              let choices = root["choices"] as? [[String: Any]],
              let choice = choices.first,
              choice["finish_reason"] == nil || choice["finish_reason"] as? String == "stop" || choice["finish_reason"] as? String == "length",
              let message = choice["message"] as? [String: Any],
              let content = message["content"] as? String else {
            return .failure(DatabaseFailure(code: "invalid_response", retryable: false))
        }
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= providerMaximumTextBytes else {
            return .failure(DatabaseFailure(
                code: content.utf8.count > providerMaximumTextBytes ? "response_too_large" : "invalid_response",
                retryable: false
            ))
        }
        return .success(text)
    }
}

final class GreenRoomProviderService: @unchecked Sendable {
    private let authority: GreenRoomNativeAuthority
    private let configuration: URLSessionConfiguration

    init(
        authority: GreenRoomNativeAuthority,
        configuration: URLSessionConfiguration = ProviderTransport.ephemeralConfiguration()
    ) {
        self.authority = authority
        self.configuration = configuration
    }

    func generate(
        _ payload: ProviderGeneratePayload,
        completion: @escaping (Result<String, DatabaseFailure>) -> Void
    ) {
        do {
            let plan = try authority.withReconciledDatabase(unavailableCode: "credential_unavailable") {
                try authority.database.providerRequestAuthority(
                    roomId: payload.roomId,
                    sourceEventSequence: payload.sourceEventSequence,
                    personaSlug: payload.personaSlug,
                    profileId: payload.profileId
                )
            }
            // TODO(release-hardening): Persist an immutable request plan and re-verify its digest, generation fence, and command claim before credential resolution and completion.
            var transport: ProviderTransport?
            try authority.credentials.performWithReadyCredential(plan.reservation.mutationRequest) { credential in
                guard let value = String(data: credential, encoding: .utf8),
                      !value.isEmpty,
                      value.unicodeScalars.allSatisfy({ (0x21...0x7e).contains($0.value) }) else {
                    throw DatabaseFailure(code: "credential_missing", retryable: true)
                }
                transport = ProviderTransport(
                    definition: plan.definition,
                    configuration: configuration,
                    authorizationValue: "\(plan.definition.authorization.scheme) \(value)"
                )
            }
            guard let transport else {
                throw DatabaseFailure(code: "credential_missing", retryable: true)
            }
            transport.generate(payload, completion: completion)
        } catch let failure as DatabaseFailure {
            completion(.failure(failure))
        } catch {
            completion(.failure(DatabaseFailure(code: "internal_failure", retryable: false)))
        }
    }
}

#if canImport(Capacitor)
@objc(GreenRoomProviderPlugin)
final class GreenRoomProviderPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GreenRoomProviderPlugin"
    let jsName = "GreenRoomProvider"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
    ]
    private let service = GreenRoomProviderService(authority: GreenRoomNativeAuthority.shared)
    private let inFlightCalls = GreenRoomNativeAuthority.shared.inFlightCalls

    @objc func generate(_ call: CAPPluginCall) {
        let options = call.options as? [String: Any] ?? [:]
        let callId = canonicalBridgeCallId(options["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "invalid_call", retryable: false))
            return
        }
        do {
            let data = try encodedBridgeJSONObject(
                options, code: "invalid_call", maximumBytes: providerMaximumEnvelopeBytes
            )
            let envelope = try ProviderBridgeCodec.decodeGenerate(data)
            service.generate(envelope.payload) { [weak self] result in
                guard let self else { return }
                defer { self.inFlightCalls.finish(callId) }
                switch result {
                case .success(let text): self.resolve(call, callId: callId, text: text)
                case .failure(let failure): self.reject(call, callId: callId, failure: failure)
                }
            }
        } catch let failure as DatabaseFailure {
            inFlightCalls.finish(callId)
            reject(call, callId: callId, failure: failure)
        } catch {
            inFlightCalls.finish(callId)
            reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false))
        }
    }

    private func resolve(_ call: CAPPluginCall, callId: String, text: String) {
        let response: [String: Any] = ["callId": callId, "ok": true, "value": ["text": text]]
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
