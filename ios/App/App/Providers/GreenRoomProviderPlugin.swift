import Foundation

#if canImport(Capacitor)
import Capacitor
#endif

let providerMaximumEnvelopeBytes = 256 * 1024
let providerMaximumMessageCount = 32
let providerMaximumMessageBytes = 64 * 1024
let providerMaximumResponseBytes = 64 * 1024
let providerMaximumModelListResponseBytes = 2 * 1024 * 1024
let providerMaximumModelCount = 1_024
let providerMaximumTextBytes = 16 * 1024
let providerMaximumConcurrentRequests = 4
let providerMaximumQueuedRequests = 16
let providerTotalDeadline: TimeInterval = 60

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
    let profileRevision: Int
    let providerId: String
    let requestId: String
    let kind: String
}

struct ProviderCommandPayload: Codable, Equatable, Sendable {
    let requestId: String
    let commandId: String
    let requestDigest: String
}

struct ProviderAttemptResult: Equatable, Sendable {
    let text: String
    let attemptEpoch: Int
}

struct ProviderGenerateEnvelope: Codable, Equatable, Sendable {
    let contractVersion: String
    let callId: String
    let method: String
    let payload: ProviderCommandPayload
}

struct ProviderCancelPayload: Codable, Equatable, Sendable {
    let requestId: String
}

struct ProviderCancelEnvelope: Codable, Equatable, Sendable {
    let contractVersion: String
    let callId: String
    let method: String
    let payload: ProviderCancelPayload
}

struct ProviderListModelsPayload: Codable, Equatable, Sendable {
    let profileId: String
    let profileRevision: Int
    let providerId: String
    let credentialRef: String
}

struct ProviderListModelsEnvelope: Codable, Equatable, Sendable {
    let contractVersion: String
    let callId: String
    let method: String
    let payload: ProviderListModelsPayload
}

struct ProviderLifecycleEnvelope: Codable, Equatable, Sendable {
    let contractVersion: String
    let callId: String
    let method: String
    let payload: [String: String]
}

enum ProviderResponseKind { case generate, cancel, listModels, lifecycle }

enum ProviderBridgeCodec {
    private static let payloadKeys = Set(["requestId", "commandId", "requestDigest"])
    private static let providerFailureCodes = Set([
        "invalid_call", "incompatible_contract", "credential_unavailable", "credential_missing", "offline",
        "provider_unreachable", "provider_rejected", "invalid_response", "response_too_large", "timeout",
        "capacity_rejected", "canceled", "internal_failure",
    ])

    static func sanitizeFailure(_ failure: DatabaseFailure, kind: ProviderResponseKind) -> DatabaseFailure {
        let allowed = kind == .lifecycle
            ? Set(["invalid_call", "incompatible_contract", "internal_failure"])
            : providerFailureCodes
        guard allowed.contains(failure.code) else {
            return DatabaseFailure(code: "internal_failure", retryable: false)
        }
        return failure
    }

    static func decodeResponse(_ data: Data, callId: String, kind: ProviderResponseKind) throws -> [String: Any] {
        guard data.count <= providerMaximumEnvelopeBytes,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["callId"] as? String == callId, let ok = value["ok"] as? Bool else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        if !ok {
            let allowed = kind == .lifecycle ? Set(["invalid_call", "incompatible_contract", "internal_failure"]) : providerFailureCodes
            guard Set(value.keys) == Set(["callId", "ok", "error"]),
                  let error = value["error"] as? [String: Any], Set(error.keys) == Set(["code", "retryable"]),
                  let code = error["code"] as? String, allowed.contains(code), error["retryable"] is Bool else {
                throw DatabaseFailure(code: "invalid_call", retryable: false)
            }
            return value
        }
        guard Set(value.keys) == Set(["callId", "ok", "value"]),
              let result = value["value"] as? [String: Any] else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        let valid: Bool
        switch kind {
        case .generate:
            valid = Set(result.keys) == Set(["text", "attemptEpoch"]) && (result["text"] as? String).map {
                !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= providerMaximumTextBytes
            } == true && (result["attemptEpoch"] as? Int).map { (1...9_007_199_254_740_991).contains($0) } == true
        case .cancel:
            valid = Set(result.keys) == Set(["canceled"]) && result["canceled"] is Bool
        case .listModels:
            if Set(result.keys) == Set(["modelIds"]), let ids = result["modelIds"] as? [String] {
                valid = (1...providerMaximumModelCount).contains(ids.count) && Set(ids).count == ids.count && ids.allSatisfy(validModelId)
            } else { valid = false }
        case .lifecycle:
            valid = Set(result.keys) == Set(["active", "protectedDataAvailable", "pathAvailable", "databaseReady", "epoch"]) &&
                result["active"] is Bool && result["protectedDataAvailable"] is Bool && result["pathAvailable"] is Bool &&
                result["databaseReady"] is Bool && (result["epoch"] as? Int).map { $0 >= 0 } == true
        }
        guard valid else { throw DatabaseFailure(code: "invalid_call", retryable: false) }
        return value
    }

    static func validModelId(_ value: String) -> Bool {
        let scalars = value.unicodeScalars
        return !value.isEmpty && value.utf8.elementsEqual(value.precomposedStringWithCanonicalMapping.utf8) &&
            value.utf8.count <= 256 && !scalars.contains { scalar in
                if CharacterSet.whitespacesAndNewlines.contains(scalar) { return true }
                switch scalar.properties.generalCategory {
                case .control, .format, .surrogate, .privateUse, .unassigned: return true
                default: return false
                }
            }
    }

    static func decodeGenerate(_ data: Data) throws -> ProviderGenerateEnvelope {
        guard data.count <= providerMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["contractVersion", "callId", "method", "payload"]),
              object["method"] as? String == "provider.generate",
              canonicalBridgeCallId(object["callId"]) != "invalid",
              let payloadObject = object["payload"] as? [String: Any],
              Set(payloadObject.keys) == payloadKeys else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        guard object["contractVersion"] as? String == bridgeContractVersion else {
            throw DatabaseFailure(code: "incompatible_contract", retryable: false)
        }
        guard let envelope = try? JSONDecoder().decode(ProviderGenerateEnvelope.self, from: data) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        guard canonicalBridgeCallId(envelope.payload.requestId) != "invalid",
              canonicalBridgeCallId(envelope.payload.commandId) != "invalid",
              envelope.payload.requestDigest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        return envelope
    }

    static func decodeCancel(_ data: Data) throws -> ProviderCancelEnvelope {
        guard data.count <= providerMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["contractVersion", "callId", "method", "payload"]),
              object["method"] as? String == "provider.cancel",
              canonicalBridgeCallId(object["callId"]) != "invalid",
              let payload = object["payload"] as? [String: Any],
              Set(payload.keys) == Set(["requestId"]),
              let envelope = try? JSONDecoder().decode(ProviderCancelEnvelope.self, from: data),
              canonicalBridgeCallId(envelope.payload.requestId) != "invalid" else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        guard object["contractVersion"] as? String == bridgeContractVersion else {
            throw DatabaseFailure(code: "incompatible_contract", retryable: false)
        }
        return envelope
    }

    static func decodeListModels(_ data: Data) throws -> ProviderListModelsEnvelope {
        guard data.count <= providerMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["contractVersion", "callId", "method", "payload"]),
              object["method"] as? String == "provider.listModels",
              canonicalBridgeCallId(object["callId"]) != "invalid",
              let payload = object["payload"] as? [String: Any],
              Set(payload.keys) == Set(["profileId", "profileRevision", "providerId", "credentialRef"]),
              let envelope = try? JSONDecoder().decode(ProviderListModelsEnvelope.self, from: data) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        guard object["contractVersion"] as? String == bridgeContractVersion else {
            throw DatabaseFailure(code: "incompatible_contract", retryable: false)
        }
        let value = envelope.payload
        let syntheticMutation = "00000000-0000-4000-8000-000000000000"
        _ = try validateCredentialIdentity(CredentialMutationRequest(
            profileId: value.profileId, profileRevision: value.profileRevision,
            providerId: value.providerId, credentialRef: value.credentialRef,
            mutationId: syntheticMutation
        ))
        return envelope
    }

    static func decodeLifecycleStatus(_ data: Data) throws -> ProviderLifecycleEnvelope {
        guard data.count <= providerMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["contractVersion", "callId", "method", "payload"]),
              object["method"] as? String == "lifecycle.status",
              canonicalBridgeCallId(object["callId"]) != "invalid",
              let payload = object["payload"] as? [String: Any], payload.isEmpty,
              let envelope = try? JSONDecoder().decode(ProviderLifecycleEnvelope.self, from: data) else {
            throw DatabaseFailure(code: "invalid_call", retryable: false)
        }
        guard object["contractVersion"] as? String == bridgeContractVersion else {
            throw DatabaseFailure(code: "incompatible_contract", retryable: false)
        }
        return envelope
    }

    static func decodeRequestPlan(_ json: String) throws -> ProviderGeneratePayload {
        guard let data = json.data(using: .utf8), data.count <= providerMaximumEnvelopeBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set([
                "kind", "requestId", "roomId", "sourceEventSequence", "personaSlug", "messages",
                "model", "temperature", "maxOutputTokens", "profileId", "profileRevision", "providerId",
              ]),
              object["kind"] as? String == "provider",
              let messageObjects = object["messages"] as? [[String: Any]],
              messageObjects.allSatisfy({ Set($0.keys) == Set(["role", "content"]) }),
              let plan = try? JSONDecoder().decode(ProviderGeneratePayload.self, from: data) else {
            throw DatabaseFailure(code: "canceled", retryable: false)
        }
        try validate(plan)
        return plan
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
              payload.kind == "provider",
              canonicalBridgeCallId(payload.requestId) != "invalid",
              matches(profilePattern, payload.profileId),
              (1...2_147_483_647).contains(payload.profileRevision),
              ApprovedProviderID(rawValue: payload.providerId) != nil,
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
    private let maximumResponseBytes: Int
    private let completion: (Result<(HTTPURLResponse, Data), DatabaseFailure>) -> Void

    init(
        maximumResponseBytes: Int = providerMaximumResponseBytes,
        completion: @escaping (Result<(HTTPURLResponse, Data), DatabaseFailure>) -> Void
    ) {
        self.maximumResponseBytes = maximumResponseBytes
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
        if let declared, declared > maximumResponseBytes {
            lock.withLock { tooLarge = true }
            completionHandler(.cancel)
            return
        }
        lock.withLock { self.response = http }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let exceeded = lock.withLock { () -> Bool in
            guard body.count + data.count <= maximumResponseBytes else {
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

    func makeTask(
        _ payload: ProviderGeneratePayload,
        timeoutInterval: TimeInterval = providerTotalDeadline,
        completion: @escaping (Result<String, DatabaseFailure>) -> Void
    ) throws -> URLSessionDataTask {
        let request = try makeRequest(payload, timeoutInterval: timeoutInterval)
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
        return session.dataTask(with: request)
    }

    @discardableResult func generate(
        _ payload: ProviderGeneratePayload,
        completion: @escaping (Result<String, DatabaseFailure>) -> Void
    ) -> URLSessionDataTask? {
        do {
            let task = try makeTask(payload, completion: completion)
            task.resume()
            return task
        } catch let failure as DatabaseFailure {
            completion(.failure(failure))
        } catch {
            completion(.failure(DatabaseFailure(code: "internal_failure", retryable: false)))
        }
        return nil
    }

    func makeListModelsTask(
        timeoutInterval: TimeInterval,
        completion: @escaping (Result<[String], DatabaseFailure>) -> Void
    ) throws -> URLSessionDataTask {
        guard timeoutInterval > 0,
              let url = URL(string: "\(definition.scheme)://\(definition.hostname)\(definition.modelsPath)"),
              url.scheme == definition.scheme, url.host == definition.hostname,
              url.port == nil, url.path == definition.modelsPath,
              !authorizationValue.contains("\r"), !authorizationValue.contains("\n"), !authorizationValue.contains("\0") else {
            throw DatabaseFailure(code: timeoutInterval > 0 ? "internal_failure" : "timeout", retryable: timeoutInterval <= 0)
        }
        var request = URLRequest(
            url: url, cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: min(providerTotalDeadline, timeoutInterval)
        )
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(authorizationValue, forHTTPHeaderField: definition.authorization.header)
        var delegate: ProviderRequestDelegate?
        delegate = ProviderRequestDelegate(maximumResponseBytes: providerMaximumModelListResponseBytes) { [definition] result in
            defer { delegate = nil }
            switch result {
            case .failure(let failure): completion(.failure(failure))
            case .success(let (response, data)):
                completion(Self.parseModels(response: response, data: data, definition: definition))
            }
        }
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        return session.dataTask(with: request)
    }

    private static func parseModels(
        response: HTTPURLResponse, data: Data, definition: ApprovedProviderDefinition
    ) -> Result<[String], DatabaseFailure> {
        guard response.statusCode == 200 else {
            let retryable = response.statusCode == 408 || response.statusCode == 429 || response.statusCode >= 500
            return .failure(DatabaseFailure(code: "provider_rejected", retryable: retryable))
        }
        guard response.mimeType?.lowercased() == "application/json", data.count <= providerMaximumModelListResponseBytes,
              let decoded = try? JSONSerialization.jsonObject(with: data) else {
            return .failure(DatabaseFailure(code: "invalid_response", retryable: false))
        }
        let raw: Any
        if definition.modelParser == "data-id", let root = decoded as? [String: Any], root["data"] != nil {
            raw = root["data"] as Any
        } else if definition.modelParser == "array-id" {
            raw = decoded
        } else {
            return .failure(DatabaseFailure(code: "invalid_response", retryable: false))
        }
        guard let entries = raw as? [[String: Any]], (1...providerMaximumModelCount).contains(entries.count) else {
            return .failure(DatabaseFailure(code: "invalid_response", retryable: false))
        }
        var ids: [String] = []
        var seen = Set<String>()
        for entry in entries {
            guard Set(entry.keys).contains("id"), let id = entry["id"] as? String,
                  ProviderBridgeCodec.validModelId(id), seen.insert(id).inserted else {
                return .failure(DatabaseFailure(code: "invalid_response", retryable: false))
            }
            ids.append(id)
        }
        return .success(ids)
    }

    private func makeRequest(_ payload: ProviderGeneratePayload, timeoutInterval: TimeInterval) throws -> URLRequest {
        guard let url = URL(string: "\(definition.scheme)://\(definition.hostname)\(definition.chatPath)"),
              url.scheme == definition.scheme, url.host == definition.hostname,
              url.port == nil, url.path == definition.chatPath,
              !authorizationValue.contains("\r"), !authorizationValue.contains("\n"), !authorizationValue.contains("\0") else {
            throw DatabaseFailure(code: "internal_failure", retryable: false)
        }
        guard timeoutInterval > 0 else { throw DatabaseFailure(code: "timeout", retryable: true) }
        var request = URLRequest(
            url: url, cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: min(providerTotalDeadline, timeoutInterval)
        )
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
    private let registry: ProviderTaskRegistry
    private let afterCredentialResolution: @Sendable () throws -> Void

    init(
        authority: GreenRoomNativeAuthority,
        configuration: URLSessionConfiguration = ProviderTransport.ephemeralConfiguration(),
        registry: ProviderTaskRegistry = .shared,
        afterCredentialResolution: @escaping @Sendable () throws -> Void = {}
    ) {
        self.authority = authority
        self.configuration = configuration
        self.registry = registry
        self.afterCredentialResolution = afterCredentialResolution
    }

    func generate(
        _ command: ProviderCommandPayload,
        completion: @escaping (Result<ProviderAttemptResult, DatabaseFailure>) -> Void
    ) {
        let completionGate = ProviderResultCompletion(completion)
        var commandAuthority: ProviderCommandAuthority?
        do {
            guard let lifecycleEpoch = registry.lifecycleSnapshot() else {
                throw DatabaseFailure(code: "canceled", retryable: true)
            }
            let loaded = try authority.withReconciledDatabase(unavailableCode: "credential_unavailable") {
                try authority.database.providerCommandAuthority(
                    commandId: command.commandId, requestId: command.requestId,
                    requestDigest: command.requestDigest
                )
            }
            commandAuthority = loaded
            let payload = try ProviderBridgeCodec.decodeRequestPlan(loaded.requestPlanJSON)
            guard payload.requestId == command.requestId,
                  payload.profileId == loaded.reservation.profileId,
                  payload.profileRevision == loaded.reservation.profileRevision,
                  payload.providerId == loaded.reservation.providerId else {
                throw DatabaseFailure(code: "canceled", retryable: false)
            }
            let attemptEpoch = loaded.attemptEpoch + 1
            let cancellation: (Bool, DatabaseFailure) -> Void = { [authority] started, failure in
                try? authority.withReconciledDatabase {
                    if started {
                        try authority.database.interruptGenerationCommand(
                            requestId: command.requestId, attemptEpoch: attemptEpoch,
                            failureCode: failure.code
                        )
                    } else {
                        try authority.database.failGenerationCommandNotStarted(
                            commandId: command.commandId, requestId: command.requestId,
                            requestDigest: command.requestDigest,
                            priorAttemptEpoch: loaded.attemptEpoch
                        )
                    }
                }
                completionGate.finish(.failure(failure))
            }
            let admission = registry.install(
                requestId: command.requestId, attemptEpoch: attemptEpoch,
                lifecycleEpoch: lifecycleEpoch,
                start: { [authority, configuration, registry, afterCredentialResolution] remaining in
                    do {
                        try afterCredentialResolution()
                        var taskToCancel: (any ProviderRetainedTask)?
                        let started = try registry.beginNetwork(
                            requestId: command.requestId, attemptEpoch: attemptEpoch,
                            lifecycleEpoch: lifecycleEpoch
                        ) { resume in
                            try authority.withReconciledDatabase {
                                try authority.credentials.performWithReadyCredential(loaded.reservation.mutationRequest) { credential in
                                    guard let value = String(data: credential, encoding: .utf8), !value.isEmpty,
                                          value.unicodeScalars.allSatisfy({ (0x21...0x7e).contains($0.value) }) else {
                                        throw DatabaseFailure(code: "credential_missing", retryable: true)
                                    }
                                    do {
                                        _ = try authority.database.executeBatch(
                                            transactionId: "native-begin-\(command.commandId)-\(attemptEpoch)-\(UUID().uuidString.lowercased())",
                                            statements: [["sqlId": "begin_generation_command", "parameters": [
                                                command.commandId, command.requestId, command.requestDigest,
                                                loaded.requestPlanJSON, loaded.attemptEpoch,
                                                loaded.reservation.credentialRef, loaded.reservation.mutationId,
                                            ]]]
                                        )
                                    } catch let failure as DatabaseFailure where failure.code == "transaction_rejected" {
                                        throw DatabaseFailure(code: "canceled", retryable: false)
                                    }
                                    let transport = ProviderTransport(
                                        definition: loaded.definition, configuration: configuration,
                                        authorizationValue: "\(loaded.definition.authorization.scheme) \(value)"
                                    )
                                    let task = try transport.makeTask(payload, timeoutInterval: remaining) { [authority, registry] result in
                                        guard registry.claimCompletion(
                                            requestId: command.requestId, attemptEpoch: attemptEpoch,
                                            lifecycleEpoch: lifecycleEpoch
                                        ) else {
                                            completionGate.finish(.failure(DatabaseFailure(code: "canceled", retryable: true)))
                                            return
                                        }
                                        switch result {
                                        case .failure(let failure):
                                            try? authority.withReconciledDatabase {
                                                _ = try authority.database.executeBatch(
                                                    transactionId: "native-interrupt-\(command.commandId)-\(attemptEpoch)",
                                                    statements: [["sqlId": "interrupt_generation_command", "parameters": [
                                                        failure.code, command.commandId, command.requestId,
                                                        command.requestDigest, attemptEpoch,
                                                    ]]]
                                                )
                                            }
                                            completionGate.finish(.failure(failure))
                                        case .success(let text):
                                            let valid = (try? authority.withReconciledDatabase {
                                                try authority.database.generationCommandIsInFlight(
                                                    commandId: command.commandId, requestId: command.requestId,
                                                    requestDigest: command.requestDigest, attemptEpoch: attemptEpoch
                                                )
                                            }) == true
                                            completionGate.finish(valid
                                                ? .success(ProviderAttemptResult(text: text, attemptEpoch: attemptEpoch))
                                                : .failure(DatabaseFailure(code: "canceled", retryable: true)))
                                        }
                                    }
                                    taskToCancel = task
                                    if !resume(task) {
                                        try authority.database.failGenerationCommandNotStarted(
                                            commandId: command.commandId, requestId: command.requestId,
                                            requestDigest: command.requestDigest,
                                            priorAttemptEpoch: loaded.attemptEpoch
                                        )
                                    }
                                }
                            }
                        }
                        if !started { taskToCancel?.cancel() }
                    } catch let failure as DatabaseFailure {
                        registry.failBeforeStart(requestId: command.requestId, failure: failure)
                    } catch {
                        registry.failBeforeStart(
                            requestId: command.requestId,
                            failure: DatabaseFailure(code: "internal_failure", retryable: false)
                        )
                    }
                },
                cancellation: cancellation
            )
            switch admission {
            case .capacityRejected:
                throw DatabaseFailure(code: "capacity_rejected", retryable: true)
            case .lifecycleUnavailable:
                throw DatabaseFailure(code: "canceled", retryable: true)
            case .duplicate:
                completionGate.finish(.failure(DatabaseFailure(code: "canceled", retryable: true)))
                return
            case .active, .queued:
                break
            }
        } catch let failure as DatabaseFailure {
            if let loaded = commandAuthority {
                try? authority.withReconciledDatabase {
                    _ = try authority.database.executeBatch(
                        transactionId: "native-not-started-\(command.commandId)-initial",
                        statements: [["sqlId": "fail_generation_command", "parameters": [
                            "not_started", command.commandId, command.requestId,
                            command.requestDigest, loaded.attemptEpoch,
                        ]]]
                    )
                }
            }
            completionGate.finish(.failure(failure))
        } catch {
            completionGate.finish(.failure(DatabaseFailure(code: "internal_failure", retryable: false)))
        }
    }

    func listModels(
        _ payload: ProviderListModelsPayload,
        operationId: String,
        completion: @escaping (Result<[String], DatabaseFailure>) -> Void
    ) {
        let completionGate = ProviderListCompletion(completion)
        do {
            guard let lifecycleEpoch = registry.lifecycleSnapshot(),
                  let providerId = ApprovedProviderID(rawValue: payload.providerId) else {
                throw DatabaseFailure(code: "canceled", retryable: true)
            }
            let reservation = try authority.withReconciledDatabase(unavailableCode: "credential_unavailable") {
                try authority.database.providerListModelsAuthority(
                    profileId: payload.profileId, profileRevision: payload.profileRevision,
                    providerId: payload.providerId, credentialRef: payload.credentialRef
                )
            }
            let definition = ApprovedProviderDefinitions.definition(for: providerId)
            let admission = registry.install(
                requestId: operationId, attemptEpoch: 1, lifecycleEpoch: lifecycleEpoch,
                start: { [authority, configuration, registry, afterCredentialResolution] remaining in
                    do {
                        try afterCredentialResolution()
                        var taskToCancel: (any ProviderRetainedTask)?
                        let started = try registry.beginNetwork(
                            requestId: operationId, attemptEpoch: 1,
                            lifecycleEpoch: lifecycleEpoch
                        ) { resume in
                            try authority.withReconciledDatabase(unavailableCode: "credential_unavailable") {
                                let current = try authority.database.providerListModelsAuthority(
                                    profileId: payload.profileId, profileRevision: payload.profileRevision,
                                    providerId: payload.providerId, credentialRef: payload.credentialRef
                                )
                                guard current.mutationId == reservation.mutationId else {
                                    throw DatabaseFailure(code: "credential_missing", retryable: true)
                                }
                                try authority.credentials.performWithReadyCredential(current.mutationRequest) { credential in
                                    guard let value = String(data: credential, encoding: .utf8), !value.isEmpty,
                                          value.unicodeScalars.allSatisfy({ (0x21...0x7e).contains($0.value) }) else {
                                        throw DatabaseFailure(code: "credential_missing", retryable: true)
                                    }
                                    let transport = ProviderTransport(
                                        definition: definition, configuration: configuration,
                                        authorizationValue: "\(definition.authorization.scheme) \(value)"
                                    )
                                    let task = try transport.makeListModelsTask(timeoutInterval: remaining) { [registry] result in
                                        guard registry.claimCompletion(
                                            requestId: operationId, attemptEpoch: 1, lifecycleEpoch: lifecycleEpoch
                                        ) else { return }
                                        completionGate.finish(result)
                                    }
                                    taskToCancel = task
                                    _ = resume(task)
                                }
                            }
                        }
                        if !started { taskToCancel?.cancel() }
                    } catch let failure as DatabaseFailure {
                        registry.failBeforeStart(requestId: operationId, failure: failure)
                    } catch {
                        registry.failBeforeStart(
                            requestId: operationId,
                            failure: DatabaseFailure(code: "internal_failure", retryable: false)
                        )
                    }
                },
                cancellation: { _, failure in completionGate.finish(.failure(failure)) }
            )
            if admission == .capacityRejected { throw DatabaseFailure(code: "capacity_rejected", retryable: true) }
            if admission == .lifecycleUnavailable || admission == .duplicate {
                throw DatabaseFailure(code: "canceled", retryable: true)
            }
        } catch let failure as DatabaseFailure {
            completionGate.finish(.failure(failure))
        } catch {
            completionGate.finish(.failure(DatabaseFailure(code: "internal_failure", retryable: false)))
        }
    }
}

private final class ProviderResultCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private let completion: (Result<ProviderAttemptResult, DatabaseFailure>) -> Void

    init(_ completion: @escaping (Result<ProviderAttemptResult, DatabaseFailure>) -> Void) {
        self.completion = completion
    }

    func finish(_ result: Result<ProviderAttemptResult, DatabaseFailure>) {
        let sanitized: Result<ProviderAttemptResult, DatabaseFailure> = switch result {
        case .success: result
        case .failure(let failure): .failure(ProviderBridgeCodec.sanitizeFailure(failure, kind: .generate))
        }
        let shouldFinish = lock.withLock { () -> Bool in
            guard !completed else { return false }
            completed = true
            return true
        }
        if shouldFinish { completion(sanitized) }
    }
}

private final class ProviderListCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private let completion: (Result<[String], DatabaseFailure>) -> Void

    init(_ completion: @escaping (Result<[String], DatabaseFailure>) -> Void) { self.completion = completion }

    func finish(_ result: Result<[String], DatabaseFailure>) {
        let sanitized: Result<[String], DatabaseFailure> = switch result {
        case .success: result
        case .failure(let failure): .failure(ProviderBridgeCodec.sanitizeFailure(failure, kind: .listModels))
        }
        let shouldFinish = lock.withLock { () -> Bool in
            guard !completed else { return false }
            completed = true
            return true
        }
        if shouldFinish { completion(sanitized) }
    }
}

protocol ProviderRetainedTask: AnyObject, Sendable {
    func resume()
    func cancel()
}

extension URLSessionTask: ProviderRetainedTask {}

enum ProviderTaskAdmission: Equatable {
    case active
    case queued
    case capacityRejected
    case lifecycleUnavailable
    case duplicate
}

final class ProviderTaskRegistry: @unchecked Sendable {
    static let shared = ProviderTaskRegistry()
    private enum State { case active, queued }
    private struct Entry {
        let attemptEpoch: Int
        let lifecycleEpoch: Int
        let deadline: TimeInterval
        let start: (TimeInterval) -> Void
        let cancellation: (Bool, DatabaseFailure) -> Void
        let timer: DispatchWorkItem
        var state: State
        var task: (any ProviderRetainedTask)?
        var started = false
    }
    private typealias Promotion = (TimeInterval, (TimeInterval) -> Void)
    private typealias PromotionResult = (promoted: [Promotion], expired: [Entry])
    private let lock = NSLock()
    private let maximumConcurrent: Int
    private let maximumQueued: Int
    private let totalDeadline: TimeInterval
    private let now: () -> TimeInterval
    private var tasks: [String: Entry] = [:]
    private var queue: [String] = []
    private var lifecycleEpoch = 0
    private var available = true

    init(
        maximumConcurrent: Int = providerMaximumConcurrentRequests,
        maximumQueued: Int = providerMaximumQueuedRequests,
        totalDeadline: TimeInterval = providerTotalDeadline,
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.maximumConcurrent = maximumConcurrent
        self.maximumQueued = maximumQueued
        self.totalDeadline = totalDeadline
        self.now = now
    }

    func lifecycleSnapshot() -> Int? { lock.withLock { available ? lifecycleEpoch : nil } }

    func updateLifecycleAvailability(_ value: Bool) {
        let canceled = lock.withLock { () -> [Entry] in
            guard value != available else { return [] }
            lifecycleEpoch += 1
            available = value
            guard !value else { return [] }
            let canceled = Array(tasks.values)
            tasks.removeAll()
            queue.removeAll()
            canceled.forEach { $0.timer.cancel() }
            return canceled
        }
        let failure = DatabaseFailure(code: "canceled", retryable: true)
        canceled.forEach { entry in
            entry.task?.cancel()
            entry.cancellation(entry.started, failure)
        }
    }

    func install(
        requestId: String,
        attemptEpoch: Int,
        lifecycleEpoch expected: Int,
        start: @escaping (TimeInterval) -> Void,
        cancellation: @escaping (Bool, DatabaseFailure) -> Void
    ) -> ProviderTaskAdmission {
        var startNow: ((TimeInterval) -> Void)?
        var remaining = totalDeadline
        let timer = DispatchWorkItem { [weak self] in
            self?.expire(requestId: requestId)
        }
        let admission = lock.withLock { () -> ProviderTaskAdmission in
            guard available, lifecycleEpoch == expected else { return .lifecycleUnavailable }
            guard tasks[requestId] == nil else { return .duplicate }
            let activeCount = tasks.values.lazy.filter { $0.state == .active }.count
            let state: State
            let admission: ProviderTaskAdmission
            if activeCount < maximumConcurrent {
                state = .active
                admission = .active
                startNow = start
            } else {
                guard queue.count < maximumQueued else { return .capacityRejected }
                state = .queued
                admission = .queued
                queue.append(requestId)
            }
            let deadline = now() + totalDeadline
            remaining = max(0, deadline - now())
            tasks[requestId] = Entry(
                attemptEpoch: attemptEpoch, lifecycleEpoch: expected, deadline: deadline,
                start: start, cancellation: cancellation, timer: timer, state: state
            )
            return admission
        }
        if admission == .active || admission == .queued {
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + totalDeadline, execute: timer)
        }
        if admission == .active { startNow?(remaining) }
        return admission
    }

    func beginNetwork(
        requestId: String,
        attemptEpoch: Int,
        lifecycleEpoch expected: Int,
        withAuthority: (_ resume: (any ProviderRetainedTask) -> Bool) throws -> Void
    ) throws -> Bool {
        let result = try lock.withLock { () -> (started: Bool, expired: Entry?, promotion: PromotionResult) in
            guard available, lifecycleEpoch == expected, var entry = tasks[requestId],
                  entry.state == .active, entry.attemptEpoch == attemptEpoch,
                  entry.lifecycleEpoch == expected, !entry.started, now() < entry.deadline else {
                return (false, nil, ([], []))
            }
            var resumed = false
            var expiredWhileAuthorizing = false
            try withAuthority { task in
                guard now() < entry.deadline else {
                    expiredWhileAuthorizing = true
                    return false
                }
                entry.task = task
                entry.started = true
                tasks[requestId] = entry
                task.resume()
                resumed = true
                return true
            }
            if expiredWhileAuthorizing {
                tasks.removeValue(forKey: requestId)
                entry.timer.cancel()
                return (false, entry, promoteLocked())
            }
            guard resumed else { throw DatabaseFailure(code: "internal_failure", retryable: false) }
            return (true, nil, ([], []))
        }
        let timeout = DatabaseFailure(code: "timeout", retryable: true)
        if let expired = result.expired { expired.cancellation(false, timeout) }
        result.promotion.expired.forEach { entry in
            entry.task?.cancel()
            entry.cancellation(entry.started, timeout)
        }
        result.promotion.promoted.forEach { $0.1($0.0) }
        return result.started
    }

    func failBeforeStart(requestId: String, failure: DatabaseFailure) {
        cancel(requestId: requestId, failure: failure)
    }

    func claimCompletion(requestId: String, attemptEpoch: Int, lifecycleEpoch expected: Int) -> Bool {
        let result = lock.withLock { () -> (claimed: Bool, expired: [Entry], promoted: [Promotion]) in
            guard available, lifecycleEpoch == expected, let entry = tasks[requestId], entry.started,
                  entry.attemptEpoch == attemptEpoch, entry.lifecycleEpoch == expected else {
                return (false, [], [])
            }
            tasks.removeValue(forKey: requestId)
            entry.timer.cancel()
            let completionExpired = now() >= entry.deadline
            let promotion = promoteLocked()
            if completionExpired {
                return (false, [entry] + promotion.expired, promotion.promoted)
            }
            return (true, promotion.expired, promotion.promoted)
        }
        let timeout = DatabaseFailure(code: "timeout", retryable: true)
        result.expired.forEach { entry in
            entry.task?.cancel()
            entry.cancellation(entry.started, timeout)
        }
        result.promoted.forEach { $0.1($0.0) }
        return result.claimed
    }

    @discardableResult
    func cancel(
        requestId: String,
        failure: DatabaseFailure = DatabaseFailure(code: "canceled", retryable: true)
    ) -> Bool {
        let result = lock.withLock { () -> (entry: Entry?, promotion: PromotionResult) in
            guard let entry = tasks.removeValue(forKey: requestId) else { return (nil, ([], [])) }
            entry.timer.cancel()
            if entry.state == .queued { queue.removeAll { $0 == requestId } }
            return (entry, entry.state == .active ? promoteLocked() : ([], []))
        }
        result.entry?.task?.cancel()
        if let entry = result.entry { entry.cancellation(entry.started, failure) }
        let timeout = DatabaseFailure(code: "timeout", retryable: true)
        result.promotion.expired.forEach { entry in
            entry.task?.cancel()
            entry.cancellation(entry.started, timeout)
        }
        result.promotion.promoted.forEach { $0.1($0.0) }
        return result.entry != nil
    }

    func cancelAllAndFence() { updateLifecycleAvailability(false) }

    private func expire(requestId: String) {
        _ = cancel(
            requestId: requestId,
            failure: DatabaseFailure(code: "timeout", retryable: true)
        )
    }

    private func promoteLocked() -> PromotionResult {
        var promoted: [Promotion] = []
        var expired: [Entry] = []
        var activeCount = tasks.values.lazy.filter { $0.state == .active }.count
        while activeCount < maximumConcurrent, !queue.isEmpty {
            let requestId = queue.removeFirst()
            guard var entry = tasks[requestId], entry.state == .queued else { continue }
            let remaining = entry.deadline - now()
            guard remaining > 0 else {
                tasks.removeValue(forKey: requestId)
                entry.timer.cancel()
                expired.append(entry)
                continue
            }
            entry.state = .active
            tasks[requestId] = entry
            activeCount += 1
            promoted.append((remaining, entry.start))
        }
        return (promoted, expired)
    }
}

enum ProviderBridgeDispatch {
    static func generate(_ options: [String: Any]) throws -> ProviderGenerateEnvelope {
        try ProviderBridgeCodec.decodeGenerate(encoded(options))
    }

    static func cancel(_ options: [String: Any]) throws -> ProviderCancelEnvelope {
        try ProviderBridgeCodec.decodeCancel(encoded(options))
    }

    static func listModels(_ options: [String: Any]) throws -> ProviderListModelsEnvelope {
        try ProviderBridgeCodec.decodeListModels(encoded(options))
    }

    static func lifecycleStatus(_ options: [String: Any]) throws -> ProviderLifecycleEnvelope {
        try ProviderBridgeCodec.decodeLifecycleStatus(encoded(options))
    }

    static func success(
        callId: String, value: [String: Any], kind: ProviderResponseKind = .generate
    ) throws -> [String: Any] {
        let response: [String: Any] = ["callId": callId, "ok": true, "value": value]
        let oversizedCode = kind == .listModels ? "response_too_large" : "internal_failure"
        _ = try encodedBridgeJSONObject(response, code: oversizedCode, maximumBytes: providerMaximumEnvelopeBytes)
        return response
    }

    static func failure(
        callId: String, failure: DatabaseFailure, kind: ProviderResponseKind = .generate
    ) -> [String: Any] {
        let sanitized = ProviderBridgeCodec.sanitizeFailure(failure, kind: kind)
        return [
            "callId": callId, "ok": false,
            "error": ["code": sanitized.code, "retryable": sanitized.retryable],
        ]
    }

    private static func encoded(_ options: [String: Any]) throws -> Data {
        try encodedBridgeJSONObject(options, code: "invalid_call", maximumBytes: providerMaximumEnvelopeBytes)
    }
}

#if canImport(Capacitor)
@objc(GreenRoomProviderPlugin)
final class GreenRoomProviderPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GreenRoomProviderPlugin"
    let jsName = "GreenRoomProvider"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]
    private let service = GreenRoomProviderService(authority: GreenRoomNativeAuthority.shared)
    private let inFlightCalls = GreenRoomNativeAuthority.shared.inFlightCalls

    @objc func listModels(_ call: CAPPluginCall) {
        let options = call.options as? [String: Any] ?? [:]
        let callId = canonicalBridgeCallId(options["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "invalid_call", retryable: false))
            return
        }
        do {
            let envelope = try ProviderBridgeDispatch.listModels(options)
            service.listModels(envelope.payload, operationId: callId) { [weak self] result in
                guard let self else { return }
                defer { self.inFlightCalls.finish(callId) }
                switch result {
                case .success(let modelIds):
                    do {
                        call.resolve(try ProviderBridgeDispatch.success(
                            callId: callId, value: ["modelIds": modelIds], kind: .listModels
                        ))
                    }
                    catch let failure as DatabaseFailure { self.reject(call, callId: callId, failure: failure) }
                    catch { self.reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false)) }
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

    @objc func generate(_ call: CAPPluginCall) {
        let options = call.options as? [String: Any] ?? [:]
        let callId = canonicalBridgeCallId(options["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "invalid_call", retryable: false))
            return
        }
        do {
            let envelope = try ProviderBridgeDispatch.generate(options)
            service.generate(envelope.payload) { [weak self] result in
                guard let self else { return }
                defer { self.inFlightCalls.finish(callId) }
                switch result {
                case .success(let attempt): self.resolve(call, callId: callId, attempt: attempt)
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

    @objc func cancel(_ call: CAPPluginCall) {
        let options = call.options as? [String: Any] ?? [:]
        let callId = canonicalBridgeCallId(options["callId"])
        guard callId != "invalid", inFlightCalls.begin(callId) else {
            reject(call, callId: callId, failure: DatabaseFailure(code: "invalid_call", retryable: false))
            return
        }
        defer { inFlightCalls.finish(callId) }
        do {
            let requestId = try ProviderBridgeDispatch.cancel(options).payload.requestId
            let canceled = ProviderTaskRegistry.shared.cancel(requestId: requestId)
            call.resolve(try ProviderBridgeDispatch.success(callId: callId, value: ["canceled": canceled]))
        } catch let failure as DatabaseFailure {
            reject(call, callId: callId, failure: failure)
        } catch {
            reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false))
        }
    }

    private func resolve(_ call: CAPPluginCall, callId: String, attempt: ProviderAttemptResult) {
        do { call.resolve(try ProviderBridgeDispatch.success(
            callId: callId, value: ["text": attempt.text, "attemptEpoch": attempt.attemptEpoch]
        )) }
        catch { reject(call, callId: callId, failure: DatabaseFailure(code: "internal_failure", retryable: false)) }
    }

    private func reject(_ call: CAPPluginCall, callId: String, failure: DatabaseFailure) {
        call.resolve(ProviderBridgeDispatch.failure(callId: callId, failure: failure))
    }
}
#endif
