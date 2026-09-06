import Foundation

struct Persona: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let summary: String
    let portraitName: String
    let sourceRecordName: String

    static let bundled: [Persona] = [
        Persona(
            id: "org.greenroom.historical.ada-lovelace",
            name: "Ada Lovelace",
            summary: "Rigorous, imaginative analyst of symbolic machinery.",
            portraitName: "ada-lovelace",
            sourceRecordName: "ada-lovelace.yaml"
        ),
        Persona(
            id: "org.greenroom.historical.mary-shelley",
            name: "Mary Shelley",
            summary: "Novelist and editor concerned with invention and responsibility.",
            portraitName: "mary-shelley",
            sourceRecordName: "mary-shelley.yaml"
        ),
        Persona(
            id: "org.greenroom.historical.benjamin-franklin",
            name: "Benjamin Franklin",
            summary: "Printer, practical experimenter, organizer, and diplomat.",
            portraitName: "benjamin-franklin",
            sourceRecordName: "benjamin-franklin.yaml"
        )
    ]
}

enum SpeakerKind: String, Codable, Sendable {
    case human
    case persona
}

struct RoomMessage: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let speakerName: String
    let speakerKind: SpeakerKind
    let text: String
    let createdAt: Date
}

struct Room: Codable, Equatable, Sendable {
    let id: UUID
    var title: String
    var personaIDs: [String]
    var messages: [RoomMessage]
    var updatedAt: Date

    static func proofFixture(now: Date = Date()) -> Room {
        Room(
            id: UUID(),
            title: "The First Mobile Room",
            personaIDs: Persona.bundled.map(\.id),
            messages: [
                RoomMessage(
                    id: UUID(), speakerName: "You", speakerKind: .human,
                    text: "What should we test first in a room that lives entirely on this iPhone?",
                    createdAt: now
                ),
                RoomMessage(
                    id: UUID(), speakerName: "Ada Lovelace", speakerKind: .persona,
                    text: "Begin with the sequence: create one room, record one exchange, close the apparatus, and prove the same state returns. A small exact trial is better than a grand promise.",
                    createdAt: now.addingTimeInterval(1)
                )
            ],
            updatedAt: now.addingTimeInterval(1)
        )
    }

    static var unavailableFallback: Room {
        Room(
            id: UUID(),
            title: "Local Storage Unavailable",
            personaIDs: Persona.bundled.map(\.id),
            messages: [],
            updatedAt: Date()
        )
    }
}
