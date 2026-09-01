// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GreenRoomContractFixtureProof",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ContractFixtureProof", targets: ["ContractFixtureProof"])
    ],
    targets: [
        .executableTarget(name: "ContractFixtureProof")
    ]
)
