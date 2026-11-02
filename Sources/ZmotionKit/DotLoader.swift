// 圆点加载：四种圆点循环（波浪 / 轨道 / 脉冲 / 弹跳），圆点错峰运动。
// 完成时圆点收拢到中心、长成圆章、画出对勾，停一会儿再散开继续加载。
// 对应网站 src/cases/dot-loader（React + CSS keyframes / transition）。
// 循环动画按 CSS keyframes 逐段取样（每段各自的缓动、同样的负延迟错峰）；「完成」是一组可打断的 CSS transition，
// 从当前值出发，按同样的时长 / 延迟 / 贝塞尔走。全部按时间直接算（TimelineView 逐帧取样）。
import SwiftUI
import UIKit

public struct DotLoader: View {
    /// 加载动画的样式
    public enum Variant: String, CaseIterable, Sendable {
        /// 波浪：错峰的正弦起伏
        case wave
        /// 轨道：一串圆点追着转，头大尾小
        case orbit
        /// 脉冲：放大点亮，外圈扩散
        case pulse
        /// 弹跳：上抛减速、下落加速，落地压扁
        case bounce
    }

    let variant: Variant
    let count: Double
    let speed: Double
    let dotSize: Double
    let color: Color
    let haptics: Bool
    let isDone: Binding<Bool>?
    let loadingText: String
    let doneText: String
    let onTap: (() -> Void)?

    /// - Parameters:
    ///   - variant: 加载动画的样式
    ///   - count: 圆点的数量（3–12），容器太窄时圆点会自动变小
    ///   - speed: 循环动画的速度倍率（0.3–2.5）
    ///   - dotSize: 单个圆点的直径，pt（4–22）
    ///   - color: 圆点和圆章的颜色
    ///   - haptics: 完成时（圆章弹出那一刻）和点回加载时的触感反馈
    ///   - isDone: 外部绑定的「加载完成」状态；不传则和网站一样，点一下模拟完成，停 1.8s 自动回到加载
    ///   - loadingText: 加载中的文案
    ///   - doneText: 完成后的文案
    ///   - onTap: 点击加载区域时回调（受控模式下由宿主决定怎么处理）
    public init(
        variant: Variant = .wave,
        count: Double = 5,
        speed: Double = 1,
        dotSize: Double = 14,
        color: Color = Color(hex: "#0A84FF"),
        haptics: Bool = true,
        isDone: Binding<Bool>? = nil,
        loadingText: String = "正在加载",
        doneText: String = "加载完成",
        onTap: (() -> Void)? = nil
    ) {
        self.variant = variant
        self.count = count
        self.speed = speed
        self.dotSize = dotSize
        self.color = color
        self.haptics = haptics
        self.isDone = isDone
        self.loadingText = loadingText
        self.doneText = doneText
        self.onTap = onTap
    }

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduce

    @State private var internalDone = false
    /// 循环动画的时钟：完成时暂停（animation-play-state: paused），回到加载时从停下的相位接着走
    @State private var loopBase: Double = 0
    @State private var loopSince: Date?
    // 完成过渡（CSS transition），都是 0…1 的进度
    /// 圆点收拢：0 = 原位，1 = translate(gx, gy) scale(0.7)（轨道是 scale(0.1)）
    @State private var gather = DLTween(0)
    /// 圆点透明度
    @State private var fade = DLTween(1)
    /// 圆章缩放进度：0 = scale(1/k)，1 = scale(1)
    @State private var grow = DLTween(0)
    /// 圆章透明度
    @State private var badgeFade = DLTween(0)
    /// 对勾描边进度（stroke-dashoffset 1 → 0）
    @State private var check = DLTween(0)
    /// 按下缩放（:active { scale: 0.96 }）
    @State private var press = DLTween(1)
    @State private var pressing = false
    @State private var activeUntil = Date.distantPast
    @State private var wake = 0
    /// 每次切换 +1，用来作废还没到点的计时（HOLD_MS / POP_MS）
    @State private var tapGen = 0
    @State private var doneGen = 0

    /// 完成后停留多久再回到加载
    private static let holdDur = 1.8
    /// 圆点收拢到中心后，对勾弹出的时刻（与 transition-delay 对齐）
    private static let popDur = 0.23

    private var done: Bool { isDone?.wrappedValue ?? internalDone }

    public var body: some View {
        let _ = wake
        GeometryReader { geo in
            let n = Swift.max(1, Swift.min(12, Int(count.rounded())))
            // 圆点尺寸：参数值，窄容器里自动缩小，保证一排放得下
            let s = Swift.max(1, Swift.min(dotSize, (geo.size.width - 56) / (Double(n) * 1.8)))
            // 圆章直径是圆点的 k 倍，小圆点时保证对勾仍然看得清
            let k = Swift.max(3.6, 44 / Swift.max(4, dotSize))
            let running = loopSince != nil || Date() < activeUntil
            VStack(spacing: 14) {
                TimelineView(.animation(paused: !running)) { tl in
                    stage(n: n, s: s, k: k, now: running ? tl.date : Date())
                }
                caption
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .onAppear {
            if done {
                jumpToDone()
            } else if loopSince == nil {
                loopSince = Date()
            }
        }
        .onChange(of: done) { _, d in apply(d) }
    }

    // MARK: - 视图

    @ViewBuilder
    private func stage(n: Int, s: Double, k: Double, now: Date) -> some View {
        let set = setSize(n: n, s: s)
        let B = s * k
        // min-width: 120px; min-height: size * k + 24px; padding: 12px 20px
        let w = Swift.max(120, Swift.max(set.width, B) + 40)
        let h = Swift.max(B + 24, Swift.max(set.height, B) + 24)
        let u = loopTime(now) * Swift.max(0.1, speed)
        ZStack {
            dots(n: n, s: s, u: u, now: now)
                .frame(width: set.width, height: set.height)
            badge(B: B, k: k, now: now)
        }
        .frame(width: w, height: h)
        .contentShape(RoundedRectangle(cornerRadius: 24))
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pressing { pressing = true; pressTo(0.96) }
                }
                .onEnded { v in
                    pressing = false
                    pressTo(1)
                    // 和 button 的 click 一样：在按钮里松手才算点击
                    if CGRect(x: 0, y: 0, width: w, height: h).contains(v.location) { tapped() }
                }
        )
        .scaleEffect(press.value(at: now))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { tapped() }
    }

    private var accessibilityText: String {
        if isDone != nil { return done ? doneText : loadingText }
        return done ? "加载完成，点击重新加载" : "正在加载，点击模拟完成"
    }

    private func setSize(n: Int, s: Double) -> CGSize {
        let row = { (gap: Double) in Double(n) * s + Double(n - 1) * gap * s }
        switch variant {
        case .wave: return CGSize(width: row(0.75), height: 2.6 * s)
        case .pulse: return CGSize(width: row(0.9), height: 2.8 * s)
        case .bounce: return CGSize(width: row(0.75), height: 3.8 * s)
        case .orbit:
            let d = s * 5.2 + 16
            return CGSize(width: d, height: d)
        }
    }

    @ViewBuilder
    private func dots(n: Int, s: Double, u: Double, now: Date) -> some View {
        let m = gather.value(at: now)
        let op = dlClamp(fade.value(at: now), 0, 1)
        let shadow = Color.black.opacity(scheme == .dark ? 0.7 : 0.28)
        ZStack {
            ForEach(0..<n, id: \.self) { i in
                let mid = Double(n - 1) / 2
                let fi = Double(i)
                switch variant {
                case .wave:
                    // 错峰：animation-delay = i * 0.11s - 3.3s
                    let p = dlPhase(u, delay: fi * 0.11 - 3.3, dur: 1.1)
                    let dy = reduce ? 0 : DLKF.sample(p, [(0, 0.5), (0.5, -0.5), (1, 0.5)], DLCurve.easeInOut)
                    let sc = reduce ? 1 : DLKF.sample(p, [(0, 0.86), (0.5, 1), (1, 0.86)], DLCurve.easeInOut)
                    let o = reduce ? DLKF.fade(p) : DLKF.sample(p, [(0, 0.4), (0.5, 1), (1, 0.4)], DLCurve.easeInOut)
                    Circle().fill(color)
                        .frame(width: s, height: s)
                        .scaleEffect(sc)
                        .offset(y: dy * s)
                        .opacity(o)
                        .frame(width: s, height: s)
                        .scaleEffect(1 - 0.3 * m)
                        .offset(x: (mid - fi) * s * 1.75 * m)
                        .opacity(op)
                        .offset(x: (fi - mid) * s * 1.75)
                case .pulse:
                    let p = dlPhase(u, delay: fi * 0.15 - 12, dur: Swift.max(1.2, Double(n) * 0.15 + 0.5))
                    let dotScale = reduce ? 1 : DLKF.sample(p, [(0, 0.55), (0.3, 1.05), (0.7, 0.55), (1, 0.55)], DLCurve.easeInOut)
                    let dotOp = reduce ? DLKF.fade(p) : DLKF.sample(p, [(0, 0.3), (0.3, 1), (0.7, 0.3), (1, 0.3)], DLCurve.easeInOut)
                    let ringScale = reduce ? 1 : DLKF.sample(p, [(0, 1), (0.3, 1), (0.75, 2.6), (1, 2.6)], DLCurve.easeOut)
                    let ringOp = reduce ? DLKF.fade(p) : DLKF.sample(p, [(0, 0), (0.3, 0.5), (0.75, 0), (1, 0)], DLCurve.easeOut)
                    ZStack {
                        Circle().strokeBorder(color, lineWidth: 1.5)
                            .frame(width: s, height: s)
                            .scaleEffect(ringScale)
                            .opacity(ringOp)
                        Circle().fill(color)
                            .frame(width: s, height: s)
                            .scaleEffect(dotScale)
                            .opacity(dotOp)
                    }
                    .frame(width: s, height: s)
                    .scaleEffect(1 - 0.3 * m)
                    .offset(x: (mid - fi) * s * 1.9 * m)
                    .opacity(op)
                    .offset(x: (fi - mid) * s * 1.9)
                case .bounce:
                    let p = dlPhase(u, delay: fi * 0.12 - 6.4, dur: 0.64)
                    // 上抛减速（easeOutCubic）、下落加速（easeInCubic），单位是圆点直径
                    let hop = reduce ? 0 : DLKF.sample(p, [(0, 0), (0.5, -2), (1, 0)], [DLCurve.outCubic, DLCurve.inCubic])
                    let sx = reduce ? 1 : DLKF.sample(p, [(0, 1.3), (0.14, 0.92), (0.5, 1), (0.86, 0.92), (1, 1.3)], [DLCurve.linear])
                    let sy = reduce ? 1 : DLKF.sample(p, [(0, 0.72), (0.14, 1.1), (0.5, 1), (0.86, 1.1), (1, 0.72)], [DLCurve.linear])
                    let dotOp = reduce ? DLKF.fade(p) : 1
                    let shScale = reduce ? 1 : DLKF.sample(p, [(0, 1), (0.5, 0.45), (1, 1)], [DLCurve.outCubic, DLCurve.inCubic])
                    let shOp = reduce ? DLKF.fade(p) : DLKF.sample(p, [(0, 1), (0.5, 0.3), (1, 1)], [DLCurve.outCubic, DLCurve.inCubic])
                    ZStack {
                        // 影子：底边比圆点低 0.22 个圆点
                        Ellipse()
                            .fill(EllipticalGradient(colors: [shadow, shadow.opacity(0)], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5))
                            .frame(width: s, height: s * 0.32)
                            .scaleEffect(shScale)
                            .opacity(shOp)
                            .offset(y: s * 1.96)
                        Circle().fill(color)
                            .frame(width: s, height: s)
                            .scaleEffect(x: sx, y: sy, anchor: .bottom)
                            .offset(y: hop * s)
                            .opacity(dotOp)
                            .offset(y: s * 1.4)
                    }
                    .frame(width: s, height: s * 3.8)
                    .scaleEffect(1 - 0.3 * m)
                    .offset(x: (mid - fi) * s * 1.75 * m, y: -s * 1.4 * m)
                    .opacity(op)
                    .offset(x: (fi - mid) * s * 1.75)
                case .orbit:
                    let d = s * 5.2 + 16
                    let t = n > 1 ? fi / Double(n - 1) : 0
                    let p = dlPhase(u, delay: fi * 0.09 - 2.8, dur: 1.4)
                    let angle = reduce ? 0 : 360 * DLCurve.spin(p)
                    let armOp = reduce ? DLKF.fade(p) : 1
                    Circle().fill(color)
                        .frame(width: s, height: s)
                        .scaleEffect(1 - t * 0.55)
                        .opacity((1 - t * 0.65) * armOp)
                        .frame(width: d, height: d, alignment: .top)
                        .rotationEffect(.degrees(angle))
                        .scaleEffect(1 - 0.9 * m)
                        .opacity(op)
                }
            }
        }
    }

    @ViewBuilder
    private func badge(B: Double, k: Double, now: Date) -> some View {
        let g = grow.value(at: now)
        let o = dlClamp(badgeFade.value(at: now), 0, 1)
        let c = dlClamp(check.value(at: now), 0, 1)
        if o > 0.001 {
            ZStack {
                // box-shadow: 0 10px 28px -10px color 80%：-10px 的 spread 用内缩 10pt 的投影形状来模拟
                Circle().fill(color)
                    .padding(Swift.min(10, B * 0.3))
                    .shadow(color: color.opacity(0.8), radius: 14, x: 0, y: 10)
                Circle().fill(color)
                if c > 0.0005 {
                    DLCheck()
                        .trim(from: 0, to: c)
                        .stroke(Color.white, style: StrokeStyle(lineWidth: 2.6 * B * 0.6 / 24, lineCap: .round, lineJoin: .round))
                }
            }
            .frame(width: B, height: B)
            .scaleEffect(1 / k + (1 - 1 / k) * g)
            .opacity(o)
            .allowsHitTesting(false)
        }
    }

    /// 文案：新的从下方 8pt 进来，旧的往上 8pt 出去，spring { stiffness: 520, damping: 34 }
    private var caption: some View {
        ZStack {
            if done {
                Text(doneText).transition(captionMove)
            } else {
                Text(loadingText).transition(captionMove)
            }
        }
        .font(.system(size: 13))
        .foregroundStyle(Color(hex: "#8A8A8E"))
        .lineLimit(1)
        .fixedSize()
        .frame(height: 18)
        .clipped()
        .animation(.motionSpring(stiffness: 520, damping: 34), value: done)
        .accessibilityHidden(true)
    }

    private var captionMove: AnyTransition {
        .asymmetric(
            insertion: .offset(y: 8).combined(with: .opacity),
            removal: .offset(y: -8).combined(with: .opacity)
        )
    }

    // MARK: - 交互

    private func tapped() {
        onTap?()
        guard isDone == nil else { return }
        tapGen &+= 1
        if internalDone {
            internalDone = false
            Haptics.tap(haptics)
            return
        }
        internalDone = true
        let g = tapGen
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(Self.holdDur))
            if g == tapGen && internalDone { internalDone = false }
        }
    }

    private func pressTo(_ v: Double) {
        press.tween(to: v, duration: 0.09, curve: DLCurve.easeOut, now: Date())
        keepAlive(0.09)
    }

    /// 完成 / 回到加载：和 CSS 两组 transition 的时长、延迟、曲线一一对应
    private func apply(_ d: Bool) {
        let now = Date()
        doneGen &+= 1
        if d {
            gather.tween(to: 1, duration: 0.3, curve: DLCurve.gatherIn, now: now)
            fade.tween(to: 0, duration: 0.1, delay: 0.2, curve: DLCurve.linear, now: now)
            grow.tween(to: 1, duration: 0.5, delay: 0.2, curve: DLCurve.spring, now: now)
            badgeFade.tween(to: 1, duration: 0.06, delay: 0.2, curve: DLCurve.linear, now: now)
            check.tween(to: 1, duration: 0.32, delay: 0.34, curve: DLCurve.draw, now: now)
            pauseLoop(now)
            keepAlive(0.7)
            let g = doneGen
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(Self.popDur))
                if g == doneGen && done { Haptics.success(haptics) }
            }
        } else {
            // 回来：等圆章缩回去，再带一点回弹散开
            gather.tween(to: 0, duration: 0.46, delay: 0.16, curve: DLCurve.spring, now: now)
            fade.tween(to: 1, duration: 0.12, delay: 0.16, curve: DLCurve.linear, now: now)
            grow.tween(to: 0, duration: 0.26, delay: 0.04, curve: DLCurve.badgeOut, now: now)
            badgeFade.tween(to: 0, duration: 0.1, delay: 0.2, curve: DLCurve.linear, now: now)
            check.tween(to: 0, duration: 0.14, curve: DLCurve.easeIn, now: now)
            if loopSince == nil { loopSince = now }
        }
    }

    private func jumpToDone() {
        gather = DLTween(1)
        fade = DLTween(0)
        grow = DLTween(1)
        badgeFade = DLTween(1)
        check = DLTween(1)
        loopSince = nil
    }

    private func loopTime(_ now: Date) -> Double {
        loopBase + (loopSince.map { Swift.max(0, now.timeIntervalSince($0)) } ?? 0)
    }

    private func pauseLoop(_ now: Date) {
        loopBase = loopTime(now)
        loopSince = nil
    }

    /// 循环暂停时（完成状态）只在过渡进行中让 TimelineView 逐帧刷新
    private func keepAlive(_ seconds: Double) {
        let until = Date().addingTimeInterval(seconds)
        if until > activeUntil { activeUntil = until }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds + 0.05))
            wake &+= 1
        }
    }
}

// MARK: - 对勾（viewBox 0 0 24 24 里的 M6.5 12.5 l3.6 3.6 L17.5 8.5，svg 占圆章的 60%）

private struct DLCheck: Shape {
    func path(in rect: CGRect) -> Path {
        let side = Swift.min(rect.width, rect.height)
        let u = side * 0.6 / 24
        let ox = rect.midX - 12 * u, oy = rect.midY - 12 * u
        var p = Path()
        p.move(to: CGPoint(x: ox + 6.5 * u, y: oy + 12.5 * u))
        p.addLine(to: CGPoint(x: ox + 10.1 * u, y: oy + 16.1 * u))
        p.addLine(to: CGPoint(x: ox + 17.5 * u, y: oy + 8.5 * u))
        return p
    }
}

// MARK: - 循环取样

private func dlClamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }

/// CSS 循环动画的相位：duration / delay 都除以 speed，等价于在「乘过 speed 的时间 u」上取样；负 delay = 提前开跑
private func dlPhase(_ u: Double, delay: Double, dur: Double) -> Double {
    let x = (u - delay) / dur
    return x - floor(x)
}

/// keyframes 取样：每段用各自的缓动（CSS 的 animation-timing-function 作用在每两个关键帧之间）
private enum DLKF {
    static func sample(_ p: Double, _ stops: [(Double, Double)], _ curves: [DLBezier]) -> Double {
        guard let first = stops.first else { return 0 }
        if p <= first.0 { return first.1 }
        for j in 1..<stops.count {
            let a = stops[j - 1], b = stops[j]
            if p <= b.0 {
                let span = b.0 - a.0
                if span <= 0 { return b.1 }
                let curve = curves[Swift.min(j - 1, curves.count - 1)]
                return a.1 + (b.1 - a.1) * curve((p - a.0) / span)
            }
        }
        return stops[stops.count - 1].1
    }

    static func sample(_ p: Double, _ stops: [(Double, Double)], _ curve: DLBezier) -> Double {
        sample(p, stops, [curve])
    }

    /// 减弱动态效果：所有循环换成 dl-fade（透明度 0.3 ↔ 1，ease-in-out），保留各自的时长和错峰
    static func fade(_ p: Double) -> Double {
        sample(p, [(0, 0.3), (0.5, 1), (1, 0.3)], DLCurve.easeInOut)
    }
}

// MARK: - 曲线

/// CSS 的 cubic-bezier(x1, y1, x2, y2)，y 可以超出 0…1（回弹曲线）
private struct DLBezier {
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
        if x1 == y1 && x2 == y2 { return p }
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

private enum DLCurve {
    static let linear = DLBezier(0, 0, 1, 1)
    static let easeIn = DLBezier(0.42, 0, 1, 1)
    static let easeOut = DLBezier(0, 0, 0.58, 1)
    static let easeInOut = DLBezier(0.42, 0, 0.58, 1)
    static let outCubic = DLBezier(0.33, 1, 0.68, 1)
    static let inCubic = DLBezier(0.32, 0, 0.67, 0)
    /// 轨道旋转一圈：cubic-bezier(0.55, 0.08, 0.35, 0.95)
    static let spin = DLBezier(0.55, 0.08, 0.35, 0.95)
    /// --dl-ease-in
    static let gatherIn = DLBezier(0.5, 0, 0.2, 1)
    /// --dl-spring（带回弹）
    static let spring = DLBezier(0.28, 1.3, 0.36, 1)
    /// 圆章缩回
    static let badgeOut = DLBezier(0.4, 0, 0.2, 1)
    /// 对勾描边
    static let draw = DLBezier(0.65, 0, 0.35, 1)
}

// MARK: - 一个可打断的 CSS transition（从当前值出发，延迟期间停在起点）

private struct DLTween {
    private var from: Double
    private var target: Double
    private var start = Date.distantPast
    private var delay: Double = 0
    private var duration: Double = 0
    private var curve = DLCurve.linear

    init(_ v: Double) {
        from = v
        target = v
    }

    func value(at now: Date) -> Double {
        let t = now.timeIntervalSince(start) - delay
        if t <= 0 { return from }
        if duration <= 0 || t >= duration { return target }
        return from + (target - from) * curve(t / duration)
    }

    mutating func tween(to v: Double, duration: Double, delay: Double = 0, curve: DLBezier, now: Date) {
        from = value(at: now)
        target = v
        start = now
        self.delay = delay
        self.duration = duration
        self.curve = curve
    }
}

#Preview("四种样式") {
    ScrollView {
        VStack(spacing: 0) {
            ForEach(DotLoader.Variant.allCases, id: \.self) { v in
                DotLoader(variant: v)
                    .frame(height: 220)
            }
        }
    }
}

#Preview("深色 / 受控") {
    struct Demo: View {
        @State private var done = false
        var body: some View {
            VStack(spacing: 24) {
                DotLoader(variant: .bounce, count: 4, speed: 1.4, dotSize: 18, color: Color(hex: "#FF9F0A"))
                    .frame(height: 260)
                DotLoader(variant: .orbit, count: 8, color: Color(hex: "#30D158"), isDone: $done, onTap: { done.toggle() })
                    .frame(height: 260)
            }
            .background(Color(hex: "#111111"))
            .environment(\.colorScheme, .dark)
        }
    }
    return Demo()
}
