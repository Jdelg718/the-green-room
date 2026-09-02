// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GreenRoomLauncher",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "GreenRoomLauncher", targets: ["GreenRoomLauncher"]),
    ],
    targets: [
        .executableTarget(name: "GreenRoomLauncher"),
        .testTarget(
            name: "GreenRoomLauncherTests",
            dependencies: ["GreenRoomLauncher"]
        ),
    ]
)
