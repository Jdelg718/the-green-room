// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GreenRoomLauncher",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "GreenRoomLauncher", targets: ["GreenRoomLauncher"]),
        .executable(name: "GreenRoomCredentialHelper", targets: ["GreenRoomCredentialHelper"]),
        .executable(name: "ProcessFixture", targets: ["ProcessFixture"]),
    ],
    targets: [
        .executableTarget(name: "GreenRoomLauncher"),
        .executableTarget(
            name: "GreenRoomCredentialHelper",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(name: "ProcessFixture"),
        .testTarget(
            name: "GreenRoomLauncherTests",
            dependencies: ["GreenRoomLauncher", "GreenRoomCredentialHelper", "ProcessFixture"]
        ),
    ]
)
