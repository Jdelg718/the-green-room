import Foundation

struct Header: Decodable {
    let contractVersion: String
    let schema: String
    let schemaVersion: String
}

struct RoomSnapshot: Decodable {
    struct Room: Decodable {
        struct Participant: Decodable {
            let id: String
            let sourceType: String
            let displayName: String
            let muted: Bool
            let role: String
            let lifecycle: String
            let personaSlug: String?
        }
        let id: String
        let sessionId: String
        let title: String
        let status: String
        let generation: String
        let headCursor: String
        let participants: [Participant]
    }
    let snapshotId: String
    let capturedAt: String
    let room: Room
}

struct EventPage: Decodable {
    struct Envelope: Decodable {
        struct Source: Decodable {
            let type: String
            let participantId: String?
            let displayName: String
            let personaSlug: String?
        }
        struct Payload: Decodable {
            let type: String
            let text: String?
            let sourceEventPosition: String?
            let directorEventPosition: String?
            let speakerParticipantId: String?
            let reason: String?
        }
        let eventId: String
        let position: String
        let occurredAt: String
        let criticality: String
        let source: Source
        let event: Payload
    }
    let roomId: String
    let afterCursor: String
    let nextCursor: String
    let authorityHeadCursor: String
    let hasMore: Bool
    let events: [Envelope]
}

struct CommandResultSet: Decodable {
    struct Result: Decodable {
        struct Failure: Decodable {
            let code: String
            let message: String
            let retryable: Bool
        }
        let commandId: String
        let state: String
        let receivedAt: String
        let pollAfterMilliseconds: Int?
        let eventPositions: [String]?
        let error: Failure?
    }
    let results: [Result]
}

struct Capabilities: Decodable {
    struct CatchUp: Decodable {
        let pageSizeMaximum: Int
        let declaresAuthorityHead: Bool
        let declaresRetentionGap: Bool
    }
    struct Transport: Decodable {
        let httpCatchUp: Bool
        let foregroundSse: Bool
        let offlineMutation: Bool
    }
    let authorityId: String
    let authorityRole: String
    let supportedContractMajors: [Int]
    let minimumMutationVersion: String
    let maximumMutationVersion: String
    let eventPositionEncoding: String
    let timestampEncoding: String
    let catchUp: CatchUp
    let transport: Transport
    let knownRequiredExtensions: [String]
}

struct CatchUpGap: Decodable {
    let roomId: String
    let requestedAfterCursor: String
    let earliestAvailableCursor: String
    let authorityHeadCursor: String
    let snapshotRequired: Bool
    let reason: String
}

struct InvitationPlaceholders: Decodable {
    struct State: Decodable {
        let state: String
        let at: String
    }
    let implementationStatus: String
    let roomId: String
    let invitationId: String
    let states: [State]
    let notes: String
}

struct CompatibilityCases: Decodable {
    struct Case: Decodable {
        let name: String
        let expected: String
        let clientVersion: String?
        let authorityCapabilitiesFixture: String?
    }
    let cases: [Case]
}

enum ProofError: Error, CustomStringConvertible {
    case invalid(String)
    var description: String {
        switch self { case .invalid(let message): return message }
    }
}

let versionPattern = try NSRegularExpression(pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
let timestampPattern = try NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw ProofError.invalid(message) }
}

func parseVersion(_ value: String, _ path: String) throws -> (major: Int, minor: Int) {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    try require(versionPattern.firstMatch(in: value, range: range) != nil, "\(path) is not canonical major.minor")
    let parts = value.split(separator: ".").compactMap { Int($0) }
    try require(parts.count == 2, "\(path) is not canonical major.minor")
    return (parts[0], parts[1])
}

func validateVersion(_ value: String, _ path: String) throws {
    _ = try parseVersion(value, path)
}

func position(_ value: String, _ path: String) throws -> UInt64 {
    try require(value == "0" || (value.first != "0" && value.allSatisfy(\.isNumber)), "\(path) is not canonical decimal")
    guard let parsed = UInt64(value) else { throw ProofError.invalid("\(path) exceeds uint64") }
    return parsed
}

func validateTimestamp(_ value: String, _ path: String) throws {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    let parser = DateFormatter()
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.calendar = Calendar(identifier: .gregorian)
    parser.timeZone = TimeZone(secondsFromGMT: 0)
    parser.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    parser.isLenient = false
    guard
        timestampPattern.firstMatch(in: value, range: range) != nil,
        let date = parser.date(from: value)
    else { throw ProofError.invalid("\(path) is not RFC3339 UTC milliseconds") }
    try require(parser.string(from: date) == value, "\(path) is not canonical RFC3339 UTC milliseconds")
}

func validateString(_ value: String, _ path: String, maximumBytes: Int, allowNewlines: Bool = false) throws {
    try require(!value.isEmpty && value == value.trimmingCharacters(in: .whitespacesAndNewlines), "\(path) is not canonical")
    try require(value.lengthOfBytes(using: .utf8) <= maximumBytes, "\(path) exceeds UTF-8 bound")
    if !allowNewlines {
        try require(value.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value != 0x7f }, "\(path) contains controls")
    }
}

func validateIdentifier(_ value: String, _ path: String) throws {
    try validateString(value, path, maximumBytes: 256)
}

func validateText(_ value: String, _ path: String) throws {
    try validateString(value, path, maximumBytes: 16_384, allowNewlines: true)
}

func classifyCompatibilityCase(_ item: [String: Any]) throws -> String {
    if let clientVersion = item["clientVersion"] as? String {
        guard
            let capabilities = item["authorityCapabilities"] as? [String: Any],
            let minimum = capabilities["minimumMutationVersion"] as? String,
            let maximum = capabilities["maximumMutationVersion"] as? String
        else { throw ProofError.invalid("old-client case is incomplete") }
        let clientParts = clientVersion.split(separator: ".").compactMap { Int($0) }
        let minimumParts = minimum.split(separator: ".").compactMap { Int($0) }
        let maximumParts = maximum.split(separator: ".").compactMap { Int($0) }
        try require(clientParts.count == 2 && minimumParts.count == 2 && maximumParts.count == 2, "mutation versions are invalid")
        if clientParts[0] != minimumParts[0] { return "unsupported" }
        let client = clientParts[0] * 1_000_000 + clientParts[1]
        let lower = minimumParts[0] * 1_000_000 + minimumParts[1]
        let upper = maximumParts[0] * 1_000_000 + maximumParts[1]
        return (lower...upper).contains(client) ? "read_write" : "read_only"
    }
    guard
        let document = item["document"] as? [String: Any],
        let contractVersion = document["contractVersion"] as? String,
        let schema = document["schema"] as? String
    else { throw ProofError.invalid("compatibility document is incomplete") }
    let contract = try parseVersion(contractVersion, "compatibility.contractVersion")
    if contract.major != 1 { return "unsupported" }
    guard let schemaVersionValue = document["schemaVersion"] as? String else {
        throw ProofError.invalid("compatibility schema version is missing")
    }
    let schemaVersion = try parseVersion(schemaVersionValue, "compatibility.schemaVersion")
    if schemaVersion.major != 1 { return "unsupported" }
    if schemaVersion.minor > 0 { return "read_only" }
    if schema == "greenroom.catch_up_gap" {
        let extensions = document["extensions"] as? [String: Any] ?? [:]
        let hasUnknownRequired = extensions.values.contains { value in
            (value as? [String: Any])?["required"] as? Bool == true
        }
        return hasUnknownRequired ? "read_only" : "read_write"
    }
    if schema == "greenroom.event_page" {
        guard
            let events = document["events"] as? [[String: Any]],
            let envelope = events.first,
            let payload = envelope["event"] as? [String: Any],
            let eventType = payload["type"] as? String
        else { throw ProofError.invalid("compatibility event is incomplete") }
        let knownEvents = Set(["human_message", "persona_message", "director_decision", "system_notice", "room_started"])
        if knownEvents.contains(eventType) { return "read_write" }
        return envelope["criticality"] as? String == "mandatory" ? "unsupported" : "read_only"
    }
    return document["schemaCriticality"] as? String == "mandatory" ? "unsupported" : "read_only"
}

let fixtureDirectory: URL
if CommandLine.arguments.count == 2 {
    fixtureDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
} else {
    fixtureDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .deletingLastPathComponent()
        .appendingPathComponent("fixtures", isDirectory: true)
}

let files = [
    "room-snapshot.json",
    "event-page.json",
    "command-results.json",
    "capability-negotiation.json",
    "catch-up-gap.json",
    "invitation-lifecycle-placeholders.json",
    "unknown-compatibility.json",
]
let decoder = JSONDecoder()

for filename in files {
    let data = try Data(contentsOf: fixtureDirectory.appendingPathComponent(filename))
    let header = try decoder.decode(Header.self, from: data)
    let contract = try parseVersion(header.contractVersion, "\(filename).contractVersion")
    let schemaVersion = try parseVersion(header.schemaVersion, "\(filename).schemaVersion")
    try require(contract.major == 1, "\(filename) has unsupported contract major")
    try require(schemaVersion.major == 1 && schemaVersion.minor == 0, "\(filename) has unsupported schema version")
    switch header.schema {
    case "greenroom.room_snapshot":
        let value = try decoder.decode(RoomSnapshot.self, from: data)
        _ = try position(value.room.generation, "room.generation")
        _ = try position(value.room.headCursor, "room.headCursor")
        try validateTimestamp(value.capturedAt, "capturedAt")
        try validateIdentifier(value.snapshotId, "snapshotId")
        try validateIdentifier(value.room.id, "room.id")
        try validateIdentifier(value.room.sessionId, "room.sessionId")
        try validateString(value.room.title, "room.title", maximumBytes: 512)
        try require(["active", "paused", "stopped"].contains(value.room.status), "unknown room status")
        try require(!value.room.participants.isEmpty && value.room.participants.count <= 256, "participant count is invalid")
        let participantIds = value.room.participants.map(\.id)
        try require(Set(participantIds).count == participantIds.count, "participant IDs are not unique")
        for participant in value.room.participants {
            try validateIdentifier(participant.id, "participant.id")
            try validateString(participant.displayName, "participant.displayName", maximumBytes: 256)
            try require(["ai_persona", "account_human", "guest_human"].contains(participant.sourceType), "unknown participant source")
            try require(["owner", "admin", "member"].contains(participant.role), "unknown participant role")
            try require(["active", "removed", "invited_placeholder"].contains(participant.lifecycle), "unknown participant lifecycle")
            try require(participant.sourceType == "ai_persona" ? participant.personaSlug != nil : participant.personaSlug == nil, "persona provenance mismatch")
            if let slug = participant.personaSlug { try validateIdentifier(slug, "participant.personaSlug") }
        }
    case "greenroom.event_page":
        let value = try decoder.decode(EventPage.self, from: data)
        let after = try position(value.afterCursor, "afterCursor")
        var lastPosition = after
        try require(value.events.count <= 100, "event page exceeds 100 entries")
        let eventIds = value.events.map(\.eventId)
        try require(Set(eventIds).count == eventIds.count, "event IDs are not unique")
        var directorsByPosition: [UInt64: (source: UInt64, speaker: String)] = [:]
        for event in value.events {
            try validateIdentifier(event.eventId, "event.eventId")
            let found = try position(event.position, "event.position")
            let (expected, overflow) = lastPosition.addingReportingOverflow(1)
            try require(!overflow && found == expected, "event positions are not contiguous")
            lastPosition = found
            try validateTimestamp(event.occurredAt, "event.occurredAt")
            try require(["optional", "mandatory"].contains(event.criticality), "unknown event criticality")
            try validateString(event.source.displayName, "event.source.displayName", maximumBytes: 256)
            try require(["ai_persona", "account_human", "guest_human", "system"].contains(event.source.type), "unknown event source")
            if let participantId = event.source.participantId { try validateIdentifier(participantId, "event.source.participantId") }
            if event.source.type == "system" {
                try require(event.source.participantId == nil && event.source.personaSlug == nil, "system source claims participant identity")
            }
            if event.event.type == "human_message" {
                try require(["account_human", "guest_human"].contains(event.source.type), "human event has nonhuman source")
                try validateText(event.event.text ?? "", "event.text")
            } else if event.event.type == "persona_message" {
                try require(event.source.type == "ai_persona", "persona event has non-AI source")
                try validateText(event.event.text ?? "", "event.text")
                guard
                    let sourceValue = event.event.sourceEventPosition,
                    let directorValue = event.event.directorEventPosition
                else { throw ProofError.invalid("persona event lacks authority references") }
                let sourcePosition = try position(sourceValue, "event.sourceEventPosition")
                let directorPosition = try position(directorValue, "event.directorEventPosition")
                try require(sourcePosition < found && directorPosition < found, "persona references are not earlier")
                if let director = directorsByPosition[directorPosition] {
                    try require(director.source == sourcePosition && director.speaker == event.source.participantId, "persona source differs from selected speaker")
                } else {
                    try require(directorPosition <= after, "persona points to a missing director in this page")
                }
            } else if event.event.type == "director_decision" {
                try require(event.source.type == "system", "director event has nonsystem source")
                guard let sourceValue = event.event.sourceEventPosition else {
                    throw ProofError.invalid("director event lacks source reference")
                }
                let sourcePosition = try position(sourceValue, "event.sourceEventPosition")
                try require(sourcePosition < found, "director source is not earlier")
                let allowedReasons = Set(["selected", "room_not_active", "response_not_requested", "no_eligible_persona", "autonomous_budget_exhausted"])
                try require(allowedReasons.contains(event.event.reason ?? ""), "unknown director reason")
                let selected = event.event.reason == "selected"
                try require(selected == (event.event.speakerParticipantId != nil), "director reason and speaker diverge")
                if let speaker = event.event.speakerParticipantId {
                    try validateIdentifier(speaker, "director.speakerParticipantId")
                    directorsByPosition[found] = (sourcePosition, speaker)
                }
            } else if event.event.type == "system_notice" {
                try require(event.source.type == "system", "system notice has nonsystem source")
                try validateText(event.event.text ?? "", "event.text")
            } else {
                try require(event.event.type == "room_started" && event.source.type == "system", "unknown or misattributed event")
            }
        }
        let next = try position(value.nextCursor, "nextCursor")
        let head = try position(value.authorityHeadCursor, "authorityHeadCursor")
        try require(next == lastPosition, "nextCursor does not match the page")
        try require(next <= head && value.hasMore == (next < head), "page head semantics diverged")
    case "greenroom.command_result_set":
        let value = try decoder.decode(CommandResultSet.self, from: data)
        try require(!value.results.isEmpty && value.results.count <= 100, "command result count is invalid")
        try require(Set(value.results.map(\.state)) == Set(["pending", "acknowledged", "rejected"]), "command states diverged")
        let commandIds = value.results.map(\.commandId)
        try require(Set(commandIds).count == commandIds.count, "command IDs are not unique")
        for result in value.results {
            try validateIdentifier(result.commandId, "command.commandId")
            try validateTimestamp(result.receivedAt, "command.receivedAt")
            if result.state == "pending" {
                try require(result.pollAfterMilliseconds != nil && result.eventPositions == nil && result.error == nil, "pending command fields diverged")
                try require((1...300_000).contains(result.pollAfterMilliseconds ?? 0), "pending poll bound diverged")
            } else if result.state == "acknowledged" {
                try require(!(result.eventPositions ?? []).isEmpty && result.pollAfterMilliseconds == nil && result.error == nil, "acknowledged command fields diverged")
                let positions = try (result.eventPositions ?? []).map { try position($0, "command.eventPosition") }
                for index in positions.indices.dropFirst() {
                    try require(positions[index] > positions[index - 1], "acknowledged positions are not increasing")
                }
            } else {
                try require(result.error != nil && result.pollAfterMilliseconds == nil && result.eventPositions == nil, "rejected command fields diverged")
                if let error = result.error {
                    let errorCodes = Set(["authentication_required", "authorization_denied", "mutation_incompatible", "stale_command", "request_conflict", "rate_limited", "authority_unavailable"])
                    try require(errorCodes.contains(error.code), "unknown command error code")
                    try validateString(error.message, "command.error.message", maximumBytes: 1024)
                }
            }
        }
    case "greenroom.capabilities":
        let value = try decoder.decode(Capabilities.self, from: data)
        try require(value.authorityRole == "sole_writer_scheduler", "authority changed")
        try validateIdentifier(value.authorityId, "authorityId")
        try require(value.supportedContractMajors.contains(1), "contract major 1 is unsupported")
        try require((1...100).contains(value.catchUp.pageSizeMaximum), "catch-up page bound diverged")
        try require(value.eventPositionEncoding == "decimal_string_uint64", "position encoding diverged")
        try require(value.timestampEncoding == "rfc3339_utc_milliseconds", "timestamp encoding diverged")
        try require(value.catchUp.declaresAuthorityHead && value.catchUp.declaresRetentionGap, "catch-up declarations disabled")
        try require(value.transport.httpCatchUp, "authoritative HTTP catch-up disabled")
        try require(value.transport.offlineMutation == false, "offline mutation became enabled")
        try validateVersion(value.minimumMutationVersion, "minimumMutationVersion")
        try validateVersion(value.maximumMutationVersion, "maximumMutationVersion")
    case "greenroom.catch_up_gap":
        let value = try decoder.decode(CatchUpGap.self, from: data)
        let requested = try position(value.requestedAfterCursor, "requestedAfterCursor")
        let earliest = try position(value.earliestAvailableCursor, "earliestAvailableCursor")
        let head = try position(value.authorityHeadCursor, "authorityHeadCursor")
        try require(requested < earliest && earliest <= head && value.snapshotRequired && value.reason == "retention_gap", "gap semantics diverged")
    case "greenroom.invitation_lifecycle_placeholders":
        let value = try decoder.decode(InvitationPlaceholders.self, from: data)
        try require(value.implementationStatus == "placeholder_only_no_endpoints", "invitation fixture became implementation")
        try require(Set(value.states.map(\.state)) == Set(["issued", "viewed", "consumed", "expired", "revoked", "rejected"]), "invitation vocabulary diverged")
        for state in value.states { try validateTimestamp(state.at, "invitation.state.at") }
    case "greenroom.compatibility_cases":
        let value = try decoder.decode(CompatibilityCases.self, from: data)
        try require(value.cases.count == 10, "compatibility matrix is incomplete")
        guard
            let rawRoot = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rawCases = rawRoot["cases"] as? [[String: Any]]
        else { throw ProofError.invalid("compatibility matrix is not a JSON object") }
        for item in rawCases {
            guard let expected = item["expected"] as? String else {
                throw ProofError.invalid("compatibility case lacks expected outcome")
            }
            let actual = try classifyCompatibilityCase(item)
            try require(actual == expected, "compatibility case \(item["name"] as? String ?? "unknown") expected \(expected), got \(actual)")
        }
    default:
        throw ProofError.invalid("unknown fixture schema \(header.schema)")
    }
}

let output: [String: Any] = [
    "decodedFixtures": files.count,
    "positionEncoding": "UInt64 decimal string",
    "timestampEncoding": "RFC3339 UTC milliseconds",
    "status": "pass",
]
let outputData = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: outputData, as: UTF8.self))
