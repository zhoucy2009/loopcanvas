// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LoopCanvas",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "LoopCanvas", targets: ["LoopCanvas"]),
        .executable(name: "LoopCanvasWake", targets: ["LoopCanvasWake"])
    ],
    targets: [
        .target(name: "WakeCore"),
        .executableTarget(name: "LoopCanvasWake", dependencies: ["WakeCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "WakeCoreTests", dependencies: ["WakeCore"]),
        .executableTarget(
            name: "LoopCanvas"
        ),
        .testTarget(
            name: "LoopCanvasTests",
            dependencies: ["LoopCanvas"]
        )
    ]
)
