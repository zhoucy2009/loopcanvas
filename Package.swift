// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LoopCanvas",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "LoopCanvas", targets: ["LoopCanvas"])
    ],
    targets: [
        .executableTarget(
            name: "LoopCanvas"
        ),
        .testTarget(
            name: "LoopCanvasTests",
            dependencies: ["LoopCanvas"]
        )
    ]
)
