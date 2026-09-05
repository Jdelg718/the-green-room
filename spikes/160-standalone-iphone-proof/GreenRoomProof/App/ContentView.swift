import SwiftUI
import UIKit

private enum Brand {
    static let ink = Color(red: 23/255, green: 33/255, blue: 29/255)
    static let muted = Color(red: 91/255, green: 104/255, blue: 98/255)
    static let paper = Color(red: 247/255, green: 248/255, blue: 245/255)
    static let line = Color(red: 203/255, green: 212/255, blue: 206/255)
    static let green = Color(red: 23/255, green: 79/255, blue: 61/255)
    static let accent = Color(red: 231/255, green: 242/255, blue: 237/255)
}

struct ContentView: View {
    @ObservedObject var model: RoomViewModel

    var body: some View {
        NavigationStack {
            ZStack {
                Brand.paper.ignoresSafeArea()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        header
                        statusPanel
                        cast
                        transcript
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 100)
                }
            }
            .safeAreaInset(edge: .bottom) { composer }
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(Brand.green)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("THE GREEN ROOM")
                .font(.caption.weight(.bold))
                .tracking(1.8)
                .foregroundStyle(Brand.green)
            Text(model.room.title)
                .font(.system(.largeTitle, design: .serif, weight: .bold))
                .foregroundStyle(Brand.ink)
            Text("Standalone iPhone proof · fixture-only AI")
                .font(.subheadline)
                .foregroundStyle(Brand.muted)
        }
        .padding(.top, 18)
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(model.persistenceStatus, systemImage: "iphone.and.arrow.forward")
            Label(model.keychainStatus, systemImage: "key.fill")
            Label("No server · no network · no provider key", systemImage: "network.slash")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Brand.green)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.accent, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }

    private var cast: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("IN THE ROOM")
                .font(.caption.weight(.bold))
                .tracking(1.2)
                .foregroundStyle(Brand.muted)
            HStack(spacing: 12) {
                ForEach(model.personas) { persona in
                    VStack(spacing: 6) {
                        portrait(persona)
                        Text(persona.name.components(separatedBy: " ").first ?? persona.name)
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(persona.name), AI historical interpretation")
                }
            }
        }
    }

    private func portrait(_ persona: Persona) -> some View {
        Group {
            if let url = Bundle.main.url(forResource: persona.portraitName, withExtension: "webp"),
               let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "person.crop.circle.fill").resizable().scaledToFit().padding(8)
            }
        }
        .frame(width: 72, height: 72)
        .background(Color.white)
        .clipShape(Circle())
        .overlay(Circle().stroke(Brand.line, lineWidth: 2))
        .clipped()
    }

    private var transcript: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("LOCAL TRANSCRIPT")
                .font(.caption.weight(.bold))
                .tracking(1.2)
                .foregroundStyle(Brand.muted)
            ForEach(model.room.messages) { message in
                MessageCard(message: message)
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("Ask the room…", text: $model.draft, axis: .vertical)
                .lineLimit(1...3)
                .textFieldStyle(.plain)
                .padding(12)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Brand.line))
                .accessibilityLabel("Message the room")
            Button(action: model.send) {
                Image(systemName: "arrow.up")
                    .font(.headline.bold())
                    .frame(width: 44, height: 44)
                    .foregroundStyle(.white)
                    .background(Brand.green, in: Circle())
            }
            .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send local prompt")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }
}

private struct MessageCard: View {
    let message: RoomMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(message.speakerName)
                    .font(.subheadline.weight(.bold))
                Spacer()
                Text(message.speakerKind == .human ? "HUMAN" : "AI · INTERPRETATION")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(message.speakerKind == .human ? Brand.muted : Brand.green)
            }
            Text(message.text)
                .font(.body)
                .foregroundStyle(Brand.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(message.speakerKind == .human ? Color.white : Brand.accent, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Brand.line.opacity(0.8)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.speakerName), \(message.speakerKind == .human ? "human" : "AI historical interpretation"): \(message.text)")
    }
}
