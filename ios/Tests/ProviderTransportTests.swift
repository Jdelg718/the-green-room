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
        profileId: "openrouter.primary"
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
        maxOutputTokens: payload.maxOutputTokens, profileId: "openai.primary"
    )
    let openAIBody = try JSONSerialization.jsonObject(with: openAITransport.requestBody(openAIPayload)) as! [String: Any]
    providerTestRequire(openAIBody["model"] as? String == "gpt-4.1-mini", "OpenAI model ID was prefixed or rewritten")

    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"],
        chunks: [Data(repeating: 0x78, count: 64 * 1024), Data([0x78])]
    ))
    expectProviderFailure("response_too_large", transport, payload: payload, label: "response-cap")

    let closedEnvelope: [String: Any] = [
        "contractVersion": bridgeContractVersion,
        "callId": "20000000-0000-4000-8000-000000000002",
        "method": "provider.generate",
        "payload": [
            "roomId": payload.roomId,
            "sourceEventSequence": payload.sourceEventSequence,
            "personaSlug": payload.personaSlug,
            "messages": payload.messages.map { ["role": $0.role, "content": $0.content] },
            "model": payload.model,
            "temperature": payload.temperature,
            "maxOutputTokens": payload.maxOutputTokens,
            "profileId": payload.profileId,
        ],
    ]
    let encoded = try JSONSerialization.data(withJSONObject: closedEnvelope)
    providerTestRequire(try ProviderBridgeCodec.decodeGenerate(encoded).payload == payload, "closed bridge decode mismatch")
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
    _ = try authority.openDatabase(expectedSchema: 6)
    _ = try database.executeBatch(transactionId: "provider-room", statements: [
        ["sqlId": "create_room", "parameters": [payload.roomId, "Provider room"]],
        ["sqlId": "create_human", "parameters": ["human-1", payload.roomId, "You"]],
        ["sqlId": "create_persona", "parameters": [payload.personaSlug, payload.roomId, "Ada Lovelace", 1, payload.personaSlug]],
        ["sqlId": "create_director_state", "parameters": [payload.roomId]],
        ["sqlId": "select_room", "parameters": [payload.roomId]],
    ])
    let directorState = "{\"acceptedHumanEventNumber\":1,\"autonomousTurns\":1,\"cancelled\":false,\"fallbackIndex\":0,\"lastSelectedAt\":[[\"ada-lovelace\",1]],\"maxAutonomousTurns\":10,\"seen\":[],\"version\":1}"
    _ = try database.executeBatch(transactionId: "provider-decision", statements: [
        ["sqlId": "update_director_state", "parameters": [directorState, 1, payload.personaSlug, payload.personaSlug, 1, 0, payload.roomId, 0, 1]],
        ["sqlId": "append_event", "parameters": ["{\"participantId\":\"human-1\",\"text\":\"hello\",\"type\":\"human_message\"}", payload.roomId]],
        ["sqlId": "append_event", "parameters": ["{\"generation\":0,\"reason\":\"directed\",\"sourceEventSequence\":1,\"speaker\":\"ada-lovelace\",\"type\":\"director_decision\"}", payload.roomId]],
    ])
    let reservation = CredentialMutationRequest(
        profileId: payload.profileId, profileRevision: 1, providerId: "openrouter",
        credentialRef: "credential:openrouter.primary:1",
        mutationId: "30000000-0000-4000-8000-000000000003"
    )
    _ = try database.executeBatch(transactionId: "provider-profile", statements: [
        ["sqlId": "create_connection_profile_revision", "parameters": [payload.profileId, 1, "openrouter", NSNull()]],
        ["sqlId": "reserve_credential", "parameters": reservation.baseIdentityParameters + [NSNull(), reservation.mutationId]],
    ])
    var credential = Data("native-test-value".utf8)
    _ = try authority.credentials.completeSave(reservation, secret: &credential)
    let directedAuthority = try database.providerRequestAuthority(
        roomId: payload.roomId,
        sourceEventSequence: payload.sourceEventSequence,
        personaSlug: payload.personaSlug,
        profileId: payload.profileId
    )
    providerTestRequire(
        directedAuthority.reservation.profileId == payload.profileId,
        "directed decision did not authorize its selected provider persona"
    )
    _ = try authority.closeDatabase()
    var raw: OpaquePointer?
    providerTestRequire(
        sqlite3_open_v2(fenceRoot.appendingPathComponent("greenroom.sqlite").path, &raw, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
        "could not open changed-generation fixture"
    )
    providerTestRequire(
        sqlite3_exec(raw, "UPDATE rooms SET generation = generation + 1", nil, nil, nil) == SQLITE_OK,
        "could not change room generation"
    )
    sqlite3_close_v2(raw)
    _ = try authority.openDatabase(expectedSchema: 6)
    ProviderURLProtocolStub.install(.response(
        status: 200, headers: ["Content-Type": "application/json"], chunks: [successBody]
    ))
    let fenceService = GreenRoomProviderService(authority: authority, configuration: configuration)
    let fenceSemaphore = DispatchSemaphore(value: 0)
    var fenceResult: Result<String, DatabaseFailure>?
    fenceService.generate(payload) { result in fenceResult = result; fenceSemaphore.signal() }
    providerTestRequire(fenceSemaphore.wait(timeout: .now() + 1) == .success, "generation fence did not resolve")
    if case .failure(let failure) = fenceResult {
        providerTestRequire(failure.code == "canceled", "changed generation was not refused")
    } else {
        fatalError("changed generation reached provider")
    }
    providerTestRequire(ProviderURLProtocolStub.capturedRequests.isEmpty, "changed generation reached network")
}

private extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}
