import Foundation

enum ApprovedProviderID: String, CaseIterable, Sendable {
    case openrouter
    case openai
    case xai
    case groq
    case together
}

enum ApprovedProviderEndpoint: Sendable {
    case models
    case chat
}

enum ProviderDefinitionValidationError: Error, Equatable {
    case unapprovedProvider
    case destinationMismatch
}

struct ApprovedProviderAuthorization: Equatable, Sendable {
    let scheme: String
    let header: String
}

struct ApprovedProviderDefinition: Equatable, Sendable {
    let id: ApprovedProviderID
    let version: Int
    let adapter: String
    let scheme: String
    let hostname: String
    let port: Int
    let basePath: String
    let modelsPath: String
    let chatPath: String
    let authorization: ApprovedProviderAuthorization
    let outputTokenField: String
    let modelParser: String

    fileprivate init(
        id: ApprovedProviderID,
        version: Int,
        adapter: String,
        scheme: String,
        hostname: String,
        port: Int,
        basePath: String,
        modelsPath: String,
        chatPath: String,
        authorization: ApprovedProviderAuthorization,
        outputTokenField: String,
        modelParser: String
    ) {
        self.id = id
        self.version = version
        self.adapter = adapter
        self.scheme = scheme
        self.hostname = hostname
        self.port = port
        self.basePath = basePath
        self.modelsPath = modelsPath
        self.chatPath = chatPath
        self.authorization = authorization
        self.outputTokenField = outputTokenField
        self.modelParser = modelParser
    }

    func path(for endpoint: ApprovedProviderEndpoint) -> String {
        switch endpoint {
        case .models: modelsPath
        case .chat: chatPath
        }
    }
}

struct ProviderDestination: Equatable, Sendable {
    let scheme: String
    let hostname: String
    let port: Int
    let path: String
}

protocol ProviderDefinitionTransport {
    func recordValidated(
        definition: ApprovedProviderDefinition,
        endpoint: ApprovedProviderEndpoint
    ) throws
}

enum ApprovedProviderDefinitions {
    private static let bearer = ApprovedProviderAuthorization(
        scheme: "Bearer", header: "authorization"
    )

    static let openrouter = ApprovedProviderDefinition(
        id: .openrouter, version: 1, adapter: "openai-compatible",
        scheme: "https", hostname: "openrouter.ai", port: 443,
        basePath: "/api/v1", modelsPath: "/api/v1/models",
        chatPath: "/api/v1/chat/completions", authorization: bearer,
        outputTokenField: "max_tokens", modelParser: "data-id"
    )
    static let openai = ApprovedProviderDefinition(
        id: .openai, version: 1, adapter: "openai-compatible",
        scheme: "https", hostname: "api.openai.com", port: 443,
        basePath: "/v1", modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions", authorization: bearer,
        outputTokenField: "max_completion_tokens", modelParser: "data-id"
    )
    static let xai = ApprovedProviderDefinition(
        id: .xai, version: 1, adapter: "openai-compatible",
        scheme: "https", hostname: "api.x.ai", port: 443,
        basePath: "/v1", modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions", authorization: bearer,
        outputTokenField: "max_tokens", modelParser: "data-id"
    )
    static let groq = ApprovedProviderDefinition(
        id: .groq, version: 1, adapter: "openai-compatible",
        scheme: "https", hostname: "api.groq.com", port: 443,
        basePath: "/openai/v1", modelsPath: "/openai/v1/models",
        chatPath: "/openai/v1/chat/completions", authorization: bearer,
        outputTokenField: "max_completion_tokens", modelParser: "data-id"
    )
    static let together = ApprovedProviderDefinition(
        id: .together, version: 1, adapter: "openai-compatible",
        scheme: "https", hostname: "api.together.ai", port: 443,
        basePath: "/v1", modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions", authorization: bearer,
        outputTokenField: "max_tokens", modelParser: "array-id"
    )

    static let all: [ApprovedProviderDefinition] = [
        openrouter, openai, xai, groq, together,
    ]

    static func definition(for providerID: ApprovedProviderID) -> ApprovedProviderDefinition {
        switch providerID {
        case .openrouter: openrouter
        case .openai: openai
        case .xai: xai
        case .groq: groq
        case .together: together
        }
    }

    static func validateAndRecord(
        providerID rawProviderID: String,
        endpoint: ApprovedProviderEndpoint,
        destination: ProviderDestination,
        transport: ProviderDefinitionTransport
    ) throws {
        guard let providerID = ApprovedProviderID(rawValue: rawProviderID) else {
            throw ProviderDefinitionValidationError.unapprovedProvider
        }
        let approved = definition(for: providerID)
        guard destination.scheme == approved.scheme,
              destination.hostname == approved.hostname,
              destination.port == approved.port,
              destination.path == approved.path(for: endpoint) else {
            throw ProviderDefinitionValidationError.destinationMismatch
        }
        try transport.recordValidated(definition: approved, endpoint: endpoint)
    }
}
