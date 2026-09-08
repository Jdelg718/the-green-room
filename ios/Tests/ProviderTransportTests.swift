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

private final class ProviderRetainedTaskStub: ProviderRetainedTask, @unchecked Sendable {
    private let lock = NSLock()
    private var resumes = 0
    private var cancellations = 0

    var resumeCount: Int { lock.withLock { resumes } }
    var cancelCount: Int { lock.withLock { cancellations } }
    func resume() { lock.withLock { resumes += 1 } }
    func cancel() { lock.withLock { cancellations += 1 } }
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

    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"],
        chunks: [Data("{\"data\":[{\"id\":\"openai/gpt-4.1-mini\"},{\"id\":\"anthropic/claude-sonnet-4\"}]}".utf8)]
    ))
    let modelSemaphore = DispatchSemaphore(value: 0)
    var modelResult: Result<[String], DatabaseFailure>?
    let modelTask = try transport.makeListModelsTask(timeoutInterval: 1) { result in
        modelResult = result
        modelSemaphore.signal()
    }
    modelTask.resume()
    providerTestRequire(modelSemaphore.wait(timeout: .now() + 1) == .success, "model list transport timed out")
    if case .success(let ids) = modelResult {
        providerTestRequire(ids == ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4"], "model IDs changed")
    } else { fatalError("valid model list failed") }
    let modelRequest = ProviderURLProtocolStub.capturedRequests.single!
    providerTestRequire(modelRequest.httpMethod == "GET" && modelRequest.url?.path == definition.modelsPath,
                        "model listing did not use the fixed GET endpoint")
    providerTestRequire(modelRequest.value(forHTTPHeaderField: "Authorization") == "Bearer native-test-value",
                        "model listing authorization changed")

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

    let providerFixtureURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("contracts/iphone-alpha-native-bridge-v1/fixtures/provider-lifecycle.json")
    let providerFixture = try JSONSerialization.jsonObject(with: Data(contentsOf: providerFixtureURL)) as! [String: Any]
    let providerFixtureCalls = providerFixture["calls"] as! [[String: Any]]
    let providerFixtureResults = providerFixture["results"] as! [[String: Any]]
    let methods = ["provider.generate", "provider.cancel", "lifecycle.status", "provider.listModels"]
    let kinds: [ProviderResponseKind] = [.generate, .cancel, .lifecycle, .listModels]
    func dispatch(_ method: String, _ value: [String: Any]) throws {
        switch method {
        case "provider.generate": _ = try ProviderBridgeDispatch.generate(value)
        case "provider.cancel": _ = try ProviderBridgeDispatch.cancel(value)
        case "lifecycle.status": _ = try ProviderBridgeDispatch.lifecycleStatus(value)
        case "provider.listModels": _ = try ProviderBridgeDispatch.listModels(value)
        default: fatalError("unknown fixture method")
        }
    }
    func materialize(_ value: Any) -> Any {
        if let string = value as? String, string == "$repeat:262145" { return String(repeating: "x", count: 262_145) }
        if let array = value as? [Any] { return array.map(materialize) }
        if let object = value as? [String: Any] { return object.mapValues(materialize) }
        return value
    }
    for index in methods.indices {
        try dispatch(methods[index], providerFixtureCalls[index])
        let encodedResult = try JSONSerialization.data(withJSONObject: providerFixtureResults[index], options: [.sortedKeys])
        _ = try ProviderBridgeCodec.decodeResponse(
            encodedResult, callId: providerFixtureCalls[index]["callId"] as! String, kind: kinds[index]
        )
    }
    let invalidCalls = providerFixture["invalidCalls"] as! [String: [[String: Any]]]
    for (method, cases) in invalidCalls {
        for fixtureCase in cases {
            do {
                if let value = materialize(fixtureCase["value"] as Any) as? [String: Any] {
                    try dispatch(method, value)
                } else {
                    try dispatch(method, [:])
                }
                fatalError("Swift production dispatch accepted \(method)/\(fixtureCase["case"]!)")
            } catch let failure as DatabaseFailure {
                providerTestRequire(failure.code == fixtureCase["expectedCode"] as? String,
                                    "Swift fixture failure code mismatch")
            }
        }
    }
    let failureResults = providerFixture["failureResults"] as! [String: [[String: Any]]]
    for (index, method) in methods.enumerated() {
        let callId = providerFixtureCalls[index]["callId"] as! String
        for response in failureResults[method]! {
            let encoded = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
            _ = try ProviderBridgeCodec.decodeResponse(encoded, callId: callId, kind: kinds[index])
            let error = response["error"] as! [String: Any]
            let dispatched = ProviderBridgeDispatch.failure(callId: callId, failure: DatabaseFailure(
                code: error["code"] as! String, retryable: error["retryable"] as! Bool
            ))
            providerTestRequire(NSDictionary(dictionary: dispatched).isEqual(to: response),
                                "production failure dispatch changed \(method)/\(error["code"]!)")
        }
    }
    let oversizedModelIds = (0..<1_024).map { index in
        "m\(String(format: "%04d", index))".padding(toLength: 256, withPad: "x", startingAt: 0)
    }
    let oversizedModelEnvelope: [String: Any] = [
        "callId": providerFixtureCalls[3]["callId"] as! String,
        "ok": true,
        "value": ["modelIds": oversizedModelIds],
    ]
    providerTestRequire(
        try JSONSerialization.data(withJSONObject: oversizedModelEnvelope, options: [.sortedKeys]).count == 265_298,
        "1,024 x 256-byte model-list regression envelope changed"
    )
    do {
        _ = try ProviderBridgeDispatch.success(
            callId: providerFixtureCalls[3]["callId"] as! String,
            value: ["modelIds": oversizedModelIds], kind: .listModels
        )
        fatalError("oversized model-list success crossed the bridge")
    } catch let failure as DatabaseFailure {
        providerTestRequire(
            failure.code == "response_too_large",
            "oversized model-list result emitted undeclared provider failure code \(failure.code)"
        )
    }
    let sanitizedDatabaseFailure = ProviderBridgeDispatch.failure(
        callId: providerFixtureCalls[0]["callId"] as! String,
        failure: DatabaseFailure(code: "transaction_rejected", retryable: true), kind: .generate
    )
    providerTestRequire(
        ((sanitizedDatabaseFailure["error"] as? [String: Any])?["code"] as? String) == "internal_failure" &&
            ((sanitizedDatabaseFailure["error"] as? [String: Any])?["retryable"] as? Bool) == false,
        "database-only failure crossed the provider bridge"
    )
    providerTestRequire(try ProviderBridgeDispatch.generate(providerFixtureCalls[0]).payload == command,
                        "Swift generate fixture dispatch mismatch")

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

    let capacityRegistry = ProviderTaskRegistry(maximumConcurrent: 1, maximumQueued: 1)
    let capacityEpoch = capacityRegistry.lifecycleSnapshot()!
    let activeTask = ProviderRetainedTaskStub()
    var activeStarts = 0
    providerTestRequire(capacityRegistry.install(
        requestId: "80000000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: capacityEpoch,
        start: { _ in
            activeStarts += 1
            _ = try! capacityRegistry.beginNetwork(
                activeTask, requestId: "80000000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: capacityEpoch, beforeResume: {}
            )
        },
        cancellation: { _, _ in }
    ) == .active, "first provider operation was not active")
    var queuedStarts = 0
    var queuedStartedAtCancellation: Bool?
    providerTestRequire(capacityRegistry.install(
        requestId: "80000000-0000-4000-8000-000000000002", attemptEpoch: 1,
        lifecycleEpoch: capacityEpoch,
        start: { _ in queuedStarts += 1 },
        cancellation: { started, _ in queuedStartedAtCancellation = started }
    ) == .queued, "second provider operation was not queued")
    providerTestRequire(capacityRegistry.install(
        requestId: "80000000-0000-4000-8000-000000000003", attemptEpoch: 1,
        lifecycleEpoch: capacityEpoch, start: { _ in }, cancellation: { _, _ in }
    ) == .capacityRejected, "provider overflow was not capacity_rejected")
    providerTestRequire(activeStarts == 1 && activeTask.resumeCount == 1 && queuedStarts == 0,
                        "queued operation resolved credentials or created/resumed a task")
    providerTestRequire(capacityRegistry.cancel(requestId: "80000000-0000-4000-8000-000000000002"),
                        "queued cancellation was not reported")
    providerTestRequire(queuedStartedAtCancellation == false && queuedStarts == 0,
                        "queued cancellation was classified as started")

    let deadlineRegistry = ProviderTaskRegistry(maximumConcurrent: 1, maximumQueued: 1, totalDeadline: 0.05)
    let deadlineEpoch = deadlineRegistry.lifecycleSnapshot()!
    let deadlineBlocker = ProviderRetainedTaskStub()
    _ = deadlineRegistry.install(
        requestId: "81000000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: deadlineEpoch,
        start: { _ in
            _ = try! deadlineRegistry.beginNetwork(
                deadlineBlocker, requestId: "81000000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: deadlineEpoch, beforeResume: {}
            )
        }, cancellation: { _, _ in }
    )
    let deadlineExpired = DispatchSemaphore(value: 0)
    var deadlineQueuedStarts = 0
    var deadlineFailure: String?
    _ = deadlineRegistry.install(
        requestId: "81000000-0000-4000-8000-000000000002", attemptEpoch: 1,
        lifecycleEpoch: deadlineEpoch,
        start: { _ in deadlineQueuedStarts += 1 },
        cancellation: { started, failure in
            providerTestRequire(!started, "expired queued operation was classified as started")
            deadlineFailure = failure.code
            deadlineExpired.signal()
        }
    )
    providerTestRequire(deadlineExpired.wait(timeout: .now() + 1) == .success,
                        "queued provider total deadline did not expire")
    providerTestRequire(deadlineFailure == "timeout" && deadlineQueuedStarts == 0,
                        "queued deadline created a task or returned the wrong failure")
    deadlineRegistry.cancelAllAndFence()

    var controlledNow: TimeInterval = 0
    let lateRegistry = ProviderTaskRegistry(
        maximumConcurrent: 1, maximumQueued: 1, totalDeadline: 60,
        now: { controlledNow }
    )
    let lateEpoch = lateRegistry.lifecycleSnapshot()!
    let lateTask = ProviderRetainedTaskStub()
    var lateFailure: String?
    _ = lateRegistry.install(
        requestId: "81100000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: lateEpoch,
        start: { _ in
            _ = try! lateRegistry.beginNetwork(
                lateTask, requestId: "81100000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: lateEpoch, beforeResume: {}
            )
        },
        cancellation: { started, failure in
            providerTestRequire(started, "late active completion was classified as never started")
            lateFailure = failure.code
        }
    )
    var lateQueuedStarts = 0
    var lateQueuedFailure: String?
    _ = lateRegistry.install(
        requestId: "81100000-0000-4000-8000-000000000002", attemptEpoch: 1,
        lifecycleEpoch: lateEpoch,
        start: { _ in lateQueuedStarts += 1 },
        cancellation: { started, failure in
            providerTestRequire(!started, "expired queued completion was classified as started")
            lateQueuedFailure = failure.code
        }
    )
    controlledNow = 60
    providerTestRequire(
        !lateRegistry.claimCompletion(
            requestId: "81100000-0000-4000-8000-000000000001", attemptEpoch: 1,
            lifecycleEpoch: lateEpoch
        ),
        "provider completion at the absolute deadline was accepted before timer delivery"
    )
    providerTestRequire(
        lateFailure == "timeout" && lateTask.cancelCount == 1 &&
            lateQueuedFailure == "timeout" && lateQueuedStarts == 0,
        "late completion did not expire active and queued resources without promotion"
    )
    providerTestRequire(
        !lateRegistry.cancel(requestId: "81100000-0000-4000-8000-000000000001") &&
            !lateRegistry.cancel(requestId: "81100000-0000-4000-8000-000000000002"),
        "deadline-expired provider resources remained registered"
    )

    _ = try database.executeBatch(transactionId: "provider-abandon-preflight", statements: [[
        "sqlId": "abandon_generation_command",
        "parameters": ["test_abandon", preflightCommand.commandId, preflightCommand.requestId, preflightCommand.requestDigest],
    ]])
    let queuedPayload = ProviderGeneratePayload(
        roomId: payload.roomId, sourceEventSequence: payload.sourceEventSequence,
        personaSlug: payload.personaSlug, messages: payload.messages, model: payload.model,
        temperature: payload.temperature, maxOutputTokens: payload.maxOutputTokens,
        profileId: payload.profileId, profileRevision: payload.profileRevision,
        providerId: payload.providerId,
        requestId: "82000000-0000-4000-8000-000000000002", kind: "provider"
    )
    let queuedPlanData = try JSONEncoder().encode(queuedPayload)
    let queuedPlan = String(decoding: queuedPlanData, as: UTF8.self)
    let queuedDigest = SHA256.hash(data: queuedPlanData).map { String(format: "%02x", $0) }.joined()
    let queuedCommand = ProviderCommandPayload(
        requestId: queuedPayload.requestId,
        commandId: "82000000-0000-4000-8000-000000000003", requestDigest: queuedDigest
    )
    _ = try database.executeBatch(transactionId: "provider-queued-command", statements: [[
        "sqlId": "prepare_generation_command",
        "parameters": [
            queuedCommand.commandId, queuedCommand.requestId, queuedDigest, queuedPlan,
            "{\"participantId\":\"human-1\",\"text\":\"queued\",\"type\":\"human_message\"}",
            "{\"generation\":0,\"reason\":\"directed\",\"sourceEventSequence\":1,\"speaker\":\"ada-lovelace\",\"type\":\"director_decision\"}",
            directorState, 0, 1, payload.personaSlug, payload.roomId, 0, 1,
            payload.personaSlug, queuedPlan, payload.personaSlug, queuedPlan,
            queuedPlan, queuedPlan, queuedPlan, queuedPlan,
        ],
    ]])
    let cancellationRegistry = ProviderTaskRegistry(maximumConcurrent: 1, maximumQueued: 1)
    let cancellationEpoch = cancellationRegistry.lifecycleSnapshot()!
    let cancellationBlocker = ProviderRetainedTaskStub()
    _ = cancellationRegistry.install(
        requestId: "82900000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: cancellationEpoch,
        start: { _ in
            _ = try! cancellationRegistry.beginNetwork(
                cancellationBlocker, requestId: "82900000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: cancellationEpoch, beforeResume: {}
            )
        }, cancellation: { _, _ in }
    )
    _ = cancellationRegistry.install(
        requestId: queuedCommand.requestId, attemptEpoch: 1, lifecycleEpoch: cancellationEpoch,
        start: { _ in fatalError("queued SQLite operation started before cancellation") },
        cancellation: { started, _ in
            providerTestRequire(!started, "queued SQLite operation was classified uncertain")
            _ = try! database.executeBatch(transactionId: "provider-queued-not-started", statements: [[
                "sqlId": "fail_generation_command", "parameters": [
                    "not_started", queuedCommand.commandId, queuedCommand.requestId, queuedCommand.requestDigest, 0,
                ],
            ]])
        }
    )
    cancellationRegistry.cancelAllAndFence()
    let queuedRow = (try database.query(
        sqlId: "unresolved_generation_command", parameters: [payload.roomId]
    ))["rows"] as? [[Any]]
    let queuedJSON = queuedRow?.first?.first as? String ?? ""
    providerTestRequire(
        queuedJSON.contains("\"state\":\"failed\"") && queuedJSON.contains("\"failureCode\":\"not_started\""),
        "never-started queued lifecycle cancellation was not persisted failed/not_started"
    )

    let sqliteRegistry = ProviderTaskRegistry(maximumConcurrent: 1, maximumQueued: 1)
    let sqliteEpoch = sqliteRegistry.lifecycleSnapshot()!
    let sqliteBlocker = ProviderRetainedTaskStub()
    _ = sqliteRegistry.install(
        requestId: "83000000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: sqliteEpoch,
        start: { _ in
            _ = try! sqliteRegistry.beginNetwork(
                sqliteBlocker, requestId: "83000000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: sqliteEpoch, beforeResume: {}
            )
        }, cancellation: { _, _ in }
    )
    let storedReservation = try database.credentialReservation(
        profileId: reservation.profileId, profileRevision: reservation.profileRevision,
        providerId: reservation.providerId, credentialRef: reservation.credentialRef
    )!
    var restoredCredential = Data("native-test-value".utf8)
    try credentialStore.write(
        credentialRef: reservation.credentialRef, secret: &restoredCredential,
        metadata: CredentialMetadata(reservation: storedReservation)
    )
    let queuedService = GreenRoomProviderService(
        authority: authority, configuration: configuration, registry: sqliteRegistry
    )
    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"], chunks: [successBody]
    ))
    let queuedSemaphore = DispatchSemaphore(value: 0)
    var queuedResult: Result<String, DatabaseFailure>?
    queuedService.generate(queuedCommand) { result in
        queuedResult = result
        queuedSemaphore.signal()
    }
    _ = try database.executeBatch(transactionId: "provider-abandon-queued", statements: [[
        "sqlId": "abandon_generation_command",
        "parameters": ["test_abandon", queuedCommand.commandId, queuedCommand.requestId, queuedCommand.requestDigest],
    ]])
    providerTestRequire(
        sqliteRegistry.claimCompletion(
            requestId: "83000000-0000-4000-8000-000000000001", attemptEpoch: 1,
            lifecycleEpoch: sqliteEpoch
        ),
        "queue blocker could not complete"
    )
    providerTestRequire(
        queuedSemaphore.wait(timeout: .now() + 1) == .success,
        "abandoned queued generation did not resolve"
    )
    if case .failure(let failure) = queuedResult {
        providerTestRequire(
            failure.code == "internal_failure" && !failure.retryable,
            "abandoned queued begin leaked database-only failure \(failure.code)"
        )
    } else { fatalError("abandoned queued generation returned success") }
    providerTestRequire(
        ProviderURLProtocolStub.capturedRequests.isEmpty,
        "abandoned queued generation reached the provider network"
    )
    providerTestRequire(
        !sqliteRegistry.cancel(requestId: queuedCommand.requestId),
        "abandoned queued generation remained registered"
    )
}

private extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}
