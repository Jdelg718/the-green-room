import Foundation
import SwiftUI

@MainActor
final class RoomViewModel: ObservableObject {
    @Published private(set) var room: Room
    @Published var draft = ""
    @Published private(set) var keychainStatus = "Checking Keychain…"
    @Published private(set) var persistenceStatus = "Local room ready"

    private let diskStore: RoomDiskStore
    private let keychainStore: KeychainStore

    init(diskStore: RoomDiskStore = RoomDiskStore(), keychainStore: KeychainStore = KeychainStore()) {
        self.diskStore = diskStore
        self.keychainStore = keychainStore
        do {
            if let saved = try diskStore.load() {
                room = saved
                persistenceStatus = "Restored from this iPhone"
            } else {
                let fixture = Room.proofFixture()
                room = fixture
                try diskStore.save(fixture)
                persistenceStatus = "Created and saved on this iPhone"
            }
        } catch {
            room = Room.unavailableFallback
            persistenceStatus = "Local save unavailable"
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                self.keychainStatus = try self.keychainStore.runSyntheticSentinelCheck()
                    ? "Keychain sentinel passed"
                    : "Keychain sentinel mismatch"
            } catch {
                self.keychainStatus = "Keychain sentinel failed"
            }
        }
    }

    var personas: [Persona] {
        Persona.bundled.filter { room.personaIDs.contains($0.id) }
    }

    func send() {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        let now = Date()
        var candidate = room
        candidate.messages.append(RoomMessage(id: UUID(), speakerName: "You", speakerKind: .human, text: prompt, createdAt: now))
        candidate.messages.append(RoomMessage(
            id: UUID(), speakerName: "Ada Lovelace", speakerKind: .persona,
            text: "For this local proof, I would reduce that to one observable step, record the result, and revise only after the evidence is secure.",
            createdAt: now.addingTimeInterval(1)
        ))
        candidate.updatedAt = now.addingTimeInterval(1)
        do {
            try diskStore.save(candidate)
            room = candidate
            draft = ""
            persistenceStatus = "Saved locally just now"
        } catch {
            persistenceStatus = "Local save failed"
        }
    }
}
