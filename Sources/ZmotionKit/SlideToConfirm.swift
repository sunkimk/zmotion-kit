// 滑动确认（Slide to confirm）：按住滑块往右拖，提示文字渐隐（可带一道扫过的流光）、底色跟着滑块铺开，拉过头有橡皮筋阻力；
// 没到终点松手就带着离手速度弹回；拉到头或用力一甩，轨道收成圆形转圈，再画出对勾，外面扩散一圈。
// 网页演示里的订单页、手机状态栏、导航栏、支付弹层（下拉把手、标题、金额、明细、页脚）原生端都不画——
// 宿主 App 用自己的 sheet / 弹窗承载这条滑轨；确认动作走 onConfirm 交给宿主，复位用 isConfirmed 绑定或 resetAfter。
//
// 动效说明：滑块位置 x（手指给的原始值，可超出两端）和轨道收拢量 open 是「可打断、带离手速度」的弹簧，
// 用 SwiftUI 的 Spring(mass:stiffness:damping:)（和 Animation.motionSpring 同一个弹簧模型）逐帧求值；
// 铺开的底色、提示文字位置 / 透明度、箭头透明度都由 x 每帧推出来，和网站版的 useTransform 一致。
// 出现 / 消失这类声明式的小动画（滑块缩放、锁、转圈、对勾、轨道底色）直接用 Animation.motionSpring / timingCurve。
import SwiftUI
import UIKit

public struct SlideToConfirm: View {
    /// 组件所处的阶段：待滑动 / 处理中（转圈）/ 成功（对勾）
    public enum Phase: String, Sendable {
        case idle, loading, success
    }

    private let isConfirmed: Binding<Bool>?
    private let color: Color
    private let ratio: Double
    private let shimmer: Bool
    private let stiffness: Double
    private let label: String
    private let successLabel: String
    private let resetAfter: Double?
    private let haptics: Bool
    private let onConfirm: (@MainActor () async -> Bool)?
    private let onPhaseChange: ((Phase) -> Void)?

    @State private var model = STCModel()
    @GestureState private var touching = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - isConfirmed: 可选绑定。成功时组件把它置为 true；宿主把它改回 false 即复位（宿主置 true 不会触发确认）
    ///   - color: 滑块、铺开的底色和成功状态的颜色
    ///   - ratio: 拖过轨道的多少比例松手才算确认；甩得快时按落点判断（0.6–1）
    ///   - shimmer: 提示文字上是否有一道扫过的高光
    ///   - stiffness: 没拉到头松手时弹回的速度，越大回得越快（120–900）
    ///   - label: 轨道上的提示文字，同时作为读屏标签
    ///   - successLabel: 成功后的读屏标签（网页版弹层标题的「支付成功」）
    ///   - resetAfter: 成功后几秒自动复位（网页版 2.1s）；nil 表示停在成功态，由宿主复位或直接关掉弹层
    ///   - haptics: 触感反馈（网站版的音效在原生端换成触感，时机相同）
    ///   - onConfirm: 滑到头后调用，转圈期间等待它返回：true → 对勾；false → 弹回待滑动。不传则按网页演示的节奏直接成功。
    ///     转圈至少持续到网页版的 1.5s 节点，再快的结果也等到那时才变对勾
    ///   - onPhaseChange: 阶段变化回调（宿主可借此切换弹层标题，比如「确认支付」→「支付成功」）
    public init(
        isConfirmed: Binding<Bool>? = nil,
        color: Color = Color(hex: "#16A34A"),
        ratio: Double = 0.9,
        shimmer: Bool = true,
        stiffness: Double = 420,
        label: String = "滑动确认支付",
        successLabel: String = "支付成功",
        resetAfter: Double? = 2.1,
        haptics: Bool = true,
        onConfirm: (@MainActor () async -> Bool)? = nil,
        onPhaseChange: ((Phase) -> Void)? = nil
    ) {
        self.isConfirmed = isConfirmed
        self.color = color
        self.ratio = ratio
        self.shimmer = shimmer
        self.stiffness = stiffness
        self.label = label
        self.successLabel = successLabel
        self.resetAfter = resetAfter
        self.haptics = haptics
        self.onConfirm = onConfirm
        self.onPhaseChange = onPhaseChange
    }

    public var body: some View {
        let _ = configureModel()
        GeometryReader { geo in
            content(width: geo.size.width)
        }
        .frame(height: stcH)
        .onAppear {
            model.appear()
        }
        .onDisappear { model.disappear() }
        .onChange(of: isConfirmed?.wrappedValue) { _, newValue in
            // 宿主把绑定改回 false → 复位
            if newValue == false, model.phase != .idle || model.busy { model.reset() }
        }
        .onChange(of: touching) { _, isTouching in
            // 手势被系统打断时 onEnded 不会触发，这里兜底（相当于 pointercancel）
            guard !isTouching else { return }
            DispatchQueue.main.async {
                if model.drag != nil { model.pointerUp(velocity: 0) }
            }
        }
    }

    private func configureModel() {
        model.ratio = ratio
        model.stiffness = stiffness
        model.haptics = haptics
        model.reduceMotion = reduceMotion
        model.resetAfter = resetAfter
        model.onConfirm = onConfirm
        model.onPhaseChange = onPhaseChange
        if let isConfirmed {
            model.setConfirmed = { v in if isConfirmed.wrappedValue != v { isConfirmed.wrappedValue = v } }
        } else {
            model.setConfirmed = nil
        }
    }

    // MARK: - 画面

    private func content(width w: CGFloat) -> some View {
        let p = STCPalette(dark: colorScheme == .dark)
        let m = model.maxX
        let v = model.x.value
        let kx = stcKnobX(v, m)
        let prog = m > 0 ? stcClamp(v / m, 0, 1) : 0
        let idle = model.phase == .idle
        // 轨道宽度：待滑动时铺满，处理中 / 成功收成 60 的圆
        let trackW = stcH + max(0, Double(w) - stcH) * model.open.value

        return ZStack {
            // 成功时从轨道后面扩散出去的一圈
            Circle()
                .fill(color)
                .frame(width: stcH, height: stcH)
                .keyframeAnimator(initialValue: STCRing(), trigger: model.ringCount) { view, r in
                    view.scaleEffect(r.scale).opacity(r.opacity)
                } keyframes: { _ in
                    KeyframeTrack(\.scale) {
                        MoveKeyframe(1)
                        LinearKeyframe(2.1, duration: 0.7, timingCurve: stcRingCurve)
                    }
                    KeyframeTrack(\.opacity) {
                        MoveKeyframe(0.5)
                        LinearKeyframe(0, duration: 0.7, timingCurve: stcRingCurve)
                    }
                }
                .allowsHitTesting(false)

            track(p: p, idle: idle, kx: kx, prog: prog, trackW: trackW)
        }
        .frame(width: w, height: stcH)
        .onChange(of: w, initial: true) { _, newW in
            // 只在待滑动时更新可拖距离（和网页版的 ResizeObserver 一样）
            if !model.busy { model.maxX = max(0, Double(newW) - stcH) }
        }
    }

    private func track(p: STCPalette, idle: Bool, kx: Double, prog: Double, trackW: Double) -> some View {
        ZStack(alignment: .leading) {
            // 轨道底色：待滑动是浅灰，处理中 / 成功变成主色（离开 0.16s、回来 0.3s，easeInOut）
            Capsule()
                .fill(idle ? p.track : color)
                .animation(.timingCurve(0.42, 0, 0.58, 1, duration: idle ? 0.3 : 0.16), value: idle)

            // 跟着滑块铺开的底色：宽度 = 滑块位置 + 一个滑块，透明度 0.4 → 1
            Capsule()
                .fill(color.opacity(0.22))
                .opacity(idle ? 1 : 0)
                .animation(idle ? nil : stcEase03, value: idle)
                .opacity(0.4 + 0.6 * prog)
                .frame(width: max(kx, 0) + stcKnob + stcPad * 2, height: stcH)
                // 网页版的这层底色是绝对定位、不参与排版。这里外面再套一层轨道宽的框：
                // 否则收成圆时它（约等于整条轨道宽）会把 ZStack 撑宽，左对齐的转圈 / 对勾被推出 60 宽的圆、被裁掉
                .frame(width: trackW, height: stcH, alignment: .leading)

            // 提示文字：拖到一半时完全淡出，同时跟着滑块走 0.3 倍
            hint(p: p, idle: idle)
                .opacity(idle ? 1 : 0)
                .animation(idle ? nil : stcEase03, value: idle)
                .opacity(stcClamp(1 - prog / 0.5, 0, 1))
                .offset(x: 20 + kx * 0.3)
                .frame(width: trackW, height: stcH)
                .allowsHitTesting(false)

            knob(idle: idle, prog: prog)
                .offset(x: stcPad + kx)

            // 处理中：转圈；成功：画出对勾
            ZStack {
                spinner
                check
            }
            .frame(width: trackW, height: stcH)
            .allowsHitTesting(false)
        }
        .frame(width: trackW, height: stcH)
        .clipShape(Capsule())
        .contentShape(Capsule())
        .gesture(dragGesture)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.phase == .success ? successLabel : label)
        .accessibilityValue(model.phase == .loading ? "处理中" : "")
        .accessibilityHint(idle ? "轻点两下确认" : "")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.complete(velocity: nil) }
    }

    /// 提示文字（左边留 40 给滑块）；流光是一道 2.4s 匀速从左扫到右的高光，背景宽 250%，高光在 42%–58%
    @ViewBuilder
    private func hint(p: STCPalette, idle: Bool) -> some View {
        let text = Text(label)
            .font(.system(size: 16, weight: .semibold))
            .tracking(16 * 0.08)
            .lineLimit(1)
        let box = text.padding(.leading, 40).fixedSize()
        if shimmer && !reduceMotion {
            TimelineView(.animation(minimumInterval: nil, paused: !idle)) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate
                let phase = t.truncatingRemainder(dividingBy: 2.4) / 2.4
                // background-position 100% → 0%：渐变条的左端从 -1.5W 走到 0
                let start = -1.5 * (1 - phase)
                box.hidden()
                    .overlay {
                        LinearGradient(
                            stops: [
                                .init(color: p.hint, location: 0),
                                .init(color: p.hint, location: 0.42),
                                .init(color: p.hintHi, location: 0.5),
                                .init(color: p.hint, location: 0.58),
                                .init(color: p.hint, location: 1),
                            ],
                            startPoint: UnitPoint(x: start, y: 0.5),
                            endPoint: UnitPoint(x: start + 2.5, y: 0.5)
                        )
                        .mask { box }
                    }
            }
        } else {
            box.foregroundStyle(p.hint)
        }
    }

    /// 滑块：主色圆 + 两层阴影；箭头在 60%–90% 进度间淡出，到达确认线时锁弹出来
    private func knob(idle: Bool, prog: Double) -> some View {
        ZStack {
            Circle()
                .fill(color)
                .shadow(color: .black.opacity(0.16), radius: 3, x: 0, y: 2)
                .shadow(color: color.opacity(0.35), radius: 8, x: 0, y: 6)

            // 箭头：每 1.6s 向右招一下手
            TimelineView(.animation(minimumInterval: nil, paused: reduceMotion || !idle)) { ctx in
                STCChevrons()
                    .stroke(.white, style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                    .frame(width: 24, height: 24)
                    .offset(x: reduceMotion ? 0 : stcBeckon(ctx.date.timeIntervalSinceReferenceDate))
            }
            .opacity(1 - stcClamp((prog - 0.6) / 0.3, 0, 1))

            STCLock()
                .stroke(.white, style: StrokeStyle(lineWidth: 2.4 * 20 / 24, lineCap: .round, lineJoin: .round))
                .frame(width: 20, height: 20)
                .scaleEffect(model.armed ? 1 : 0.3)
                .opacity(model.armed ? 1 : 0)
                .animation(.motionSpring(stiffness: 600, damping: 20), value: model.armed)
        }
        .frame(width: stcKnob, height: stcKnob)
        // 按下缩一点（0.09s），松开弹回
        .scaleEffect(model.pressed ? 0.94 : 1)
        .animation(model.pressed ? .timingCurve(0.42, 0, 0.58, 1, duration: 0.09) : .motionSpring(stiffness: 520, damping: 26), value: model.pressed)
        // 离场：0.15s 缩到 0.4 并淡出；复位时从 0.4 弹回来
        .scaleEffect(idle ? 1 : 0.4)
        .opacity(idle ? 1 : 0)
        .animation(idle ? .motionSpring(stiffness: 520, damping: 26) : .timingCurve(0.42, 0, 0.58, 1, duration: 0.15), value: idle)
        .allowsHitTesting(false)
    }

    private var spinner: some View {
        let on = model.phase == .loading
        return TimelineView(.animation(minimumInterval: nil, paused: model.phase == .idle)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            Circle()
                .trim(from: 0, to: 0.65)
                .stroke(.white, style: StrokeStyle(lineWidth: 2.6 * stcIcon, lineCap: .round))
                .frame(width: 18 * stcIcon, height: 18 * stcIcon)
                .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 0.75) / 0.75 * 360))
        }
        .frame(width: 28, height: 28)
        // 进场晚 0.2s：透明度走默认 0.3s 曲线，缩放走 motion 默认的 scale 弹簧（550 / 30）
        .scaleEffect(on ? 1 : 0.6)
        .animation(.motionSpring(stiffness: 550, damping: 30).delay(on ? 0.2 : 0), value: on)
        .opacity(on ? 1 : 0)
        .animation(stcEase03.delay(on ? 0.2 : 0), value: on)
    }

    private var check: some View {
        let on = model.phase == .success
        return STCCheck()
            .trim(from: 0, to: model.checkDraw)
            .stroke(.white, style: StrokeStyle(lineWidth: 2.8 * stcIcon, lineCap: .round, lineJoin: .round))
            // 笔画 0.35s 画出来（晚 0.05s）；放在缩放弹簧里面，不被它覆盖
            .animation(model.checkDraw > 0 ? .timingCurve(0.3, 0, 0.2, 1, duration: 0.35).delay(0.05) : nil, value: model.checkDraw)
            .frame(width: 28, height: 28)
            .scaleEffect(on ? 1 : 0.5)
            .animation(.motionSpring(stiffness: 500, damping: 15), value: on)
            // 进场时不淡入（网页版只从 0.5 放大），离场才淡出
            .opacity(on ? 1 : 0)
            .animation(on ? nil : .motionSpring(stiffness: 500, damping: 15), value: on)
    }

    // MARK: - 手势（整条轨道只挂这一个手势：按在滑块上是拖动，按在空白处是轻轻探一下）

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($touching) { _, state, _ in state = true }
            .onChanged { value in
                if model.drag == nil {
                    model.pointerDown(at: Double(value.startLocation.x))
                }
                model.pointerMove(dx: Double(value.translation.width))
            }
            .onEnded { value in
                model.pointerUp(velocity: Double(value.velocity.width))
            }
    }
}

// MARK: - 尺寸、曲线

private let stcH = 60.0
private let stcKnob = 52.0
private let stcPad = (stcH - stcKnob) / 2
/// 转圈和对勾是 24 的 viewBox 画在 28 的框里
private let stcIcon = 28.0 / 24.0
/// motion 默认的透明度过渡：0.3s，cubic-bezier(0.25, 0.1, 0.35, 1)
private let stcEase03 = Animation.timingCurve(0.25, 0.1, 0.35, 1, duration: 0.3)
private let stcRingCurve = UnitCurve.bezier(startControlPoint: UnitPoint(x: 0.2, y: 0.7), endControlPoint: UnitPoint(x: 0.3, y: 1))

private func stcClamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }

/// 拉过两端时的橡皮筋：越拉越拉不动，最多再多出十来像素
private func stcBand(_ over: Double) -> Double { (1 - 1 / ((over * 0.55) / 40 + 1)) * 40 }

/// 手指给的原始位置 → 画面上的滑块位置（两端过头部分按橡皮筋换算）
private func stcKnobX(_ v: Double, _ m: Double) -> Double {
    if v < 0 { return -stcBand(-v) * 0.5 }
    if v > m { return m + stcBand(v - m) * 0.5 }
    return v
}

/// CSS cubic-bezier(x1, y1, x2, y2) 在进度 p 处的值
private func stcBezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ p: Double) -> Double {
    if p <= 0 { return 0 }
    if p >= 1 { return 1 }
    let cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
    let cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
    var t = p
    for _ in 0..<8 {
        let x = ((ax * t + bx) * t + cx) * t - p
        if abs(x) < 1e-7 { break }
        let d = (3 * ax * t + 2 * bx) * t + cx
        if abs(d) < 1e-6 { break }
        t -= x / d
    }
    t = stcClamp(t, 0, 1)
    return ((ay * t + by) * t + cy) * t
}

/// 箭头招手：1.6s 一轮，0–25% 右移 3、25–55% 回来、之后停住；每段 cubic-bezier(0.33, 0.55, 0.2, 1)
private func stcBeckon(_ time: Double) -> Double {
    let q = time.truncatingRemainder(dividingBy: 1.6) / 1.6
    if q < 0.25 { return 3 * stcBezier(0.33, 0.55, 0.2, 1, q / 0.25) }
    if q < 0.55 { return 3 * (1 - stcBezier(0.33, 0.55, 0.2, 1, (q - 0.25) / 0.3)) }
    return 0
}

private struct STCRing {
    var scale = 1.0
    var opacity = 0.0
}

/// 颜色（来自 style.css，浅色 / 深色各一套）
private struct STCPalette {
    let dark: Bool
    var track: Color { dark ? Color(hex: "#26262B") : Color(hex: "#EEF0F3") }
    var hint: Color { dark ? Color(hex: "#6E6E74") : Color(hex: "#9A9AA0") }
    var hintHi: Color { dark ? Color(hex: "#FFFFFF") : Color(hex: "#1A1A1A") }
}

// MARK: - 图标（lucide 的路径，24 的 viewBox 按框缩放）

/// chevrons-right：m6 17 5-5-5-5 / m13 17 5-5-5-5
private struct STCChevrons: Shape {
    func path(in rect: CGRect) -> Path {
        let k = rect.width / 24
        var p = Path()
        for x0 in [6.0, 13.0] {
            p.move(to: CGPoint(x: x0 * k, y: 17 * k))
            p.addLine(to: CGPoint(x: (x0 + 5) * k, y: 12 * k))
            p.addLine(to: CGPoint(x: x0 * k, y: 7 * k))
        }
        return p.offsetBy(dx: rect.minX, dy: rect.minY)
    }
}

/// lock：rect(3, 11, 18, 11, r2) + M7 11V7a5 5 0 0 1 10 0v4
private struct STCLock: Shape {
    func path(in rect: CGRect) -> Path {
        let k = rect.width / 24
        var p = Path()
        p.addRoundedRect(in: CGRect(x: 3 * k, y: 11 * k, width: 18 * k, height: 11 * k), cornerSize: CGSize(width: 2 * k, height: 2 * k))
        p.move(to: CGPoint(x: 7 * k, y: 11 * k))
        p.addLine(to: CGPoint(x: 7 * k, y: 7 * k))
        p.addArc(center: CGPoint(x: 12 * k, y: 7 * k), radius: 5 * k, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: 17 * k, y: 11 * k))
        return p.offsetBy(dx: rect.minX, dy: rect.minY)
    }
}

/// 对勾：M6 12.5l4 4L18 8.5
private struct STCCheck: Shape {
    func path(in rect: CGRect) -> Path {
        let k = rect.width / 24
        var p = Path()
        p.move(to: CGPoint(x: 6 * k, y: 12.5 * k))
        p.addLine(to: CGPoint(x: 10 * k, y: 16.5 * k))
        p.addLine(to: CGPoint(x: 18 * k, y: 8.5 * k))
        return p.offsetBy(dx: rect.minX, dy: rect.minY)
    }
}

// MARK: - 状态和手势逻辑

@MainActor
@Observable
private final class STCModel {
    /// 手指给的「原始」位置，可以超出 [0, maxX]；画面上用橡皮筋换算
    let x = STCValue(0)
    /// 轨道展开量：1 铺满，0 收成圆
    let open = STCValue(1)
    /// 画面阶段（网页版的 state）
    var phase: SlideToConfirm.Phase = .idle
    var armed = false
    var pressed = false
    var maxX: Double = 240
    var checkDraw: Double = 0
    var ringCount = 0

    /// 逻辑上已经确认（网页版 live.state !== "idle"，比画面早 140ms）
    @ObservationIgnored var busy = false
    @ObservationIgnored var drag: Drag?
    @ObservationIgnored private var touched = false
    /// 每次复位 / 消失加一，过期的定时器和回调据此作废
    @ObservationIgnored private var generation = 0

    @ObservationIgnored var ratio = 0.9
    @ObservationIgnored var stiffness = 420.0
    @ObservationIgnored var haptics = true
    @ObservationIgnored var reduceMotion = false
    @ObservationIgnored var resetAfter: Double? = 2.1
    @ObservationIgnored var onConfirm: (@MainActor () async -> Bool)?
    @ObservationIgnored var onPhaseChange: ((SlideToConfirm.Phase) -> Void)?
    @ObservationIgnored var setConfirmed: ((Bool) -> Void)?

    struct Drag {
        var from: Double
        var onKnob: Bool
        var moved = false
    }

    init() {
        x.onChange = { [weak self] v in self?.xChanged(v) }
    }

    /// 到达确认线时锁弹出来，轻触一下
    private func xChanged(_ v: Double) {
        guard !busy else { return }
        let next = v >= maxX * ratio - 0.5
        if next != armed {
            armed = next
            if next { Haptics.tap(haptics) }
        }
    }

    private func later(_ seconds: Double, _ fn: @escaping @MainActor () -> Void) {
        let gen = generation
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, self.generation == gen else { return }
            fn()
        }
    }

    func appear() {
        // 进场后轻轻探一下，告诉人这里能拖（减弱动态效果时不探）
        later(1.1) { [weak self] in
            guard let self, !self.touched, !self.busy, !self.reduceMotion else { return }
            self.nudge()
        }
    }

    func disappear() {
        generation += 1
        x.stop()
        open.stop()
    }

    // MARK: 弹簧

    /// 弹回起点：ζ≈0.55，撞到左端时被橡皮筋吃掉，不会穿墙
    func springBack(velocity: Double?) {
        let k = stiffness
        x.animate(to: 0, STCSpring(stiffness: k, damping: 1.1 * k.squareRoot()), velocity: velocity, restDelta: 0.3)
    }

    func nudge() {
        x.stop()
        // 中途被手指打断（stop 不会回调）就不再弹回，交给拖动
        x.animate(to: min(40, maxX * 0.2), STCSpring(stiffness: 520, damping: 20), restDelta: 2) { [weak self] in
            guard let self, !self.busy, self.drag == nil else { return }
            self.springBack(velocity: nil)
        }
    }

    // MARK: 拖动

    func pointerDown(at locX: Double) {
        guard !busy else { return }
        touched = true
        let left = stcPad + stcKnobX(x.value, maxX)
        if locX >= left && locX <= left + stcKnob {
            x.stop()
            drag = Drag(from: x.value, onKnob: true)
            pressed = true
        } else {
            // 点轨道空白处：滑块轻轻探一下，提示可以拖
            drag = Drag(from: 0, onKnob: false)
            nudge()
            Haptics.tap(haptics)
        }
    }

    func pointerMove(dx: Double) {
        guard var d = drag, d.onKnob, !busy else { return }
        if abs(dx) > 3 { d.moved = true }
        drag = d
        x.set(d.from + dx)
    }

    func pointerUp(velocity vel: Double) {
        guard let d = drag else { return }
        drag = nil
        guard d.onKnob else { return }
        pressed = false
        guard !busy else { return }
        let m = maxX
        let v = x.value
        // 甩得够快：按 0.12s 后的落点判断，不必真拖到头
        let projected = v + max(0, vel) * 0.12
        if v >= m * ratio - 0.5 || (vel > 600 && projected >= m * ratio) {
            complete(velocity: vel)
        } else if !d.moved {
            nudge()
        } else {
            springBack(velocity: vel)
        }
    }

    // MARK: 确认 → 处理中 → 成功 / 复位

    /// velocity 为 nil 时沿用当前动画的速度（读屏双击确认时）
    func complete(velocity: Double?) {
        guard !busy else { return }
        busy = true
        drag = nil
        checkDraw = 0
        x.animate(to: maxX, STCSpring(stiffness: 700, damping: 44), velocity: velocity)
        let started = CACurrentMediaTime()
        later(0.14) { [weak self] in self?.enterLoading() }

        let gen = generation
        let confirm = onConfirm
        Task { @MainActor [weak self] in
            var ok = true
            if let confirm { ok = await confirm() }
            guard let self, self.generation == gen else { return }
            // 转圈至少到网页版的 1.5s 节点再出结果
            let wait = max(0, 1.5 - (CACurrentMediaTime() - started))
            self.later(wait) { [weak self] in
                guard let self else { return }
                if ok { self.succeed() } else { self.reset() }
            }
        }
    }

    private func enterLoading() {
        armed = false
        pressed = false
        phase = .loading
        // 轨道收成圆：晚 0.06s 起步，弹簧 340 / 30
        open.animate(to: 0, STCSpring(stiffness: 340, damping: 30), delay: 0.06)
        Haptics.pop(haptics)
        onPhaseChange?(.loading)
    }

    private func succeed() {
        phase = .success
        if !reduceMotion { ringCount += 1 }
        checkDraw = 1
        Haptics.success(haptics)
        setConfirmed?(true)
        onPhaseChange?(.success)
        if let r = resetAfter {
            later(max(0, r)) { [weak self] in self?.reset() }
        }
    }

    /// 回到待滑动：滑块瞬间回到起点，轨道弹回铺满，滑块从 0.4 弹出来
    func reset() {
        generation += 1
        drag = nil
        pressed = false
        armed = false
        busy = false
        x.set(0)
        if open.value < 1 || open.isAnimating {
            open.animate(to: 1, STCSpring(stiffness: 300, damping: 30))
        }
        if phase != .idle {
            phase = .idle
            onPhaseChange?(.idle)
        }
        setConfirmed?(false)
    }
}

// MARK: - 逐帧弹簧（对应 motion 的 MotionValue + animate）

/// 弹簧参数（和网站版 motion 的 stiffness / damping / mass 一一对应）
private struct STCSpring {
    var stiffness: Double
    var damping: Double
    var mass: Double = 1
    var spring: Spring { Spring(mass: mass, stiffness: stiffness, damping: damping) }
}

@MainActor
private final class STCTicker: NSObject {
    static let shared = STCTicker()
    private var link: CADisplayLink?
    private var items: [ObjectIdentifier: STCValue] = [:]

    func add(_ m: STCValue) {
        items[ObjectIdentifier(m)] = m
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    func remove(_ m: STCValue) { items[ObjectIdentifier(m)] = nil }

    @objc private func tick(_ l: CADisplayLink) {
        let now = l.targetTimestamp
        for (id, m) in items where !m.step(now) && !m.isAnimating {
            items[id] = nil
        }
        if items.isEmpty {
            link?.invalidate()
            link = nil
        }
    }
}

/// 一个会动的数：set 立即改值；animate 用弹簧过去（默认带上当前速度）；stop 停在当前帧，可随时被手指接住
@MainActor
@Observable
private final class STCValue {
    var value: Double
    @ObservationIgnored var onChange: ((Double) -> Void)?
    @ObservationIgnored private var run: Run?

    private struct Run {
        var from: Double
        var to: Double
        var v0: Double
        var spring: Spring
        var start: CFTimeInterval
        var restDelta: Double
        var restSpeed: Double
        var done: (() -> Void)?
    }

    init(_ v: Double) { value = v }

    var isAnimating: Bool { run != nil }

    /// 当前速度（单位 / 秒）
    var velocity: Double {
        guard let r = run else { return 0 }
        let t = CACurrentMediaTime() - r.start
        guard t > 0 else { return 0 }
        return r.spring.velocity(target: r.to - r.from, initialVelocity: r.v0, time: t)
    }

    func stop() {
        guard run != nil else { return }
        run = nil
        STCTicker.shared.remove(self)
    }

    func set(_ v: Double) {
        stop()
        value = v
        onChange?(v)
    }

    /// 和 motion 的 animate(value, to, { type: "spring", stiffness, damping, velocity, restDelta, delay }) 一样；
    /// delay 期间停在原地不动；completion 只在自然停稳时调用，被 stop / 新动画打断不调用
    func animate(to target: Double, _ s: STCSpring, velocity: Double? = nil, restDelta: Double? = nil, delay: Double = 0, completion: (() -> Void)? = nil) {
        let v0 = delay > 0 ? 0 : (velocity ?? self.velocity)
        // motion 的默认收尾阈值：变化量很小（< 5，比如进度）时用更细的阈值
        let granular = abs(target - value) < 5
        run = Run(
            from: value, to: target, v0: v0, spring: s.spring, start: CACurrentMediaTime() + delay,
            restDelta: restDelta ?? (granular ? 0.005 : 0.5),
            restSpeed: granular ? 0.01 : 2,
            done: completion
        )
        STCTicker.shared.add(self)
    }

    /// 走一帧；返回 false 表示这一段动画结束了
    func step(_ now: CFTimeInterval) -> Bool {
        guard let r = run else { return false }
        let t = now - r.start
        if t <= 0 { return true }
        let d = r.to - r.from
        let p = r.from + r.spring.value(target: d, initialVelocity: r.v0, time: t)
        let v = r.spring.velocity(target: d, initialVelocity: r.v0, time: t)
        if abs(r.to - p) <= r.restDelta && abs(v) <= r.restSpeed {
            run = nil
            value = r.to
            onChange?(r.to)
            r.done?()
            return false
        }
        value = p
        onChange?(p)
        return true
    }
}

// MARK: - 预览

#Preview("手机 · 三组预设") {
    VStack(spacing: 28) {
        SlideToConfirm(onConfirm: {
            try? await Task.sleep(for: .seconds(0.8))
            return true
        })
        SlideToConfirm(color: Color(hex: "#F97316"), ratio: 0.7, shimmer: false, stiffness: 800)
        SlideToConfirm(color: Color(hex: "#7C3AED"), ratio: 0.95, shimmer: true, stiffness: 140)
    }
    .padding(20)
}

#Preview("手机 · 放在宿主的支付弹层里") {
    STCSheetDemo()
}

#Preview("iPad · 居中弹窗宽度") {
    // 网页版 iPad 弹窗 420 宽、左右内边距 24 → 滑轨 372
    SlideToConfirm()
        .frame(width: 372)
        .padding(24)
}

/// 预览用：宿主自己的 sheet + 标题跟着阶段切换，成功后关掉弹层
private struct STCSheetDemo: View {
    @State private var show = true
    @State private var paid = false
    @State private var phase: SlideToConfirm.Phase = .idle

    var body: some View {
        Button("打开支付弹层") { show = true }
            .sheet(isPresented: $show) {
                VStack(spacing: 20) {
                    Text(phase == .success ? "支付成功" : "确认支付")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text("¥268.00").font(.system(size: 44, weight: .heavy))
                    SlideToConfirm(isConfirmed: $paid, resetAfter: nil, onConfirm: {
                        try? await Task.sleep(for: .seconds(1))
                        return true
                    }, onPhaseChange: { phase = $0 })
                }
                .padding(20)
                .presentationDetents([.height(260)])
                .onChange(of: paid) { _, ok in
                    guard ok else { return }
                    Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        show = false
                        paid = false
                    }
                }
            }
    }
}
