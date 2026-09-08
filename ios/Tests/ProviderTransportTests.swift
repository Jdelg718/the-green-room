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

    func exerciseFinalAuthorityFence(_ mutation: String, listModels: Bool = false) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "greenroom-final-authority-\(mutation)-\(UUID().uuidString)"
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let fencedDatabase = GreenRoomDatabaseStore(
            directory: root, migrationsDirectory: migrations, fileProtector: { _ in }
        )
        let fencedStore = ProviderCredentialStore()
        let fencedAuthority = GreenRoomNativeAuthority(database: fencedDatabase, secureStore: fencedStore)
        _ = try fencedAuthority.openDatabase(expectedSchema: 7)
        let roomId = "room-10000000-0000-4000-8000-000000000001"
        let otherRoomId = "room-10000000-0000-4000-8000-000000000002"
        let requestId = "10000000-0000-4000-8000-000000000003"
        let commandId = "10000000-0000-4000-8000-000000000004"
        let mutationRequest = CredentialMutationRequest(
            profileId: payload.profileId, profileRevision: 1, providerId: payload.providerId,
            credentialRef: "credential:iphone.openrouter:1",
            mutationId: "10000000-0000-4000-8000-000000000005"
        )
        _ = try fencedDatabase.executeBatch(transactionId: "fence-setup-\(mutation)", statements: [
            ["sqlId": "create_room", "parameters": [roomId, "Fenced room"]],
            ["sqlId": "create_human", "parameters": ["human-fence", roomId, "You"]],
            ["sqlId": "create_persona", "parameters": [payload.personaSlug, roomId, "Ada Lovelace", 1, payload.personaSlug]],
            ["sqlId": "create_director_state", "parameters": [roomId]],
            ["sqlId": "select_room", "parameters": [roomId]],
            ["sqlId": "create_connection_profile_revision", "parameters": [payload.profileId, 1, payload.providerId, NSNull()]],
            ["sqlId": "reserve_credential", "parameters": mutationRequest.baseIdentityParameters + [NSNull(), mutationRequest.mutationId]],
            ["sqlId": "save_provider_selection", "parameters": [payload.providerId, payload.profileId, 1, payload.model, payload.profileId, 1, payload.providerId]],
        ])
        var fencedSecret = Data("native-test-value".utf8)
        _ = try fencedAuthority.credentials.completeSave(mutationRequest, secret: &fencedSecret)
        let fencedPayload = ProviderGeneratePayload(
            roomId: roomId, sourceEventSequence: 1, personaSlug: payload.personaSlug,
            messages: payload.messages, model: payload.model, temperature: payload.temperature,
            maxOutputTokens: payload.maxOutputTokens, profileId: payload.profileId,
            profileRevision: 1, providerId: payload.providerId, requestId: requestId, kind: "provider"
        )
        let fencedPlanData = try JSONEncoder().encode(fencedPayload)
        let fencedPlan = String(decoding: fencedPlanData, as: UTF8.self)
        let fencedDigest = SHA256.hash(data: fencedPlanData).map { String(format: "%02x", $0) }.joined()
        if !listModels {
            _ = try fencedDatabase.executeBatch(transactionId: "fence-command-\(mutation)", statements: [[
                "sqlId": "prepare_generation_command", "parameters": [
                    commandId, requestId, fencedDigest, fencedPlan,
                    "{\"participantId\":\"human-fence\",\"text\":\"hello\",\"type\":\"human_message\"}",
                    "{\"generation\":0,\"reason\":\"directed\",\"sourceEventSequence\":1,\"speaker\":\"ada-lovelace\",\"type\":\"director_decision\"}",
                    directorState, 0, 1, payload.personaSlug, roomId, 0, 1,
                    payload.personaSlug, fencedPlan, payload.personaSlug, fencedPlan,
                    fencedPlan, fencedPlan, fencedPlan, fencedPlan,
                ],
            ]])
        }
        var deadlineClockReads = 0
        let serviceRegistry = ProviderTaskRegistry(
            maximumConcurrent: 1, maximumQueued: 1,
            totalDeadline: mutation == "deadline" ? 60 : providerTotalDeadline,
            now: {
                deadlineClockReads += 1
                return mutation == "deadline" && deadlineClockReads >= 4 ? 2_060 : 2_000
            }
        )
        let service = GreenRoomProviderService(
            authority: fencedAuthority, configuration: configuration,
            registry: serviceRegistry,
            afterCredentialResolution: {
                switch mutation {
                case "credential":
                    _ = try fencedAuthority.credentials.delete(mutationRequest)
                    if !listModels {
                        do {
                            _ = try fencedDatabase.executeBatch(transactionId: "exact-tombstone-then-begin", statements: [[
                                "sqlId": "begin_generation_command", "parameters": [
                                    commandId, requestId, fencedDigest, fencedPlan, 0,
                                    mutationRequest.credentialRef, mutationRequest.mutationId,
                                ],
                            ]])
                            fatalError("exact tombstoned credential began a provider command")
                        } catch let failure as DatabaseFailure {
                            providerTestRequire(failure.code == "transaction_rejected", "tombstone/begin failure was not closed")
                        }
                    }
                case "selection":
                    if listModels {
                        _ = try fencedDatabase.executeBatch(transactionId: "mutate-selection-identity", statements: [
                            ["sqlId": "create_connection_profile_revision", "parameters": ["iphone.openai", 1, "openai", NSNull()]],
                            ["sqlId": "save_provider_selection", "parameters": [
                                "openai", "iphone.openai", 1, "gpt-test", "iphone.openai", 1, "openai",
                            ]],
                        ])
                    } else {
                        _ = try fencedDatabase.executeBatch(transactionId: "mutate-selection-model", statements: [[
                            "sqlId": "save_provider_selection", "parameters": [
                                payload.providerId, payload.profileId, 1, "changed-model",
                                payload.profileId, 1, payload.providerId,
                            ],
                        ]])
                    }
                case "profile":
                    _ = try fencedDatabase.executeBatch(transactionId: "supersede-profile", statements: [[
                        "sqlId": "create_connection_profile_revision", "parameters": [payload.profileId, 2, payload.providerId, 1],
                    ]])
                case "room":
                    _ = try fencedDatabase.executeBatch(transactionId: "change-room-authority", statements: [
                        ["sqlId": "create_room", "parameters": [otherRoomId, "Other room"]],
                        ["sqlId": "select_room", "parameters": [otherRoomId]],
                    ])
                case "credential-bytes":
                    var replacement = Data("replacement-test-value".utf8)
                    try fencedStore.write(
                        credentialRef: mutationRequest.credentialRef, secret: &replacement,
                        metadata: CredentialMetadata(reservation: try fencedDatabase.credentialReservation(
                            profileId: mutationRequest.profileId, profileRevision: mutationRequest.profileRevision,
                            providerId: mutationRequest.providerId, credentialRef: mutationRequest.credentialRef
                        )!)
                    )
                    replacement.resetBytes(in: 0..<replacement.count)
                case "deadline":
                    break
                default:
                    fatalError("unknown authority mutation")
                }
            }
        )
        ProviderURLProtocolStub.install(.response(
            status: 200, headers: ["Content-Type": "application/json"], chunks: [
                listModels && mutation == "credential-bytes"
                    ? Data("{\"data\":[{\"id\":\"fresh-model\"}]}".utf8)
                    : successBody
            ]
        ))
        let semaphore = DispatchSemaphore(value: 0)
        var failureCode: String?
        var succeeded = false
        if listModels {
            service.listModels(
                ProviderListModelsPayload(
                    profileId: payload.profileId, profileRevision: 1,
                    providerId: payload.providerId, credentialRef: mutationRequest.credentialRef
                ),
                operationId: "10000000-0000-4000-8000-000000000006"
            ) { result in
                if case .failure(let failure) = result { failureCode = failure.code }
                if case .success = result { succeeded = true }
                semaphore.signal()
            }
        } else {
            service.generate(ProviderCommandPayload(
                requestId: requestId, commandId: commandId, requestDigest: fencedDigest
            )) { result in
                if case .failure(let failure) = result { failureCode = failure.code }
                if case .success = result { succeeded = true }
                semaphore.signal()
            }
        }
        providerTestRequire(semaphore.wait(timeout: .now() + 2) == .success, "\(mutation) fence did not resolve")
        if mutation == "credential-bytes" {
            providerTestRequire(succeeded, "\(listModels ? "listModels" : "generate") rejected replacement credential bytes")
            providerTestRequire(
                ProviderURLProtocolStub.capturedRequests.count == 1 &&
                    ProviderURLProtocolStub.capturedRequests[0].value(forHTTPHeaderField: "Authorization") ==
                        "Bearer replacement-test-value",
                "\(listModels ? "listModels" : "generate") used stale credential bytes"
            )
            return
        }
        let expectedCode: String
        if mutation == "profile" && !listModels {
            expectedCode = "credential_unavailable"
        } else if mutation == "credential" || listModels {
            expectedCode = "credential_missing"
        } else if mutation == "deadline" {
            expectedCode = "timeout"
        } else {
            expectedCode = "canceled"
        }
        providerTestRequire(failureCode == expectedCode, "\(mutation) fence returned \(failureCode ?? "success")")
        providerTestRequire(ProviderURLProtocolStub.capturedRequests.isEmpty, "\(mutation) fence reached network")
        if !listModels {
            let unresolved = (try fencedDatabase.query(
                sqlId: "unresolved_generation_command", parameters: [roomId]
            ))["rows"] as? [[Any]]
            let unresolvedJSON = unresolved?.first?.first as? String ?? ""
            providerTestRequire(
                unresolvedJSON.contains("\"state\":\"failed\"") &&
                    (mutation != "deadline" || (
                        unresolvedJSON.contains("\"failureCode\":\"not_started\"") &&
                        !unresolvedJSON.contains("\"state\":\"interrupted\"")
                    )),
                "\(mutation) fence did not durably close the unstarted command: \(unresolvedJSON)"
            )
        }
    }

    try exerciseFinalAuthorityFence("credential")
    try exerciseFinalAuthorityFence("selection")
    try exerciseFinalAuthorityFence("profile")
    try exerciseFinalAuthorityFence("room")
    try exerciseFinalAuthorityFence("credential", listModels: true)
    try exerciseFinalAuthorityFence("selection", listModels: true)
    try exerciseFinalAuthorityFence("profile", listModels: true)
    try exerciseFinalAuthorityFence("credential-bytes")
    try exerciseFinalAuthorityFence("credential-bytes", listModels: true)
    try exerciseFinalAuthorityFence("deadline")

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
                requestId: "80000000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: capacityEpoch, withAuthority: { _ = $0(activeTask) }
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

    let productionRegistry = ProviderTaskRegistry()
    let productionEpoch = productionRegistry.lifecycleSnapshot()!
    var productionStartOrder: [Int] = []
    var productionCredentialUses = Array(repeating: 0, count: 20)
    var productionTasks = Array<ProviderRetainedTaskStub?>(repeating: nil, count: 20)
    let productionRequestIds = (0..<21).map {
        String(format: "80500000-0000-4000-8000-%012d", $0 + 1)
    }
    for index in 0..<20 {
        let admission = productionRegistry.install(
            requestId: productionRequestIds[index], attemptEpoch: 1,
            lifecycleEpoch: productionEpoch,
            start: { _ in
                productionStartOrder.append(index)
                productionCredentialUses[index] += 1
                let task = ProviderRetainedTaskStub()
                productionTasks[index] = task
                _ = try! productionRegistry.beginNetwork(
                    requestId: productionRequestIds[index], attemptEpoch: 1,
                    lifecycleEpoch: productionEpoch, withAuthority: { _ = $0(task) }
                )
            },
            cancellation: { _, _ in }
        )
        providerTestRequire(
            admission == (index < 4 ? .active : .queued),
            "production 4+16 admission changed at index \(index)"
        )
    }
    providerTestRequire(productionRegistry.install(
        requestId: productionRequestIds[20], attemptEpoch: 1,
        lifecycleEpoch: productionEpoch, start: { _ in }, cancellation: { _, _ in }
    ) == .capacityRejected, "production 21st provider operation was not rejected")
    providerTestRequire(productionRegistry.install(
        requestId: productionRequestIds[19], attemptEpoch: 1,
        lifecycleEpoch: productionEpoch, start: { _ in }, cancellation: { _, _ in }
    ) == .duplicate, "duplicate admission was conflated with production capacity")
    providerTestRequire(
        productionStartOrder == [0, 1, 2, 3] &&
            productionCredentialUses[4...19].allSatisfy { $0 == 0 } &&
            productionTasks[4...19].allSatisfy { $0 == nil },
        "production queue resolved credentials or created tasks before promotion"
    )
    weak let releasedCompletedProductionTask = productionTasks[0]
    weak let releasedCanceledProductionTask = productionTasks[2]
    providerTestRequire(productionRegistry.claimCompletion(
        requestId: productionRequestIds[0], attemptEpoch: 1, lifecycleEpoch: productionEpoch
    ), "first production active operation could not complete")
    providerTestRequire(productionRegistry.claimCompletion(
        requestId: productionRequestIds[1], attemptEpoch: 1, lifecycleEpoch: productionEpoch
    ), "second production active operation could not complete")
    providerTestRequire(
        productionStartOrder == [0, 1, 2, 3, 4, 5] &&
            productionCredentialUses[4] == 1 && productionCredentialUses[5] == 1 &&
            productionCredentialUses[6...19].allSatisfy { $0 == 0 },
        "multiple production queued operations did not promote FIFO"
    )
    productionTasks[0] = nil
    productionTasks[1] = nil
    providerTestRequire(
        releasedCompletedProductionTask == nil,
        "completed production operation retained its credential-bearing task"
    )
    productionRegistry.cancelAllAndFence()
    providerTestRequire(
        [2, 3, 4, 5].allSatisfy { productionTasks[$0]?.cancelCount == 1 },
        "production lifecycle cleanup did not cancel every active task exactly once"
    )
    providerTestRequire(
        productionStartOrder == [0, 1, 2, 3, 4, 5] &&
            productionRequestIds[0..<20].allSatisfy { !productionRegistry.cancel(requestId: $0) },
        "production lifecycle cleanup retained active or queued registry resources"
    )
    providerTestRequire(productionRegistry.install(
        requestId: productionRequestIds[20], attemptEpoch: 1,
        lifecycleEpoch: productionEpoch, start: { _ in }, cancellation: { _, _ in }
    ) == .lifecycleUnavailable, "lifecycle-unavailable admission was conflated with duplicate work")
    for index in productionTasks.indices { productionTasks[index] = nil }
    providerTestRequire(
        releasedCanceledProductionTask == nil,
        "production lifecycle cleanup retained a credential-bearing task"
    )

    let deadlineRegistry = ProviderTaskRegistry(maximumConcurrent: 1, maximumQueued: 1, totalDeadline: 0.05)
    let deadlineEpoch = deadlineRegistry.lifecycleSnapshot()!
    let deadlineBlocker = ProviderRetainedTaskStub()
    _ = deadlineRegistry.install(
        requestId: "81000000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: deadlineEpoch,
        start: { _ in
            _ = try! deadlineRegistry.beginNetwork(
                requestId: "81000000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: deadlineEpoch, withAuthority: { _ = $0(deadlineBlocker) }
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

    var beforeResumeUptime: TimeInterval = 2_000
    let beforeResumeRegistry = ProviderTaskRegistry(
        maximumConcurrent: 1, maximumQueued: 1, totalDeadline: 60,
        now: { beforeResumeUptime }
    )
    let beforeResumeEpoch = beforeResumeRegistry.lifecycleSnapshot()!
    let beforeResumeTask = ProviderRetainedTaskStub()
    var beforeResumeActiveStarted: Bool?
    var beforeResumeFailure: String?
    var beforeResumeQueuedStarts = 0
    let beforeResumeRequest = "81000000-0000-4000-8000-000000000003"
    providerTestRequire(beforeResumeRegistry.install(
        requestId: beforeResumeRequest, attemptEpoch: 1, lifecycleEpoch: beforeResumeEpoch,
        start: { _ in },
        cancellation: { started, failure in
            beforeResumeActiveStarted = started
            beforeResumeFailure = failure.code
        }
    ) == .active, "deadline-boundary operation was not admitted active")
    beforeResumeUptime = 2_001
    providerTestRequire(beforeResumeRegistry.install(
        requestId: "81000000-0000-4000-8000-000000000004", attemptEpoch: 1,
        lifecycleEpoch: beforeResumeEpoch,
        start: { _ in beforeResumeQueuedStarts += 1 },
        cancellation: { _, _ in }
    ) == .queued, "deadline-boundary follower was not queued")
    let beforeResumeStarted = try beforeResumeRegistry.beginNetwork(
        requestId: beforeResumeRequest, attemptEpoch: 1,
        lifecycleEpoch: beforeResumeEpoch
    ) { resume in
        // Models the synchronous begin_generation_command transaction crossing the exact deadline.
        beforeResumeUptime = 2_060
        _ = resume(beforeResumeTask)
    }
    if !beforeResumeStarted { beforeResumeTask.cancel() }
    providerTestRequire(
        !beforeResumeStarted && beforeResumeTask.resumeCount == 0 && beforeResumeTask.cancelCount == 1,
        "task resumed or leaked after beforeResume crossed the monotonic deadline"
    )
    providerTestRequire(
        beforeResumeActiveStarted == false && beforeResumeFailure == "timeout" && beforeResumeQueuedStarts == 1,
        "post-transaction deadline did not classify the unresumed task as not started and promote the FIFO follower"
    )
    providerTestRequire(
        !beforeResumeRegistry.cancel(requestId: beforeResumeRequest),
        "post-transaction deadline left the expired operation registered"
    )
    beforeResumeRegistry.cancelAllAndFence()

    var controlledUptime: TimeInterval = 1_000
    var controlledWallClock: TimeInterval = 5_000
    let lateRegistry = ProviderTaskRegistry(
        maximumConcurrent: 1, maximumQueued: 1, totalDeadline: 60,
        now: { controlledUptime }
    )
    let lateEpoch = lateRegistry.lifecycleSnapshot()!
    var lateTask: ProviderRetainedTaskStub? = ProviderRetainedTaskStub()
    weak let releasedLateTask = lateTask
    var lateFailure: String?
    _ = lateRegistry.install(
        requestId: "81100000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: lateEpoch,
        start: { _ in
            guard let task = lateTask else { fatalError("credential-bearing task released before start") }
            _ = try! lateRegistry.beginNetwork(
                requestId: "81100000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: lateEpoch, withAuthority: { _ = $0(task) }
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
    controlledWallClock = -50_000
    controlledUptime = 1_060
    providerTestRequire(
        !lateRegistry.claimCompletion(
            requestId: "81100000-0000-4000-8000-000000000001", attemptEpoch: 1,
            lifecycleEpoch: lateEpoch
        ),
        "provider completion at the monotonic deadline was accepted after wall-clock rollback and delayed timer delivery"
    )
    let lateTaskCancelCount = lateTask?.cancelCount
    lateTask = nil
    providerTestRequire(
        controlledWallClock == -50_000 && lateFailure == "timeout" && lateTaskCancelCount == 1 &&
            lateQueuedFailure == "timeout" && lateQueuedStarts == 0,
        "wall-clock rollback changed monotonic expiry or promoted queued work"
    )
    providerTestRequire(
        releasedLateTask == nil,
        "deadline registry retained a credential-bearing task after monotonic expiry"
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
                requestId: "82900000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: cancellationEpoch, withAuthority: { _ = $0(cancellationBlocker) }
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
                requestId: "83000000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: sqliteEpoch, withAuthority: { _ = $0(sqliteBlocker) }
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
            failure.code == "canceled" && !failure.retryable,
            "abandoned queued begin did not return the sanitized authority fence \(failure.code)"
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

    let duplicatePayload = ProviderGeneratePayload(
        roomId: payload.roomId, sourceEventSequence: payload.sourceEventSequence,
        personaSlug: payload.personaSlug, messages: payload.messages, model: payload.model,
        temperature: payload.temperature, maxOutputTokens: payload.maxOutputTokens,
        profileId: payload.profileId, profileRevision: payload.profileRevision,
        providerId: payload.providerId,
        requestId: "84000000-0000-4000-8000-000000000002", kind: "provider"
    )
    let duplicatePlanData = try JSONEncoder().encode(duplicatePayload)
    let duplicatePlan = String(decoding: duplicatePlanData, as: UTF8.self)
    let duplicateDigest = SHA256.hash(data: duplicatePlanData).map { String(format: "%02x", $0) }.joined()
    let duplicateCommand = ProviderCommandPayload(
        requestId: duplicatePayload.requestId,
        commandId: "84000000-0000-4000-8000-000000000003", requestDigest: duplicateDigest
    )
    _ = try database.executeBatch(transactionId: "provider-duplicate-command", statements: [[
        "sqlId": "prepare_generation_command",
        "parameters": [
            duplicateCommand.commandId, duplicateCommand.requestId, duplicateDigest, duplicatePlan,
            "{\"participantId\":\"human-1\",\"text\":\"duplicate\",\"type\":\"human_message\"}",
            "{\"generation\":0,\"reason\":\"directed\",\"sourceEventSequence\":1,\"speaker\":\"ada-lovelace\",\"type\":\"director_decision\"}",
            directorState, 0, 1, payload.personaSlug, payload.roomId, 0, 1,
            payload.personaSlug, duplicatePlan, payload.personaSlug, duplicatePlan,
            duplicatePlan, duplicatePlan, duplicatePlan, duplicatePlan,
        ],
    ]])
    let duplicateRegistry = ProviderTaskRegistry(maximumConcurrent: 1, maximumQueued: 1)
    let duplicateEpoch = duplicateRegistry.lifecycleSnapshot()!
    let duplicateBlocker = ProviderRetainedTaskStub()
    _ = duplicateRegistry.install(
        requestId: "84900000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: duplicateEpoch,
        start: { _ in
            _ = try! duplicateRegistry.beginNetwork(
                requestId: "84900000-0000-4000-8000-000000000001",
                attemptEpoch: 1, lifecycleEpoch: duplicateEpoch, withAuthority: { _ = $0(duplicateBlocker) }
            )
        }, cancellation: { _, _ in }
    )
    let duplicateService = GreenRoomProviderService(
        authority: authority, configuration: configuration, registry: duplicateRegistry
    )
    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"], chunks: [successBody]
    ))
    let originalDuplicateSemaphore = DispatchSemaphore(value: 0)
    var originalDuplicateResult: Result<String, DatabaseFailure>?
    duplicateService.generate(duplicateCommand) { result in
        originalDuplicateResult = result
        originalDuplicateSemaphore.signal()
    }
    let rejectedDuplicateSemaphore = DispatchSemaphore(value: 0)
    var rejectedDuplicateResult: Result<String, DatabaseFailure>?
    duplicateService.generate(duplicateCommand) { result in
        rejectedDuplicateResult = result
        rejectedDuplicateSemaphore.signal()
    }
    providerTestRequire(
        rejectedDuplicateSemaphore.wait(timeout: .now() + 1) == .success,
        "duplicate queued service call did not resolve"
    )
    if case .failure(let failure) = rejectedDuplicateResult {
        providerTestRequire(
            failure.code == "canceled" && failure.retryable,
            "duplicate queued service call returned the wrong failure"
        )
    } else { fatalError("duplicate queued service call was not rejected") }
    let duplicatePreparedRow = (try database.query(
        sqlId: "unresolved_generation_command", parameters: [payload.roomId]
    ))["rows"] as? [[Any]]
    let duplicatePreparedJSON = duplicatePreparedRow?.first?.first as? String ?? ""
    providerTestRequire(
        duplicatePreparedJSON.contains("\"state\":\"prepared\"") &&
            duplicatePreparedJSON.contains("\"attemptEpoch\":0") &&
            duplicatePreparedJSON.contains("\"failureCode\":null"),
        "duplicate queued service call corrupted the original prepared durable command"
    )
    providerTestRequire(
        ProviderURLProtocolStub.capturedRequests.isEmpty,
        "duplicate queued service call started provider network activity"
    )
    providerTestRequire(duplicateRegistry.claimCompletion(
        requestId: "84900000-0000-4000-8000-000000000001", attemptEpoch: 1,
        lifecycleEpoch: duplicateEpoch
    ), "duplicate regression blocker could not complete")
    providerTestRequire(
        originalDuplicateSemaphore.wait(timeout: .now() + 1) == .success,
        "authoritative queued generation did not promote"
    )
    if case .success(let text) = originalDuplicateResult {
        providerTestRequire(text == "A bounded answer.", "authoritative queued result changed")
    } else { fatalError("authoritative queued generation did not succeed") }
    let duplicateRemainsAuthoritative = try database.generationCommandIsInFlight(
        commandId: duplicateCommand.commandId, requestId: duplicateCommand.requestId,
        requestDigest: duplicateCommand.requestDigest, attemptEpoch: 1
    )
    providerTestRequire(
        ProviderURLProtocolStub.capturedRequests.count == 1 && duplicateRemainsAuthoritative,
        "authoritative queued generation lost durable authority or issued duplicate network requests"
    )
    try database.interruptGenerationCommand(
        requestId: duplicateCommand.requestId, attemptEpoch: 1, failureCode: "canceled"
    )
}

private extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}
