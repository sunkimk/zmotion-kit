// 点赞迸发：按下时爱心被压扁，松开后带着速度弹起、瞬间填色，光环和两层粒子同时炸开；计数只滚动变化的那一位。
// 对应网站 src/cases/like-burst（React + motion）。尺寸按 em 换算（根字号随容器缩放），参数里的 px 以 16px 为基准。
// 所有动画都按时间直接算（TimelineView 逐帧取样）：弹簧用和 motion 相同的物理解析解，补间用同样的三次贝塞尔，
// 这样打断时能像 motion 一样「从当前值、带当前速度」接着走。
import SwiftUI
import UIKit

public struct LikeBurst: View {
    let color: Color
    let particles: Double
    let spread: Double
    let bounce: Double
    let showCount: Bool
    let haptics: Bool

    public init(
        color: Color = Color(hex: "#FF3B5C"),
        particles: Double = 12,
        spread: Double = 56,
        bounce: Double = 0.5,
        showCount: Bool = true,
        haptics: Bool = true
    ) {
        self.color = color
        self.particles = particles
        self.spread = spread
        self.bounce = bounce
        self.showCount = showCount
        self.haptics = haptics
    }

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduce

    @State private var liked = false
    @State private var count = 128
    @State private var burst = 0
    @State private var burstStart: Date?
    /// 取消点赞时光环淡出（0.12s）的起点和那一刻的透明度
    @State private var ringExit: (at: Date, from: Double)?
    /// 取消点赞的时刻：点亮是瞬间的，熄灭才用 0.22s ease 慢慢褪
    @State private var unlikeAt: Date?
    // 爱心自己的缩放：按下压扁，松开带着速度弹回（点亮时速度更大，会冲过 1 再回来）
    @State private var heart = MotionScalar(1)
    // 整个按钮的 whileTap 缩放
    @State private var chip = MotionScalar(1)
    @State private var slots: [Int: DigitRoll] = [:]
    @State private var pressing = false
    @State private var chipSize: CGSize = .zero
    @State private var activeUntil = Date.distantPast
    @State private var wake = 0

    // MARK: - 时长与曲线（和网站一致）

    private static let pressDur = 0.09
    private static let popDur = 0.26
    private static let ringDur = 0.42
    private static let dotDur = 0.7
    private static let burstTotal = 0.08 + 0.03 + 0.7

    public var body: some View {
        let _ = wake
        GeometryReader { geo in
            // 根字号：clamp(15px, 5.2cqmin, 24px)
            let E = min(max(15, 0.052 * min(geo.size.width, geo.size.height)), 24)
            let running = Date() < activeUntil
            TimelineView(.animation(paused: !running)) { tl in
                let now = running ? tl.date : Date()
                chipView(E: E, now: now)
                    .frame(width: geo.size.width, height: geo.size.height)
            }
        }
    }

    // MARK: - 视图

    private var palette: Palette { Palette(scheme: scheme, like: color) }

    @ViewBuilder
    private func chipView(E: Double, now: Date) -> some View {
        let pal = palette
        HStack(spacing: 0.6 * E) {
            icon(E: E, now: now, pal: pal)
            if showCount {
                countView(E: E, now: now, pal: pal)
            }
        }
        .padding(EdgeInsets(top: 0.75 * E, leading: 0.95 * E, bottom: 0.75 * E, trailing: 1.35 * E))
        .background(chipBackground(pal))
        .background(GeometryReader { g in
            Color.clear
                .onAppear { chipSize = g.size }
                .onChange(of: g.size) { _, s in chipSize = s }
        })
        .contentShape(Capsule())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pressing { pressing = true; pressStart() }
                }
                .onEnded { v in
                    pressing = false
                    // 和 motion 的 onTap / onTapCancel 一样：在按钮里松手算点击，拖出去松手算取消
                    if CGRect(origin: .zero, size: chipSize).contains(v.location) { toggle() } else { pressCancel() }
                }
        )
        .scaleEffect(chip.value(at: now))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(liked ? "取消点赞" : "点赞")
        .accessibilityAddTraits(liked ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { toggle() }
    }

    /// 胶囊底：1px 描边环 + 两层投影（深色只有一层大投影）。-6px 的 spread 用内缩 6pt 的投影形状来模拟
    private func chipBackground(_ pal: Palette) -> some View {
        ZStack {
            Capsule().fill(pal.chip).padding(6)
                .shadow(color: .black.opacity(pal.dark ? 0.5 : 0.1), radius: 12, x: 0, y: 8)
            if !pal.dark {
                Capsule().fill(pal.chip)
                    .shadow(color: .black.opacity(0.05), radius: 1, x: 0, y: 1)
            }
            Capsule().fill(pal.chipRing).padding(-1)
            Capsule().fill(pal.chip)
        }
    }

    @ViewBuilder
    private func icon(E: Double, now: Date, pal: Palette) -> some View {
        let size = 2.25 * E
        let unit = size / 24
        // 点亮程度：0 = 描边灰色、无填充；1 = 填满主色
        let lit: Double = {
            if liked { return 1 }
            guard let at = unlikeAt else { return 0 }
            return 1 - Curve.ease(now.timeIntervalSince(at) / 0.22)
        }()
        ZStack {
            if let start = burstStart, burst > 0 {
                let t = now.timeIntervalSince(start)
                if t < Self.burstTotal {
                    ring(E: E, t: t, now: now, pal: pal)
                    if liked { dots(E: E, t: t, pal: pal) }
                }
            }
            ZStack {
                HeartShape().fill(pal.like.opacity(lit))
                HeartShape().stroke(
                    pal.mix(pal.muted, pal.like, lit),
                    style: StrokeStyle(lineWidth: 1.8 * unit, lineJoin: .round)
                )
            }
            .frame(width: size, height: size)
            .scaleEffect(heart.value(at: now))
        }
        .frame(width: size, height: size)
    }

    /// 光环：scale 0.45→1.4、边框 9px→0（0.42s, [0.2,0.7,0.3,1]），透明度 [1,1,0] @ [0,0.55,1]
    @ViewBuilder
    private func ring(E: Double, t: Double, now: Date, pal: Palette) -> some View {
        let p = min(max(t / Self.ringDur, 0), 1)
        let e = Curve.ring(p)
        let scale = 0.45 + (1.4 - 0.45) * e
        let border = (9.0 / 16.0) * E * (1 - e)
        let opacity: Double = {
            if let exit = ringExit {
                return exit.from * (1 - Curve.easeInOut(now.timeIntervalSince(exit.at) / 0.12))
            }
            return Self.ringOpacity(p)
        }()
        let d = 2.85 * E // inset: -0.3em
        if border > 0.01 && opacity > 0.001 {
            Circle()
                .strokeBorder(pal.like, lineWidth: border)
                .frame(width: d, height: d)
                .scaleEffect(scale)
                .opacity(opacity)
        }
    }

    private static func ringOpacity(_ p: Double) -> Double {
        p <= 0.55 ? 1 : 1 - Curve.easeInOut((p - 0.55) / 0.45)
    }

    /// 粒子：每个方向一大一小两颗，小的略偏一点角度、飞得更近，颜色浅一档
    @ViewBuilder
    private func dots(E: Double, t: Double, pal: Palette) -> some View {
        let n = Int(particles.rounded())
        let px = E / 16
        if n > 0 {
            ForEach(0..<(n * 2), id: \.self) { k in
                let i = k / 2, j = k % 2
                let a = Double(i) / Double(n) * .pi * 2 - .pi / 2
                let angle = j == 0 ? a : a + 0.32
                let dist = (j == 0 ? spread : spread * 0.72) * px
                let s = (j == 0 ? 7.0 : 5.0) * px
                let lt = t - (0.08 + (j == 1 ? 0.03 : 0))
                if lt > 0 {
                    let p = min(lt / Self.dotDur, 1)
                    let r = dist * (0.45 + 0.55 * Curve.dot(p))
                    // scale: [0,1,0] @ [0,0.25,1]，每段 easeOut
                    let sc = p < 0.25 ? Curve.easeOut(p / 0.25) : 1 - Curve.easeOut((p - 0.25) / 0.75)
                    if sc > 0.001 {
                        Circle()
                            .fill(j == 0 ? pal.like : pal.like2)
                            .frame(width: s, height: s)
                            .scaleEffect(sc)
                            .offset(x: cos(angle) * r, y: sin(angle) * r)
                    }
                }
            }
        }
    }

    /// 计数：只滚动变化的那几位；点赞时新数字从下往上进，取消时反过来
    private func countView(E: Double, now: Date, pal: Palette) -> some View {
        let fs = 1.2 * E
        let font = UIFont.monospacedDigitSystemFont(ofSize: fs, weight: .semibold)
        let ch = ("0" as NSString).size(withAttributes: [.font: font]).width
        let lineH = 1.25 * fs
        let pad = 0.12 * fs
        let chars = Array(String(count))
        return HStack(spacing: 0) {
            ForEach((1...chars.count).reversed(), id: \.self) { slot in
                let c = chars[chars.count - slot]
                let roll = slots[slot].flatMap { $0.cur == c ? $0 : nil } ?? DigitRoll(cur: c, prev: nil, start: .distantPast, up: true)
                let t = now.timeIntervalSince(roll.start)
                let y = Curve.pop(t / Self.popDur) // 位移 0.26s 带回弹
                let o = Curve.easeInOut(t / 0.16) // 透明度 0.16s
                let dir: Double = roll.up ? 1 : -1
                ZStack {
                    if let prev = roll.prev, t < Self.popDur {
                        digit(prev, fs: fs, w: ch, h: lineH, color: pal.fg)
                            .offset(y: -dir * 0.7 * lineH * y)
                            .opacity(1 - o)
                    }
                    digit(c, fs: fs, w: ch, h: lineH, color: pal.fg)
                        .offset(y: roll.prev == nil ? 0 : dir * 0.7 * lineH * (1 - y))
                        .opacity(roll.prev == nil ? 1 : o)
                }
                .frame(width: ch, height: lineH + pad * 2)
                .clipped()
                // 上下渐隐，数字滚进滚出不会切出硬边
                .mask(LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black, location: 0.22),
                        .init(color: .black, location: 0.78),
                        .init(color: .clear, location: 1),
                    ],
                    startPoint: .top, endPoint: .bottom
                ))
                .padding(.vertical, -pad)
            }
        }
        .frame(minWidth: 3 * ch, alignment: .leading)
    }

    private func digit(_ c: Character, fs: Double, w: Double, h: Double, color: Color) -> some View {
        Text(String(c))
            .font(.system(size: fs, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(color)
            .fixedSize()
            .frame(width: w, height: h)
    }

    // MARK: - 交互

    private func pressStart() {
        let now = Date()
        heart.tween(to: 0.78, duration: Self.pressDur, curve: Curve.press, now: now)
        chip.tween(to: 0.96, duration: Self.pressDur, curve: Curve.press, now: now)
        keepAlive(Self.pressDur)
    }

    private func pressCancel() {
        let now = Date()
        heart.spring(to: 1, stiffness: 500, damping: 30, now: now)
        chip.tween(to: 1, duration: Self.popDur, curve: Curve.pop, now: now)
        keepAlive(max(heart.duration, Self.popDur))
    }

    private func toggle() {
        let now = Date()
        let next = !liked
        liked = next
        let old = count
        count += next ? 1 : -1
        roll(from: old, to: count, up: next, now: now)

        if next {
            unlikeAt = nil
            if !reduce {
                burst += 1
                burstStart = now
                ringExit = nil
            }
        } else {
            unlikeAt = now
            // 光环还在时淡出 0.12s；粒子直接消失（和网站一样）
            if let start = burstStart, ringExit == nil {
                let t = now.timeIntervalSince(start)
                if t < Self.ringDur { ringExit = (now, Self.ringOpacity(t / Self.ringDur)) }
            }
        }

        heart.spring(
            to: 1,
            stiffness: 520,
            damping: next ? 34 - bounce * 26 : 30,
            velocity: next ? 6 + bounce * 10 : 2,
            now: now
        )
        chip.tween(to: 1, duration: Self.popDur, curve: Curve.pop, now: now)
        keepAlive(max(heart.duration, Self.popDur, next && !reduce ? Self.burstTotal : 0.22))

        if next { Haptics.pop(haptics) } else { Haptics.tap(haptics) }
    }

    private func roll(from old: Int, to new: Int, up: Bool, now: Date) {
        let o = Array(String(old)), n = Array(String(new))
        var next: [Int: DigitRoll] = [:]
        for (i, c) in n.enumerated() {
            let slot = n.count - i // 从个位往左数，位数变化时其它位不跟着动
            let before: Character? = slot <= o.count ? o[o.count - slot] : nil
            if let before, before != c {
                next[slot] = DigitRoll(cur: c, prev: before, start: now, up: up)
            } else if let existing = slots[slot], existing.cur == c {
                next[slot] = existing
            }
        }
        slots = next
    }

    /// 动画进行时让 TimelineView 逐帧刷新，结束后停下
    private func keepAlive(_ seconds: Double) {
        let until = Date().addingTimeInterval(seconds)
        if until > activeUntil { activeUntil = until }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds + 0.05))
            wake &+= 1
        }
    }
}

// MARK: - 颜色

private struct Palette {
    let dark: Bool
    let like: Color
    let like2: Color
    let fg: Color
    let muted: Color
    let chip: Color
    let chipRing: Color

    init(scheme: ColorScheme, like: Color) {
        dark = scheme == .dark
        self.like = like
        fg = Color(hex: dark ? "#f2f2f2" : "#111111")
        muted = Color(hex: dark ? "#6c6c6c" : "#9a9a9a")
        chip = Color(hex: dark ? "#232323" : "#ffffff")
        chipRing = dark ? Color.white.opacity(0.06) : Color.black.opacity(0.04)
        // --like-2: color-mix(in oklab, var(--like) 55%/60%, #fff)
        like2 = Self.oklabMix(like, with: .white, weight: dark ? 0.6 : 0.55)
    }

    /// CSS 颜色过渡在 sRGB 里线性插值
    func mix(_ a: Color, _ b: Color, _ t: Double) -> Color {
        if t <= 0 { return a }
        if t >= 1 { return b }
        let x = Self.rgba(a), y = Self.rgba(b)
        return Color(.sRGB,
                     red: x.0 + (y.0 - x.0) * t,
                     green: x.1 + (y.1 - x.1) * t,
                     blue: x.2 + (y.2 - x.2) * t,
                     opacity: x.3 + (y.3 - x.3) * t)
    }

    static func rgba(_ c: Color) -> (Double, Double, Double, Double) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(c).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Double(r), Double(g), Double(b), Double(a))
    }

    static func oklabMix(_ a: Color, with b: Color, weight w: Double) -> Color {
        let x = rgba(a), y = rgba(b)
        let la = toOklab(x.0, x.1, x.2), lb = toOklab(y.0, y.1, y.2)
        let m = (la.0 * w + lb.0 * (1 - w), la.1 * w + lb.1 * (1 - w), la.2 * w + lb.2 * (1 - w))
        let rgb = fromOklab(m.0, m.1, m.2)
        return Color(.sRGB, red: rgb.0, green: rgb.1, blue: rgb.2, opacity: x.3 * w + y.3 * (1 - w))
    }

    private static func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    private static func gam(_ v: Double) -> Double {
        let c = min(max(v, 0), 1)
        return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055
    }

    private static func toOklab(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
        let R = lin(r), G = lin(g), B = lin(b)
        let l = cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
        let m = cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
        let s = cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
    }

    private static func fromOklab(_ L: Double, _ a: Double, _ b: Double) -> (Double, Double, Double) {
        let l = pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m = pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s = pow(L - 0.0894841775 * a - 1.2914855480 * b, 3)
        return (gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                gam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))
    }
}

// MARK: - 爱心路径（viewBox 0 0 24 24，和网站 SVG 同一条路径）

private struct HeartShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        let ox = rect.midX - 12 * s, oy = rect.midY - 12 * s
        func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        path.move(to: p(12, 21))
        path.addCurve(to: p(2.4, 11.8), control1: p(12, 21), control2: p(4.5, 16.4))
        path.addCurve(to: p(6.6, 4.5), control1: p(0.9, 8.4), control2: p(2.9, 4.5))
        path.addCurve(to: p(12, 7.6), control1: p(8.7, 4.5), control2: p(10.2, 5.7))
        path.addCurve(to: p(17.4, 4.5), control1: p(13.8, 5.7), control2: p(15.3, 4.5))
        path.addCurve(to: p(21.6, 11.8), control1: p(21.1, 4.5), control2: p(23.1, 8.4))
        path.addCurve(to: p(12, 21), control1: p(19.5, 16.4), control2: p(12, 21))
        path.closeSubpath()
        return path
    }
}

// MARK: - 计数滚动的一位

private struct DigitRoll {
    var cur: Character
    var prev: Character?
    var start: Date
    var up: Bool
}

// MARK: - 曲线

/// CSS / motion 的 cubic-bezier(x1, y1, x2, y2)，y 可以超出 0…1（回弹曲线）
private struct Bezier {
    let x1, y1, x2, y2: Double
    init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
        self.x1 = x1; self.y1 = y1; self.x2 = x2; self.y2 = y2
    }

    private func sx(_ t: Double) -> Double {
        let cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
        return ((ax * t + bx) * t + cx) * t
    }
    private func sy(_ t: Double) -> Double {
        let cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
        return ((ay * t + by) * t + cy) * t
    }
    private func dx(_ t: Double) -> Double {
        let cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
        return (3 * ax * t + 2 * bx) * t + cx
    }

    func callAsFunction(_ p: Double) -> Double {
        if p <= 0 { return 0 }
        if p >= 1 { return 1 }
        var t = p
        for _ in 0..<8 {
            let x = sx(t) - p
            if abs(x) < 1e-7 { return sy(t) }
            let d = dx(t)
            if abs(d) < 1e-6 { break }
            t -= x / d
        }
        var lo = 0.0, hi = 1.0
        t = p
        for _ in 0..<40 {
            let x = sx(t)
            if abs(x - p) < 1e-7 { break }
            if x < p { lo = t } else { hi = t }
            t = (lo + hi) / 2
        }
        return sy(t)
    }
}

private enum Curve {
    static let press = Bezier(0.3, 0, 0.5, 1)
    static let pop = Bezier(0.28, 1.3, 0.36, 1)
    static let ring = Bezier(0.2, 0.7, 0.3, 1)
    static let dot = Bezier(0.15, 0.8, 0.3, 1)
    static let easeOut = Bezier(0, 0, 0.58, 1)
    static let easeInOut = Bezier(0.42, 0, 0.58, 1)
    static let ease = Bezier(0.25, 0.1, 0.25, 1)
}

// MARK: - 一个会动的数值（motion 的 animate(motionValue, …) 的最小复刻）

private struct MotionScalar {
    private enum Mode {
        case still
        case tween(from: Double, curve: Bezier)
        case spring(y0: Double, v0: Double, k: Double, c: Double, m: Double)
    }

    private var mode: Mode = .still
    private var target: Double
    private var start = Date.distantPast
    /// 这段动画多久后停下（秒）
    private(set) var duration: Double = 0

    init(_ v: Double) { target = v }

    func value(at now: Date) -> Double {
        let t = now.timeIntervalSince(start)
        switch mode {
        case .still:
            return target
        case let .tween(from, curve):
            if t >= duration { return target }
            return from + (target - from) * curve(max(t, 0) / duration)
        case let .spring(y0, v0, k, c, m):
            if t >= duration { return target }
            return target + Self.displacement(max(t, 0), y0: y0, v0: v0, k: k, c: c, m: m)
        }
    }

    func velocity(at now: Date) -> Double {
        let h = 0.001
        return (value(at: now) - value(at: now.addingTimeInterval(-h))) / h
    }

    /// 补间：从当前值出发，不继承速度
    mutating func tween(to: Double, duration: Double, curve: Bezier, now: Date) {
        let from = value(at: now)
        mode = .tween(from: from, curve: curve)
        target = to
        start = now
        self.duration = duration
    }

    /// 弹簧：从当前值出发；没给 velocity 时沿用当前速度（和 motion 一样）
    mutating func spring(to: Double, stiffness k: Double, damping c: Double, mass m: Double = 1, velocity: Double? = nil, now: Date) {
        let x = value(at: now)
        let v = velocity ?? self.velocity(at: now)
        let y0 = x - to
        mode = .spring(y0: y0, v0: v, k: k, c: c, m: m)
        target = to
        start = now
        // 估算停下的时刻：位移和速度都足够小
        var t = 0.0
        while t < 4 {
            let y = Self.displacement(t, y0: y0, v0: v, k: k, c: c, m: m)
            let y2 = Self.displacement(t + 0.001, y0: y0, v0: v, k: k, c: c, m: m)
            if abs(y) < 0.0005 && abs((y2 - y) / 0.001) < 0.01 { break }
            t += 1.0 / 120
        }
        duration = t
    }

    /// 阻尼弹簧 m·y'' + c·y' + k·y = 0 的解析解（y 为离目标的位移）
    static func displacement(_ t: Double, y0: Double, v0: Double, k: Double, c: Double, m: Double) -> Double {
        let w0 = sqrt(k / m)
        let zeta = c / (2 * sqrt(k * m))
        if zeta < 1 {
            let wd = w0 * sqrt(1 - zeta * zeta)
            return exp(-zeta * w0 * t) * (y0 * cos(wd * t) + (v0 + zeta * w0 * y0) / wd * sin(wd * t))
        } else if zeta == 1 {
            return exp(-w0 * t) * (y0 + (v0 + w0 * y0) * t)
        } else {
            let root = w0 * sqrt(zeta * zeta - 1)
            let r1 = -zeta * w0 + root, r2 = -zeta * w0 - root
            let a = (v0 - r2 * y0) / (r1 - r2)
            return a * exp(r1 * t) + (y0 - a) * exp(r2 * t)
        }
    }
}

#Preview {
    VStack(spacing: 0) {
        LikeBurst()
            .frame(height: 260)
        LikeBurst(color: Color(hex: "#FF7A00"), particles: 22, spread: 88, bounce: 0.75)
            .frame(height: 260)
            .background(Color(hex: "#111111"))
            .environment(\.colorScheme, .dark)
    }
}
