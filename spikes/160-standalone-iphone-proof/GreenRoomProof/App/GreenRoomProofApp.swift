import SwiftUI

@main
struct GreenRoomProofApp: App {
    @StateObject private var model = RoomViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .preferredColorScheme(.light)
        }
    }
}
