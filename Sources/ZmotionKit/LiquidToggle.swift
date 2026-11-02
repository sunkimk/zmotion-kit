// 液态开关：滑块像一滴液体。左右两条边各自做弹簧，前沿快、后沿慢 → 被拉长；后沿冲过头 → 被挤扁再弹回；
// 颜色顺着滑块流进轨道。按住会变宽，也可以拖动或轻甩。
//
// 动画说明：两条边的弹簧需要「中途改目标时继承速度」「后沿延迟起步」「由两条边非线性推导出宽度 / 压扁」，
// SwiftUI 的隐式动画做不到逐帧推导，所以这里用 CADisplayLink 自己解析求解弹簧（公式与 motion v14 完全一致）。
import SwiftUI
import UIKit
import Observation

public struct LiquidToggle: View {
    private let isOn: Binding<Bool>?
    private let color: Color
    private let stretch: Double
    private let size: Double
    private let duration: Double
    private let bounce: Double
    private let haptics: Bool

    @State private var internalOn = false
    @State private var engine = LTEngine()
    @GestureState private var pressing = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - isOn: 外部绑定的开关状态；不传则组件内部自己管理
    ///   - color: 打开后轨道填充的颜色
    ///   - stretch: 前后沿的时间差，越大滑块被拉得越长，0 为刚体（0–1）
    ///   - size: 开关的宽度（pt），高度按比例变化（56–160）
    ///   - duration: 滑块从一端到另一端的弹簧时长（秒，0.2–1.2）
    ///   - bounce: 到达终点时的过冲与回弹，0 为不回弹（0–0.8）
    ///   - haptics: 切换时的触感反馈
    public init(
        isOn: Binding<Bool>? = nil,
        color: Color = Color(hex: "#34C759"),
        stretch: Double = 0.6,
        size: Double = 96,
        duration: Double = 0.5,
        bounce: Double = 0.35,
        haptics: Bool = true
    ) {
        self.isOn = isOn
        self.color = color
        self.stretch = stretch
        self.size = size
        self.duration = duration
        self.bounce = bounce
        self.haptics = haptics
        // 首帧就放在静止位置，避免 onAppear 之前闪一下
        _engine = State(initialValue: LTEngine(on: isOn?.wrappedValue ?? false, geo: LTGeo(size: size)))
    }

    private var on: Bool { isOn?.wrappedValue ?? internalOn }
    private var geo: LTGeo { LTGeo(size: size) }
    private var palette: LTPalette { colorScheme == .dark ? .dark : .light }

    public var body: some View {
        let g = geo
        let p = palette
        let e = LTEdges(xl: engine.xl, xr: engine.xr, g: g)

        VStack(spacing: 18) {
            ZStack(alignment: .topLeading) {
                // 轨道：底色 + 内描边 + 内阴影（box-shadow: inset 0 0 0 1px ring, inset 0 2px 4px rgba(0,0,0,.06)）
                Capsule()
                    .fill(p.track.shadow(.inner(color: .black.opacity(0.06), radius: 2, x: 0, y: 2)))
                Capsule()
                    .strokeBorder(p.ring, lineWidth: 1)

                // 填充：宽度跟着右沿走，透明度 = 颜色有多「满」
                Capsule()
                    .fill(color)
                    .frame(width: e.right + g.pad * 2, height: g.H)
                    .opacity(engine.level)

                // 滑块
                LTKnob(palette: p)
                    .frame(width: e.width, height: g.d)
                    .scaleEffect(x: 1, y: e.scaleY)
                    .offset(x: g.pad + e.left, y: g.pad)
            }
            .frame(width: g.W, height: g.H)
            .contentShape(Capsule())
            .gesture(dragGesture)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("液态开关")
            .accessibilityValue(on ? "已开启" : "已关闭")
            .accessibilityAddTraits(.isToggle)
            .accessibilityAction { commit(!engine.committed) }

            caption(p)
        }
        .onAppear { jumpToRest(on) }
        .onChange(of: size) { _, _ in jumpToRest(engine.committed) }
        .onChange(of: on) { _, newValue in
            // 外部绑定改变（非用户手势）→ 滑块也跟过去
            guard newValue != engine.committed else { return }
            engine.committed = newValue
            settle(newValue)
        }
        .onChange(of: pressing) { _, isPressing in
            // 手势被系统打断时 onEnded 不会触发，这里兜底（相当于 pointercancel）
            guard !isPressing else { return }
            DispatchQueue.main.async {
                if engine.drag != nil {
                    engine.drag = nil
                    settle(engine.committed)
                }
            }
        }
    }

    /* ---------- 文案 ---------- */

    private func caption(_ p: LTPalette) -> some View {
        // 与网页一致：打开时「已开启」从下方 +10 进入、「已关闭」向下 +10 退出；关闭时都在 -10
        ZStack {
            if on {
                Text("已开启")
                    .transition(.asymmetric(insertion: captionMove(10), removal: captionMove(-10)))
            } else {
                Text("已关闭")
                    .transition(.asymmetric(insertion: captionMove(-10), removal: captionMove(10)))
            }
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(p.muted)
        .frame(height: 20)
        .frame(minWidth: CGFloat(Swift.max(size, 64))) // 至少和开关一样宽
        .clipped()
        .animation(.motionSpring(stiffness: 420, damping: 32), value: on)
        .accessibilityHidden(true)
    }

    private func captionMove(_ y: CGFloat) -> AnyTransition {
        .offset(y: y)
            .combined(with: .opacity)
            .combined(with: .modifier(active: LTBlur(radius: 3), identity: LTBlur(radius: 0)))
    }

    /* ---------- 状态切换 ---------- */

    private func jumpToRest(_ state: Bool) {
        let g = geo
        engine.committed = state
        engine.jump(.xl, state ? g.travel : 0)
        engine.jump(.xr, state ? g.T : g.d)
        engine.jump(.level, state ? 1 : 0)
    }

    private func settle(_ next: Bool) {
        let g = geo
        let s = reduceMotion ? 0 : stretch
        let b = reduceMotion ? 0 : bounce
        let Lt = next ? g.travel : 0
        let Rt = next ? g.T : g.d
        let right = Rt >= engine.xr
        let (lead, leadT, trail, trailT): (LTEngine.Channel, Double, LTEngine.Channel, Double) =
            right ? (.xr, Rt, .xl, Lt) : (.xl, Lt, .xr, Rt)
        engine.animate(lead, to: leadT, spec: .timed(duration: duration, bounce: b))
        engine.animate(.level, to: next ? 1 : 0, spec: .timed(duration: duration * 0.9, bounce: 0))
        engine.animate(
            trail, to: trailT,
            spec: .timed(duration: duration * (1 + s * 0.7), bounce: min(0.9, b * (1 + s * 0.5))),
            delay: s * duration * 0.2
        )
    }

    private func commit(_ next: Bool) {
        engine.committed = next
        if let isOn { isOn.wrappedValue = next } else { internalOn = next }
        settle(next)
        if next { Haptics.pop(haptics) } else { Haptics.tap(haptics) }
    }

    /* ---------- 按压 / 拖拽 ---------- */

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($pressing) { _, state, _ in state = true }
            .onChanged { value in
                if engine.drag == nil {
                    pointerDown()
                } else {
                    pointerMove(value)
                }
            }
            .onEnded { value in pointerUp(value) }
    }

    private func pointerDown() {
        engine.drag = LTDrag()
        // 按住时滑块向内变宽
        let g = geo
        if engine.committed {
            engine.animate(.xl, to: g.travel - g.wide, spec: LTSpringSpec.quick)
        } else {
            engine.animate(.xr, to: g.d + g.wide, spec: LTSpringSpec.quick)
        }
    }

    private func pointerMove(_ value: DragGesture.Value) {
        guard var st = engine.drag else { return }
        let dx = Double(value.translation.width)
        let dir: Double = dx - st.lastDx >= 0 ? 1 : -1
        st.lastDx = dx
        if !st.dragged && abs(dx) < 4 {
            engine.drag = st
            return
        }
        st.dragged = true
        engine.drag = st

        let g = geo
        let s = reduceMotion ? 0 : stretch
        let kw = g.d + g.wide
        let hi = g.T - kw
        let base = engine.committed ? hi : 0
        // 拖过头时橡皮筋：越拉越难，最多再挤进去 rubberMax，滑块被压在墙上变窄
        let rubberMax = g.d * 0.22
        func rubber(_ o: Double) -> Double { rubberMax * (1 - 1 / (o / (rubberMax * 2) + 1)) }
        var p = base + dx
        engine.set(.level, ltClamp(p / hi, 0, 1))
        if p < 0 { p = -rubber(-p) } else if p > hi { p = hi + rubber(p - hi) }

        let k = 900.0
        let trailK = k * (1 - 0.8 * s) + 60
        let leadSpring = LTSpringSpec.physics(stiffness: k, damping: 2 * k.squareRoot() * 0.9)
        let trailSpring = LTSpringSpec.physics(stiffness: trailK, damping: 2 * trailK.squareRoot() * 0.75)
        if dir >= 0 {
            engine.animate(.xr, to: p + kw, spec: leadSpring)
            engine.animate(.xl, to: p, spec: trailSpring)
        } else {
            engine.animate(.xl, to: p, spec: leadSpring)
            engine.animate(.xr, to: p + kw, spec: trailSpring)
        }
    }

    private func pointerUp(_ value: DragGesture.Value) {
        guard let st = engine.drag else { return }
        engine.drag = nil
        if !st.dragged {
            commit(!engine.committed)
            return
        }
        // 按松手时的位置 + 速度往前「投」一段再判断，甩一下就能切换
        let g = geo
        let kw = g.d + g.wide
        let v = Double(value.velocity.width)
        let center = (engine.xl + engine.xr) / 2 + ltClamp(v * 0.12, -g.T, g.T)
        let next = center > kw / 2 + (g.T - kw) / 2
        if next != engine.committed { commit(next) } else { settle(next) }
    }
}

/* ---------- 几何 ---------- */

private struct LTGeo {
    let W, H, pad, d, T, travel, wide: Double
    init(size: Double) {
        W = size
        H = (size * 0.58).rounded()
        pad = Swift.max(2, (H * 0.08).rounded())
        d = H - pad * 2 // 滑块直径
        T = W - pad * 2 // 轨道内宽
        travel = T - d
        wide = d * 0.24
    }
}

/// 由左右两条边推导出滑块的位置 / 宽度 / 纵向缩放；后沿越过前沿时保留最小宽度（被挤扁）
private struct LTEdges {
    let left, right, width, scaleY: Double
    init(xl: Double, xr: Double, g: LTGeo) {
        let minW = g.d * 0.62
        let R = ltClamp(xr, minW, g.T)
        let L = ltClamp(xl, 0, g.T - minW)
        let w = Swift.max(R - L, minW)
        left = Swift.min(L, R - minW)
        right = R
        width = w
        scaleY = w >= g.d ? 1 - Swift.min((w - g.d) / g.d, 1) * 0.2 : 1 + ((g.d - w) / g.d) * 0.4
    }
}

private func ltClamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }

private struct LTDrag {
    var lastDx: Double = 0
    var dragged = false
}

/* ---------- 颜色（style.css 浅色 / 深色） ---------- */

private struct LTPalette {
    let track: Color
    let knob: Color
    let knobBottom: Color // color-mix(in srgb, knob 92%, #000)
    let muted: Color
    let ring: Color

    static let light = LTPalette(
        track: Color(hex: "#E3E3E8"),
        knob: Color(hex: "#FFFFFF"),
        knobBottom: Color(.sRGB, white: 0.92, opacity: 1),
        muted: Color(hex: "#8A8A8A"),
        ring: Color.black.opacity(0.06)
    )
    static let dark = LTPalette(
        track: Color(hex: "#3A3A3E"),
        knob: Color(hex: "#F7F7F7"),
        knobBottom: Color(.sRGB, white: 247.0 / 255.0 * 0.92, opacity: 1),
        muted: Color(hex: "#777777"),
        ring: Color.white.opacity(0.06)
    )
}

/// 滑块：竖向渐变 + 三层阴影（0 0 0 .5px / 0 3px 8px / 0 1px 1px）
private struct LTKnob: View {
    let palette: LTPalette
    var body: some View {
        ZStack {
            Capsule()
                .fill(palette.knob)
                .shadow(color: .black.opacity(0.16), radius: 4, x: 0, y: 3)
            Capsule()
                .fill(palette.knob)
                .shadow(color: .black.opacity(0.08), radius: 0.5, x: 0, y: 1)
            Capsule()
                .fill(LinearGradient(colors: [palette.knob, palette.knobBottom], startPoint: .top, endPoint: .bottom))
            Capsule()
                .inset(by: -0.25)
                .stroke(Color.black.opacity(0.04), lineWidth: 0.5)
        }
    }
}

private struct LTBlur: ViewModifier {
    let radius: CGFloat
    func body(content: Content) -> some View { content.blur(radius: radius) }
}

/* ---------- 弹簧（与 motion v14 一致） ---------- */

/// motion 的两种弹簧：
/// - `{ stiffness, damping, mass }`：物理弹簧，中途改目标时继承当前速度，按静止阈值结束
/// - `{ duration, bounce }`：motion 用 findSpring 求出 stiffness / damping，使弹簧在 duration 内基本停稳；
///   不继承速度，到 duration 时落到终点。注意它和 SwiftUI 的 spring(duration:bounce:)（感知时长）不同，
///   同样 0.5s 下 motion 的刚度约是 SwiftUI 的 2.7 倍，所以这里不用 Animation.motionSpring(duration:bounce:)
private struct LTSpringSpec {
    var stiffness: Double
    var damping: Double
    var mass: Double = 1
    var timed = false
    var duration: Double = 0

    static func physics(stiffness: Double, damping: Double, mass: Double = 1) -> LTSpringSpec {
        LTSpringSpec(stiffness: stiffness, damping: damping, mass: mass)
    }

    /// 按压变宽：{ stiffness: 520, damping: 34 }
    static let quick = physics(stiffness: 520, damping: 34)

    /// motion-dom spring.mjs 的 findSpring（bounce ≥ 0 的部分），逐行移植
    static func timed(duration durationSec: Double, bounce: Double) -> LTSpringSpec {
        let safeMin = 0.001
        let ratio = Swift.max(1 - bounce, 0.05)
        let duration = ltClamp(durationSec, 0.01, 10)
        func angular(_ f: Double, _ r: Double) -> Double { f * (1 - r * r).squareRoot() }
        let envelope: (Double) -> Double
        let derivative: (Double) -> Double
        if ratio < 1 {
            envelope = { f in
                let decay = f * ratio
                let delta = decay * duration
                return safeMin - (decay / angular(f, ratio)) * exp(-delta)
            }
            derivative = { f in
                let decay = f * ratio
                let delta = decay * duration
                let e = ratio * ratio * f * f * duration
                let ff = exp(-delta)
                let g = angular(f * f, ratio)
                let factor: Double = -envelope(f) + safeMin > 0 ? -1 : 1
                return (factor * -e * ff) / g
            }
        } else {
            envelope = { f in -safeMin + exp(-f * duration) * (f * duration + 1) }
            derivative = { f in exp(-f * duration) * (-f * duration * duration) }
        }
        var f = 5 / duration
        for _ in 1..<12 { f -= envelope(f) / derivative(f) }
        var stiffness = f * f
        var damping = ratio * 2 * stiffness.squareRoot()
        if !(stiffness > 0 && stiffness.isFinite) || !(damping >= 0 && damping.isFinite) {
            stiffness = 100
            damping = 10
        }
        return LTSpringSpec(stiffness: stiffness, damping: damping, mass: 1, timed: true, duration: duration)
    }
}

/// 一段正在进行的弹簧（解析解）
private struct LTSpring {
    let spec: LTSpringSpec
    let from: Double
    let to: Double
    let v0: Double
    let begin: CFTimeInterval // 已含 delay

    func sample(_ now: CFTimeInterval) -> (x: Double, v: Double, done: Bool) {
        let t = now - begin
        // delay 期间停在起点（motion 会立即停掉旧动画再等待）
        if t < 0 { return (from, 0, false) }
        let k = spec.stiffness, c = spec.damping, m = spec.mass
        let zeta = c / (2 * (k * m).squareRoot())
        let w0 = (k / m).squareRoot()
        let delta = to - from
        let e: Double
        let de: Double
        if zeta < 1 {
            let a = zeta * w0
            let wd = w0 * (1 - zeta * zeta).squareRoot()
            let A = (-v0 + a * delta) / wd
            let env = exp(-a * t)
            let s = sin(wd * t), co = cos(wd * t)
            e = env * (delta * co + A * s)
            de = env * ((-a * delta + A * wd) * co + (-a * A - delta * wd) * s)
        } else if zeta == 1 {
            let B = -v0 + w0 * delta
            let env = exp(-w0 * t)
            e = env * (delta + B * t)
            de = env * (B - w0 * (delta + B * t))
        } else {
            let wd = w0 * (zeta * zeta - 1).squareRoot()
            let slow = zeta * w0 - wd, fast = zeta * w0 + wd
            let C1 = (fast * delta - v0) / (fast - slow)
            let C2 = delta - C1
            e = C1 * exp(-slow * t) + C2 * exp(-fast * t)
            de = -slow * C1 * exp(-slow * t) - fast * C2 * exp(-fast * t)
        }
        let x = to - e
        let v = -de
        let done: Bool
        if spec.timed {
            done = t >= spec.duration
        } else {
            let granular = abs(delta) < 5
            done = abs(v) <= (granular ? 0.01 : 2) && abs(to - x) <= (granular ? 0.005 : 0.5)
        }
        return done ? (to, 0, true) : (x, v, false)
    }
}

/// 驱动 xl / xr / level 三个值的小引擎（相当于 motion 的 MotionValue + animate）
@Observable
private final class LTEngine {
    enum Channel: Hashable { case xl, xr, level }

    var xl: Double = 0
    var xr: Double = 0
    var level: Double = 0

    @ObservationIgnored var committed = false
    @ObservationIgnored var drag: LTDrag?
    @ObservationIgnored private var springs: [Channel: LTSpring] = [:]
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private lazy var proxy = LTLinkProxy(engine: self)

    init(on: Bool = false, geo g: LTGeo = LTGeo(size: 96)) {
        committed = on
        xl = on ? g.travel : 0
        xr = on ? g.T : g.d
        level = on ? 1 : 0
    }

    deinit { link?.invalidate() }

    func value(_ ch: Channel) -> Double {
        switch ch {
        case .xl: return xl
        case .xr: return xr
        case .level: return level
        }
    }

    private func write(_ ch: Channel, _ v: Double) {
        switch ch {
        case .xl: if xl != v { xl = v }
        case .xr: if xr != v { xr = v }
        case .level: if level != v { level = v }
        }
    }

    /// 停掉动画并立即跳到某值
    func jump(_ ch: Channel, _ v: Double) {
        springs[ch] = nil
        write(ch, v)
    }

    /// 拖动时直接设值（同样会停掉正在进行的动画）
    func set(_ ch: Channel, _ v: Double) { jump(ch, v) }

    func animate(_ ch: Channel, to target: Double, spec: LTSpringSpec, delay: Double = 0) {
        let now = CACurrentMediaTime()
        var from = value(ch)
        var velocity = 0.0
        if let running = springs[ch] {
            let s = running.sample(now)
            from = s.x
            velocity = s.v
        }
        springs[ch] = LTSpring(spec: spec, from: from, to: target, v0: spec.timed ? 0 : velocity, begin: now + delay)
        write(ch, from)
        startLink()
    }

    private func startLink() {
        guard link == nil else { return }
        let l = CADisplayLink(target: proxy, selector: #selector(LTLinkProxy.tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    fileprivate func tick() {
        let now = CACurrentMediaTime()
        for (ch, spring) in springs {
            let s = spring.sample(now)
            write(ch, s.x)
            if s.done { springs[ch] = nil }
        }
        if springs.isEmpty {
            link?.invalidate()
            link = nil
        }
    }
}

private final class LTLinkProxy: NSObject {
    weak var engine: LTEngine?
    init(engine: LTEngine) { self.engine = engine }
    @objc func tick(_ link: CADisplayLink) { engine?.tick() }
}

#Preview {
    struct Demo: View {
        @State private var on = true
        var body: some View {
            VStack(spacing: 40) {
                LiquidToggle()
                LiquidToggle(isOn: $on, color: Color(hex: "#FF5FA2"), stretch: 1, duration: 0.75, bounce: 0.6)
                LiquidToggle(color: Color(hex: "#0A84FF"), stretch: 0.2, size: 128, duration: 0.3, bounce: 0.1)
            }
            .padding(40)
        }
    }
    return Demo()
}
