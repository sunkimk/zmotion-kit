// 各组件共用的小工具：十六进制颜色、触感反馈、和网站 motion 弹簧参数对齐的换算。
import SwiftUI
import UIKit

public extension Color {
    /// 十六进制颜色，如 Color(hex: "#FF3B5C")；格式不对时退回黑色
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r, g, b, a: Double
        switch s.count {
        case 8: (r, g, b, a) = (Double((v >> 24) & 0xFF), Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF))
        case 6: (r, g, b, a) = (Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF), 255)
        default: (r, g, b, a) = (0, 0, 0, 255)
        }
        self.init(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: a / 255)
    }
}

/// 触感反馈（网站版的合成音效在原生端换成触感）；UIKit 的反馈生成器只能在主线程用
@MainActor
enum Haptics {
    static func tap(_ enabled: Bool) {
        guard enabled else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
    static func pop(_ enabled: Bool) {
        guard enabled else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
    static func success(_ enabled: Bool) {
        guard enabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

extension Animation {
    /// 和 motion 的 { type: "spring", stiffness, damping, mass } 一一对应
    static func motionSpring(stiffness: Double, damping: Double, mass: Double = 1) -> Animation {
        .interpolatingSpring(mass: mass, stiffness: stiffness, damping: damping)
    }
    /// 只对应 motion 的 { visualDuration, bounce }（感知时长，和 SwiftUI 的 spring(duration:bounce:) 定义相同）。
    /// 注意：motion 的 { duration, bounce } 是「停稳时间」，要按 motion 的 findSpring 换算成 stiffness / damping 再用上面那个，不能用这个
    static func motionSpring(duration: Double, bounce: Double) -> Animation {
        .spring(duration: duration, bounce: bounce)
    }
}
