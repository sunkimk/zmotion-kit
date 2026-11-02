// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ZmotionKit",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "ZmotionKit", targets: ["ZmotionKit"]),
    ],
    targets: [
        .target(name: "ZmotionKit", path: "Sources/ZmotionKit"),
    ]
)
