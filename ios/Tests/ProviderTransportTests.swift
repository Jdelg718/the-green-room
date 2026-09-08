import CryptoKit
import Foundation
import SQLite3

private final class ProviderCredentialStore: CredentialSecureStore, @unchecked Sendable {
    private var values: [String: (Data, CredentialMetadata)] = [:]

    func inspectMetadata(credentialRef: String) throws -> CredentialMetadataInspection {
        values[credentialRef].map { .valid($0.1) } ?? .missing
    }

    func write(credentialRef: String, secret: inout Data, metadata: CredentialMetadata) throws {
        values[credentialRef] = (secret, metadata)
    }

    func delete(credentialRef: String) throws { values.removeValue(forKey: credentialRef) }

    func inventory() throws -> [CredentialStoredItem] {
        values.map { CredentialStoredItem(credentialRef: $0.key, inspection: .valid($0.value.1)) }
    }

    func performWithCredential(
        credentialRef: String,
        expectedMetadata: CredentialMetadata,
        operation: (inout Data) throws -> Void
    ) throws {
        guard let stored = values[credentialRef], stored.1 == expectedMetadata else {
            throw DatabaseFailure(code: "credential_missing", retryable: true)
        }
        var bytes = stored.0
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        try operation(&bytes)
    }
}

private final class ProviderURLProtocolStub: URLProtocol, @unchecked Sendable {
    enum Outcome {
        case response(status: Int, headers: [String: String], chunks: [Data])
        case failure(URLError.Code)
        case redirect(URL)
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var outcome: Outcome = .failure(.cannotConnectToHost)
    nonisolated(unsafe) private static var requests: [URLRequest] = []

    static func install(_ value: Outcome) {
        lock.withLock { outcome = value; requests = [] }
    }

    static var capturedRequests: [URLRequest] { lock.withLock { requests } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let value = Self.lock.withLock { Self.requests.append(request); return Self.outcome }
        switch value {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .redirect(let destination):
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1",
                headerFields: ["Location": destination.absoluteString]
            )!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: destination), redirectResponse: response)
        case .response(let status, let headers, let chunks):
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

private func providerTestRequire(_ condition: Bool, _ message: String) {
    if !condition { fatalError(message) }
}

private func awaitProvider(
    _ transport: ProviderTransport,
    payload: ProviderGeneratePayload,
    label: String = "success"
) -> Result<String, DatabaseFailure> {
    let semaphore = DispatchSemaphore(value: 0)
    var captured: Result<String, DatabaseFailure>?
    transport.generate(payload) { result in captured = result; semaphore.signal() }
    providerTestRequire(
        semaphore.wait(timeout: .now() + 3) == .success,
        "provider \(label) test timed out after \(ProviderURLProtocolStub.capturedRequests.count) request(s)"
    )
    return captured!
}

private func expectProviderFailure(
    _ code: String,
    _ transport: ProviderTransport,
    payload: ProviderGeneratePayload,
    label: String
) {
    switch awaitProvider(transport, payload: payload, label: label) {
    case .failure(let failure): providerTestRequire(failure.code == code, "expected \(code), got \(failure.code)")
    case .success: fatalError("expected \(code)")
    }
}

func runProviderTransportTests() throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProviderURLProtocolStub.self]
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 60
    let definition = ApprovedProviderDefinitions.openrouter
    let payload = ProviderGeneratePayload(
        roomId: "room-00000000-0000-4000-8000-000000000001",
        sourceEventSequence: 1,
        personaSlug: "ada-lovelace",
        messages: [
            ProviderMessage(role: "system", content: "You are Ada Lovelace."),
            ProviderMessage(role: "user", content: "Hello."),
        ],
        model: "openai/gpt-4.1-mini",
        temperature: 0.7,
        maxOutputTokens: 300,
        profileId: "iphone.openrouter",
        profileRevision: 1,
        providerId: "openrouter",
        requestId: "30000000-0000-4000-8000-000000000003",
        kind: "provider"
    )
    let transport = ProviderTransport(
        definition: definition,
        configuration: configuration,
        authorizationValue: "Bearer native-test-value"
    )

    let successBody = Data("{\"model\":\"openai/gpt-4.1-mini\",\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"A bounded answer.\"}}]}".utf8)
    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"], chunks: [successBody]
    ))
    switch awaitProvider(transport, payload: payload) {
    case .success(let text): providerTestRequire(text == "A bounded answer.", "success text mismatch")
    case .failure(let failure): fatalError("unexpected provider failure: \(failure.code)")
    }
    let request = ProviderURLProtocolStub.capturedRequests.single!
    providerTestRequire(request.url?.host == definition.hostname && request.url?.path == definition.chatPath, "unpinned destination")
    let body = try JSONSerialization.jsonObject(with: transport.requestBody(payload)) as! [String: Any]
    providerTestRequire(body[definition.outputTokenField] as? Int == 300, "provider token field mismatch")
    providerTestRequire(body["max_completion_tokens"] == nil, "wrong token field leaked into OpenRouter request")
    for approved in ApprovedProviderDefinitions.all {
        let candidate = ProviderTransport(
            definition: approved, configuration: configuration,
            authorizationValue: "Bearer native-test-value"
        )
        let candidateBody = try JSONSerialization.jsonObject(with: candidate.requestBody(payload)) as! [String: Any]
        providerTestRequire(candidateBody[approved.outputTokenField] as? Int == 300, "approved token field mismatch")
        let alternate = approved.outputTokenField == "max_tokens" ? "max_completion_tokens" : "max_tokens"
        providerTestRequire(candidateBody[alternate] == nil, "alternate token field was included")
    }

    ProviderURLProtocolStub.install(.response(status: 503, headers: ["Content-Type": "application/json"], chunks: [Data("{}".utf8)]))
    expectProviderFailure("provider_rejected", transport, payload: payload, label: "non-2xx")

    ProviderURLProtocolStub.install(.response(status: 200, headers: ["Content-Type": "application/json"], chunks: [Data("not-json".utf8)]))
    expectProviderFailure("invalid_response", transport, payload: payload, label: "malformed")

    ProviderURLProtocolStub.install(.failure(.timedOut))
    expectProviderFailure("timeout", transport, payload: payload, label: "timeout")

    ProviderURLProtocolStub.install(.failure(.notConnectedToInternet))
    expectProviderFailure("offline", transport, payload: payload, label: "offline")

    ProviderURLProtocolStub.install(.failure(.cannotConnectToHost))
    expectProviderFailure("provider_unreachable", transport, payload: payload, label: "unreachable")

    ProviderURLProtocolStub.install(.redirect(URL(string: "https://evil.invalid/redirect")!))
    expectProviderFailure("provider_rejected", transport, payload: payload, label: "redirect")
    providerTestRequire(ProviderURLProtocolStub.capturedRequests.count == 1, "redirect was followed")

    let openAITransport = ProviderTransport(
        definition: ApprovedProviderDefinitions.openai,
        configuration: configuration,
        authorizationValue: "Bearer native-test-value"
    )
    let openAIPayload = ProviderGeneratePayload(
        roomId: payload.roomId, sourceEventSequence: payload.sourceEventSequence,
        personaSlug: payload.personaSlug, messages: payload.messages,
        model: "gpt-4.1-mini", temperature: payload.temperature,
        maxOutputTokens: payload.maxOutputTokens, profileId: "iphone.openai",
        profileRevision: 1, providerId: "openai", requestId: payload.requestId, kind: "provider"
    )
    let openAIBody = try JSONSerialization.jsonObject(with: openAITransport.requestBody(openAIPayload)) as! [String: Any]
    providerTestRequire(openAIBody["model"] as? String == "gpt-4.1-mini", "OpenAI model ID was prefixed or rewritten")

    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"],
        chunks: [Data(repeating: 0x78, count: 64 * 1024), Data([0x78])]
    ))
    expectProviderFailure("response_too_large", transport, payload: payload, label: "response-cap")

    let command = ProviderCommandPayload(
        requestId: payload.requestId,
        commandId: "40000000-0000-4000-8000-000000000004",
        requestDigest: String(repeating: "a", count: 64)
    )
    let closedEnvelope: [String: Any] = [
        "contractVersion": bridgeContractVersion,
        "callId": "20000000-0000-4000-8000-000000000002",
        "method": "provider.generate",
        "payload": [
            "requestId": command.requestId,
            "commandId": command.commandId,
            "requestDigest": command.requestDigest,
        ],
    ]
    let encoded = try JSONSerialization.data(withJSONObject: closedEnvelope)
    providerTestRequire(try ProviderBridgeCodec.decodeGenerate(encoded).payload == command, "closed command bridge decode mismatch")

    func planData(model: String) throws -> Data {
        var plan = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any]
        plan["model"] = model
        return try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys])
    }
    func expectModelAccepted(_ model: String, label: String) throws {
        let decoded = try ProviderBridgeCodec.decodeRequestPlan(String(decoding: planData(model: model), as: UTF8.self))
        providerTestRequire(decoded.model == model, "\(label) model changed during decode")
    }
    func expectModelRejected(_ model: String, label: String) throws {
        do {
            _ = try ProviderBridgeCodec.decodeRequestPlan(String(decoding: planData(model: model), as: UTF8.self))
            fatalError("\(label) model was accepted")
        } catch let failure as DatabaseFailure {
            providerTestRequire(failure.code == "invalid_call", "\(label) failure was not sanitized")
        }
    }

    try expectModelAccepted("provider/valid-model_1", label: "ordinary valid")
    try expectModelAccepted(String(repeating: "a", count: 256), label: "256-byte ASCII boundary")
    try expectModelAccepted(String(repeating: "🟢", count: 64), label: "256-byte multibyte boundary")
    try expectModelRejected(String(repeating: "a", count: 257), label: "257-byte")
    try expectModelRejected("model id", label: "whitespace")
    try expectModelRejected("model\u{0000}id", label: "control U+0000")
    try expectModelRejected("model\u{200B}id", label: "format U+200B")
    try expectModelRejected("model\u{200D}id", label: "format U+200D")
    try expectModelRejected("model\u{E000}id", label: "private-use U+E000")
    try expectModelRejected("model\u{0378}id", label: "unassigned U+0378")
    try expectModelRejected("modele\u{0301}", label: "non-NFC")

    var withSecret = closedEnvelope
    var secretPayload = withSecret["payload"] as! [String: Any]
    secretPayload["secret"] = "forbidden"
    withSecret["payload"] = secretPayload
    do {
        _ = try ProviderBridgeCodec.decodeGenerate(JSONSerialization.data(withJSONObject: withSecret))
        fatalError("secret field was accepted")
    } catch let failure as DatabaseFailure {
        providerTestRequire(failure.code == "invalid_call", "secret field failure was not sanitized")
    }

    let fenceRoot = FileManager.default.temporaryDirectory.appendingPathComponent(
        "greenroom-provider-fence-tests-\(UUID().uuidString)"
    )
    defer { try? FileManager.default.removeItem(at: fenceRoot) }
    try FileManager.default.createDirectory(at: fenceRoot, withIntermediateDirectories: true)
    let migrations = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("ios/App/App/Resources/Migrations")
    let database = GreenRoomDatabaseStore(
        directory: fenceRoot, migrationsDirectory: migrations, fileProtector: { _ in }
    )
    let credentialStore = ProviderCredentialStore()
    let authority = GreenRoomNativeAuthority(database: database, secureStore: credentialStore)
    _ = try authority.openDatabase(expectedSchema: 7)
    _ = try database.executeBatch(transactionId: "provider-room", statements: [
        ["sqlId": "create_room", "parameters": [payload.roomId, "Provider room"]],
        ["sqlId": "create_human", "parameters": ["human-1", payload.roomId, "You"]],
        ["sqlId": "create_persona", "parameters": [payload.personaSlug, payload.roomId, "Ada Lovelace", 1, payload.personaSlug]],
        ["sqlId": "create_director_state", "parameters": [payload.roomId]],
        ["sqlId": "select_room", "parameters": [payload.roomId]],
    ])
    let reservation = CredentialMutationRequest(
        profileId: payload.profileId, profileRevision: 1, providerId: "openrouter",
        credentialRef: "credential:iphone.openrouter:1",
        mutationId: "50000000-0000-4000-8000-000000000005"
    )
    _ = try database.executeBatch(transactionId: "provider-profile", statements: [
        ["sqlId": "create_connection_profile_revision", "parameters": [payload.profileId, 1, "openrouter", NSNull()]],
        ["sqlId": "reserve_credential", "parameters": reservation.baseIdentityParameters + [NSNull(), reservation.mutationId]],
        ["sqlId": "save_provider_selection", "parameters": ["openrouter", payload.profileId, 1, payload.model, payload.profileId, 1, "openrouter"]],
    ])
    var credential = Data("native-test-value".utf8)
    _ = try authority.credentials.completeSave(reservation, secret: &credential)
    let planData = try JSONEncoder().encode(payload)
    let planJSON = String(decoding: planData, as: UTF8.self)
    let digest = SHA256.hash(data: planData).map { String(format: "%02x", $0) }.joined()
    let directorState = "{\"acceptedHumanEventNumber\":1,\"autonomousTurns\":1,\"cancelled\":false,\"fallbackIndex\":0,\"lastSelectedAt\":[[\"ada-lovelace\",1]],\"maxAutonomousTurns\":10,\"seen\":[],\"version\":1}"
    let exactCommand = ProviderCommandPayload(requestId: payload.requestId, commandId: command.commandId, requestDigest: digest)
    _ = try database.executeBatch(transactionId: "provider-command", statements: [[
        "sqlId": "prepare_generation_command",
        "parameters": [
            exactCommand.commandId, exactCommand.requestId, digest, planJSON,
            "{\"participantId\":\"human-1\",\"text\":\"hello\",\"type\":\"human_message\"}",
            "{\"generation\":0,\"reason\":\"directed\",\"sourceEventSequence\":1,\"speaker\":\"ada-lovelace\",\"type\":\"director_decision\"}",
            directorState, 0, 1, payload.personaSlug, payload.roomId, 0, 1,
            payload.personaSlug, planJSON, payload.personaSlug, planJSON,
            planJSON, planJSON, planJSON, planJSON,
        ],
    ]])
    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"], chunks: [successBody]
    ))
    let fenceService = GreenRoomProviderService(authority: authority, configuration: configuration)
    let changedSemaphore = DispatchSemaphore(value: 0)
    fenceService.generate(ProviderCommandPayload(
        requestId: exactCommand.requestId, commandId: exactCommand.commandId,
        requestDigest: String(repeating: "b", count: 64)
    )) { result in
        if case .success = result { fatalError("changed digest returned success") }
        changedSemaphore.signal()
    }
    providerTestRequire(changedSemaphore.wait(timeout: .now() + 1) == .success, "changed digest did not resolve")
    providerTestRequire(ProviderURLProtocolStub.capturedRequests.isEmpty, "changed digest reached network")
    let fenceSemaphore = DispatchSemaphore(value: 0)
    var fenceResult: Result<String, DatabaseFailure>?
    fenceService.generate(exactCommand) { result in fenceResult = result; fenceSemaphore.signal() }
    providerTestRequire(fenceSemaphore.wait(timeout: .now() + 1) == .success, "generation fence did not resolve")
    if case .success(let text) = fenceResult {
        providerTestRequire(text == "A bounded answer.", "valid command result changed")
    } else { fatalError("valid exact command did not return success") }
    providerTestRequire(ProviderURLProtocolStub.capturedRequests.count == 1, "valid command did not issue exactly one request")
    _ = try authority.closeDatabase()
    _ = try authority.openDatabase(expectedSchema: 7)
    let reconciled = (try database.query(sqlId: "unresolved_generation_command", parameters: [payload.roomId]))["rows"] as? [[Any]]
    providerTestRequire(
        (reconciled?.first?.first as? String)?.contains("\"state\":\"interrupted\"") == true,
        "activation did not reconcile started work to interrupted"
    )
    providerTestRequire(ProviderURLProtocolStub.capturedRequests.count == 1, "relaunch issued an automatic provider request")
    _ = try database.executeBatch(transactionId: "provider-abandon-interrupted", statements: [[
        "sqlId": "abandon_generation_command",
        "parameters": ["test_abandon", exactCommand.commandId, exactCommand.requestId, exactCommand.requestDigest],
    ]])
    let preflightPayload = ProviderGeneratePayload(
        roomId: payload.roomId, sourceEventSequence: payload.sourceEventSequence,
        personaSlug: payload.personaSlug, messages: payload.messages, model: payload.model,
        temperature: payload.temperature, maxOutputTokens: payload.maxOutputTokens,
        profileId: payload.profileId, profileRevision: payload.profileRevision,
        providerId: payload.providerId,
        requestId: "60000000-0000-4000-8000-000000000006", kind: "provider"
    )
    let preflightData = try JSONEncoder().encode(preflightPayload)
    let preflightPlan = String(decoding: preflightData, as: UTF8.self)
    let preflightDigest = SHA256.hash(data: preflightData).map { String(format: "%02x", $0) }.joined()
    let preflightCommand = ProviderCommandPayload(
        requestId: preflightPayload.requestId,
        commandId: "70000000-0000-4000-8000-000000000007",
        requestDigest: preflightDigest
    )
    _ = try database.executeBatch(transactionId: "provider-preflight-command", statements: [[
        "sqlId": "prepare_generation_command",
        "parameters": [
            preflightCommand.commandId, preflightCommand.requestId, preflightDigest, preflightPlan,
            "{\"participantId\":\"human-1\",\"text\":\"hello\",\"type\":\"human_message\"}",
            "{\"generation\":0,\"reason\":\"directed\",\"sourceEventSequence\":1,\"speaker\":\"ada-lovelace\",\"type\":\"director_decision\"}",
            directorState, 0, 1, payload.personaSlug, payload.roomId, 0, 1,
            payload.personaSlug, preflightPlan, payload.personaSlug, preflightPlan,
            preflightPlan, preflightPlan, preflightPlan, preflightPlan,
        ],
    ]])
    try credentialStore.delete(credentialRef: reservation.credentialRef)
    let preflightSemaphore = DispatchSemaphore(value: 0)
    var preflightResult: Result<String, DatabaseFailure>?
    fenceService.generate(preflightCommand) { result in preflightResult = result; preflightSemaphore.signal() }
    providerTestRequire(preflightSemaphore.wait(timeout: .now() + 1) == .success, "pre-request failure did not resolve")
    if case .failure(let failure) = preflightResult {
        providerTestRequire(failure.code == "credential_missing", "pre-request failure code changed")
    } else { fatalError("missing credential returned provider success") }
    let failedCommand = (try database.query(sqlId: "unresolved_generation_command", parameters: [payload.roomId]))["rows"] as? [[Any]]
    providerTestRequire((failedCommand?.first?.first as? String)?.contains("\"state\":\"failed\"") == true, "native pre-request failure was not marked failed")
    providerTestRequire(ProviderURLProtocolStub.capturedRequests.count == 1, "native pre-request failure reached network")

    let registry = ProviderTaskRegistry()
    let lifecycleEpoch = registry.lifecycleSnapshot()!
    let suspended = URLSession.shared.dataTask(with: URL(string: "https://127.0.0.1/never-started")!)
    providerTestRequire(
        registry.install(suspended, requestId: exactCommand.requestId, attemptEpoch: 1, lifecycleEpoch: lifecycleEpoch),
        "lifecycle registry did not retain a suspended task before start"
    )
    registry.cancelAllAndFence()
    providerTestRequire(registry.lifecycleSnapshot() == nil, "background fence still accepted provider starts")
    providerTestRequire(
        !registry.claimCompletion(requestId: exactCommand.requestId, attemptEpoch: 1, lifecycleEpoch: lifecycleEpoch),
        "late callback won after lifecycle cancellation"
    )
    registry.updateLifecycleAvailability(true)
    let activatedEpoch = registry.lifecycleSnapshot()!
    providerTestRequire(activatedEpoch > lifecycleEpoch, "activation did not advance the lifecycle epoch")
    let replacement = URLSession.shared.dataTask(with: URL(string: "https://127.0.0.1/never-started")!)
    providerTestRequire(
        registry.install(replacement, requestId: exactCommand.requestId, attemptEpoch: 2, lifecycleEpoch: activatedEpoch),
        "activation did not permit an explicit new attempt"
    )
    providerTestRequire(
        registry.claimCompletion(requestId: exactCommand.requestId, attemptEpoch: 2, lifecycleEpoch: activatedEpoch),
        "valid completion could not win the registry race"
    )
    providerTestRequire(
        !registry.claimCompletion(requestId: exactCommand.requestId, attemptEpoch: 2, lifecycleEpoch: activatedEpoch),
        "duplicate callback won the registry race twice"
    )
    replacement.cancel()
}

private extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}
