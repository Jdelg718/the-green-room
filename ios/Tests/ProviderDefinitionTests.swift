import Foundation

private final class RecordingProviderDefinitionTransport: ProviderDefinitionTransport {
    private(set) var records: [(ApprovedProviderDefinition, ApprovedProviderEndpoint)] = []

    func recordValidated(
        definition: ApprovedProviderDefinition,
        endpoint: ApprovedProviderEndpoint
    ) throws {
        records.append((definition, endpoint))
    }
}

private func providerRequire(_ condition: Bool, _ message: String) {
    if !condition { fatalError(message) }
}

private func expectProviderFailure(
    _ expected: ProviderDefinitionValidationError,
    transport: RecordingProviderDefinitionTransport,
    _ operation: () throws -> Void
) {
    let callsBefore = transport.records.count
    do {
        try operation()
        fatalError("expected provider definition validation failure")
    } catch let failure as ProviderDefinitionValidationError {
        providerRequire(failure == expected, "unexpected provider definition failure")
    } catch {
        fatalError("unexpected provider definition error: \(error)")
    }
    providerRequire(
        transport.records.count == callsBefore,
        "invalid provider destination reached the transport seam"
    )
}

private let providerFixtureKeys: Set<String> = [
    "id", "version", "adapter", "scheme", "hostname", "port", "basePath",
    "modelsPath", "chatPath", "authorization", "outputTokenField", "modelParser",
]

private struct FixtureProviderAuthorization: Equatable {
    let scheme: String
    let header: String
}

private struct FixtureProviderDefinition: Equatable {
    let id: ApprovedProviderID
    let version: Int
    let adapter: String
    let scheme: String
    let hostname: String
    let port: Int
    let basePath: String
    let modelsPath: String
    let chatPath: String
    let authorization: FixtureProviderAuthorization
    let outputTokenField: String
    let modelParser: String

    func matches(_ definition: ApprovedProviderDefinition) -> Bool {
        id == definition.id
            && version == definition.version
            && adapter == definition.adapter
            && scheme == definition.scheme
            && hostname == definition.hostname
            && port == definition.port
            && basePath == definition.basePath
            && modelsPath == definition.modelsPath
            && chatPath == definition.chatPath
            && authorization.scheme == definition.authorization.scheme
            && authorization.header == definition.authorization.header
            && outputTokenField == definition.outputTokenField
            && modelParser == definition.modelParser
    }
}

private func fixtureDefinition(_ value: Any) -> FixtureProviderDefinition {
    guard let object = value as? [String: Any], Set(object.keys) == providerFixtureKeys,
          let rawID = object["id"] as? String,
          let id = ApprovedProviderID(rawValue: rawID),
          let authorization = object["authorization"] as? [String: Any],
          Set(authorization.keys) == Set(["scheme", "header"]),
          let version = object["version"] as? Int,
          let adapter = object["adapter"] as? String,
          let scheme = object["scheme"] as? String,
          let hostname = object["hostname"] as? String,
          let port = object["port"] as? Int,
          let basePath = object["basePath"] as? String,
          let modelsPath = object["modelsPath"] as? String,
          let chatPath = object["chatPath"] as? String,
          let authorizationScheme = authorization["scheme"] as? String,
          let authorizationHeader = authorization["header"] as? String,
          let outputTokenField = object["outputTokenField"] as? String,
          let modelParser = object["modelParser"] as? String else {
        fatalError("provider fixture contains unknown, missing, or mistyped fields")
    }
    return FixtureProviderDefinition(
        id: id, version: version, adapter: adapter, scheme: scheme,
        hostname: hostname, port: port, basePath: basePath,
        modelsPath: modelsPath, chatPath: chatPath,
        authorization: FixtureProviderAuthorization(
            scheme: authorizationScheme, header: authorizationHeader
        ),
        outputTokenField: outputTokenField, modelParser: modelParser
    )
}

func runProviderDefinitionTests() throws {
    let fixtureURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("contracts/iphone-alpha-native-bridge-v1/provider-definitions.json")
    let fixtureValue = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL))
    guard let fixture = fixtureValue as? [Any] else {
        fatalError("provider fixture root must be an array")
    }
    providerRequire(fixture.count == 5, "provider fixture must contain exactly five definitions")
    let decoded = fixture.map(fixtureDefinition)
    providerRequire(
        zip(decoded, ApprovedProviderDefinitions.all).allSatisfy { fixture, definition in
            fixture.matches(definition)
        },
        "Swift definitions drifted from fixture"
    )
    providerRequire(
        ApprovedProviderID.allCases.map(\.rawValue) == [
            "openrouter", "openai", "xai", "groq", "together",
        ],
        "approved provider enum is not the closed canonical set"
    )

    let transport = RecordingProviderDefinitionTransport()
    expectProviderFailure(.unapprovedProvider, transport: transport) {
        try ApprovedProviderDefinitions.validateAndRecord(
            providerID: "custom", endpoint: .models,
            destination: ProviderDestination(
                scheme: "https", hostname: "custom.invalid", port: 443, path: "/v1/models"
            ), transport: transport
        )
    }

    for definition in ApprovedProviderDefinitions.all {
        for endpoint in [ApprovedProviderEndpoint.models, .chat] {
            let valid = ProviderDestination(
                scheme: definition.scheme, hostname: definition.hostname,
                port: definition.port, path: definition.path(for: endpoint)
            )
            for mismatched in [
                ProviderDestination(scheme: "http", hostname: valid.hostname, port: valid.port, path: valid.path),
                ProviderDestination(scheme: valid.scheme, hostname: "evil.invalid", port: valid.port, path: valid.path),
                ProviderDestination(scheme: valid.scheme, hostname: valid.hostname, port: 8443, path: valid.path),
                ProviderDestination(scheme: valid.scheme, hostname: valid.hostname, port: valid.port, path: "\(valid.path)/extra"),
            ] {
                expectProviderFailure(.destinationMismatch, transport: transport) {
                    try ApprovedProviderDefinitions.validateAndRecord(
                        providerID: definition.id.rawValue, endpoint: endpoint,
                        destination: mismatched, transport: transport
                    )
                }
            }
            try ApprovedProviderDefinitions.validateAndRecord(
                providerID: definition.id.rawValue, endpoint: endpoint,
                destination: valid, transport: transport
            )
        }
    }
    providerRequire(transport.records.count == 10, "valid destinations did not reach recording seam")
}
