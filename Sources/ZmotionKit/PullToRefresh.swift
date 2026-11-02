// 下拉刷新（Pull to refresh）：在内容顶部继续往下拉，越拉越沉的橡皮筋阻尼；指示器跟着画出进度，
// 过了阈值松手就停在 64pt 处转圈，刷新结束后打勾，新内容从顶部展开、列表弹回原位。刷新中也能照常滚动。
//
// 原生端只保留可复用的「下拉刷新容器」：网页演示里的假状态栏、「动态」大标题行（副标题、刷新按钮、分隔线）都不画，
// 由宿主的导航栏提供；标题栏刷新按钮的能力换成 refreshTrigger（宿主自己的按钮把它加一即可，效果同网页：先回顶再刷新）。
// 网页 iPad / 桌面的「左列表 + 右详情」两栏是演示内容，不属于组件，只在 iPad 的 #Preview 里用组件拼了一份。
// 内容由宿主传入（content），刷新走 onRefresh（async，返回即结束）或宿主挂在外面的 .refreshable；都不传时显示示例动态。
//
// 动效说明：和网站版一样，列表位置 y 由组件自己驱动（不是系统 ScrollView），这样阻尼系数、阈值、刷新中停住的高度都和网页一致——
// 拖动时 iOS 式橡皮筋 (1 - 1 / (x·阻尼 / dim + 1))·dim（dim = max(视口高, 520)），上下两端都有；
// 松手后越界的用弹簧 380 / 38 回到边界，界内的按 motion 的 inertia（power 0.8、timeConstant 325ms，越界换成 400 / 40 弹簧）惯性滑动；
// 刷新中「顶」变成 64，回顶弹簧 380 / 38（从很深处回来用 170 / 26），完成后延迟 0.32s 用 300 / 34 弹回 0。
// 这些都逐帧求解析解（和 motion 的 spring / inertia 同一套公式），随时能被手指接住、带着离手速度继续。
// 注意：内容整块排版（不是 Lazy），适合信息流这类几十到几百条的列表。
import SwiftUI
import UIKit

public struct PullToRefresh: View {
    /// 指示器：下拉时显示的进度样式
    public enum Indicator: String, CaseIterable, Sendable {
        /// 圆弧
        case arc
        /// 菊花
        case ios
        /// 箭头
        case arrow
    }

    /// 触发阈值（pt）：列表被拉下这么多（阻尼后的距离）松手才会刷新
    let threshold: Double
    /// 阻尼系数：橡皮筋的松紧，越小越拉不动（iOS 系统值约 0.55）
    let resistance: Double
    /// 指示器样式
    let indicator: Indicator
    /// 指示器和新内容高亮的颜色
    let color: Color
    /// 触感反馈（网站版的音效在原生端换成触感：过阈值轻触一下、刷新完成再来一下）
    let haptics: Bool
    /// 每次变化就像点了网页标题栏上的刷新按钮：先回到顶部，再停住转圈刷新
    let refreshTrigger: Int
    /// 刷新回调：返回即刷新结束（打勾、弹回）。不传时用外面的 .refreshable；都没有就模拟 1.2 秒
    let onRefresh: (@MainActor () async -> Void)?
    private let content: AnyView?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.refresh) private var refreshAction
    @State private var model = PullModel()
    @State private var sample = SampleFeedModel()
    @GestureState private var touching = false
    @GestureState private var dragging = false

    /// 示例内容：网页演示里的那组动态，刷新时（模拟 1.2 秒）顶部插入一条新动态
    public init(
        threshold: Double = 80,
        resistance: Double = 0.55,
        indicator: Indicator = .arc,
        color: Color = Color(hex: "#0A84FF"),
        haptics: Bool = true,
        refreshTrigger: Int = 0
    ) {
        self.threshold = threshold
        self.resistance = resistance
        self.indicator = indicator
        self.color = color
        self.haptics = haptics
        self.refreshTrigger = refreshTrigger
        self.onRefresh = nil
        self.content = nil
    }

    /// 宿主内容：content 是要下拉刷新的整块内容（组件负责滚动，不要再包 ScrollView），onRefresh 结束时收起
    public init<Content: View>(
        threshold: Double = 80,
        resistance: Double = 0.55,
        indicator: Indicator = .arc,
        color: Color = Color(hex: "#0A84FF"),
        haptics: Bool = true,
        refreshTrigger: Int = 0,
        onRefresh: (@MainActor () async -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.threshold = threshold
        self.resistance = resistance
        self.indicator = indicator
        self.color = color
        self.haptics = haptics
        self.refreshTrigger = refreshTrigger
        self.onRefresh = onRefresh
        self.content = AnyView(content())
    }

    public var body: some View {
        let pal = Palette(dark: colorScheme == .dark)
        let t = max(1, threshold)
        let m = model
        let _ = m.configure(threshold: t, resistance: min(1, max(0.05, resistance)), haptics: haptics, handler: refreshHandler)
        GeometryReader { geo in
            ZStack(alignment: .top) {
                // 指示器垫在内容下面，只在内容被拉开的那一截里露出来（网页是列表自带底色盖住它）
                IndicatorLayer(model: m, threshold: t, kind: indicator, color: color, pal: pal, doneText: content == nil ? "已更新 1 条" : "已更新")
                ContentLayer(model: m, content: content ?? AnyView(SampleFeed(model: sample, color: color, pal: pal)))
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            .clipped()
            .contentShape(Rectangle())
            // 整个容器只挂一个拖动手势；挪动不到 6pt 算点按，交给内容里的按钮
            .highPriorityGesture(dragGesture)
            // 按下就停住正在惯性滑动 / 回弹的列表（和网页 pointerdown 一样），松手再落位
            .simultaneousGesture(touchGesture)
            .onChange(of: geo.size.height, initial: true) { _, h in m.viewportChanged(Double(h)) }
        }
        .onChange(of: touching) { _, now in now ? m.touchDown() : m.touchUp() }
        // 手势被系统取消（没有 onEnded）时也要松手，否则列表会停在半空
        .onChange(of: dragging) { _, now in if !now { Task { @MainActor in m.dragCancelled() } } }
        .onChange(of: refreshTrigger) { m.refresh() }
        .accessibilityElement(children: .contain)
        .accessibilityScrollAction { edge in m.scrollPage(edge) }
        .accessibilityAction(named: "刷新") { m.refresh() }
    }

    private var dragGesture: some Gesture {
        let m = model
        return DragGesture(minimumDistance: tapSlop, coordinateSpace: .local)
            .updating($dragging) { _, state, _ in state = true }
            .onChanged { v in m.dragChanged(Double(v.translation.height)) }
            .onEnded { v in m.dragEnded(velocity: Double(v.velocity.height)) }
    }

    private var touchGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($touching) { _, state, _ in state = true }
    }

    /// 刷新要做的事：宿主的 onRefresh → 外面的 .refreshable → 模拟 1.2 秒；示例内容在结束的同一帧插入新动态
    private var refreshHandler: @MainActor () async -> Void {
        let onRefresh = onRefresh
        let action = refreshAction
        let sample: SampleFeedModel? = content == nil ? self.sample : nil
        return {
            if let onRefresh {
                await onRefresh()
            } else if let action {
                await action()
            } else {
                try? await Task.sleep(for: .milliseconds(1200))
            }
            sample?.insertNext()
        }
    }
}

// MARK: - 常量

/// 刷新时列表停在这个高度，给指示器留位置
private let hold = 64.0
/// 按下后挪动不超过这么多算点按
private let tapSlop: CGFloat = 6
/// 回弹：接近临界阻尼，像 iOS 列表一样干脆落位，不来回晃
private let settleSpec = SpringSpec(stiffness: 380, damping: 38, restDelta: 0.2)
/// 点刷新时已经滚得很深（y < -200）：慢一点的回顶弹簧
private let farSpec = SpringSpec(stiffness: 170, damping: 26)
/// 刷新完成后弹回 0（延迟 0.32s，让新内容先展开）
private let backSpec = SpringSpec(stiffness: 300, damping: 34, restDelta: 0.2)
/// 惯性滑出边界时的回弹
private let bounceSpec = SpringSpec(stiffness: 400, damping: 40, restDelta: 0.5)
/// 指示器图标的小回弹（armed 放大、箭头翻转、打勾弹出）
private let popAnimation = Animation.motionSpring(stiffness: 520, damping: 22)
/// 标签、详情淡入淡出用的曲线 cubic-bezier(0.33, 0.55, 0.2, 1)
private func swapCurve(_ duration: Double) -> Animation { .timingCurve(0.33, 0.55, 0.2, 1, duration: duration) }

private enum PullPhase { case idle, armed, refreshing, done }

/// 颜色（来自 style.css，浅色 / 深色各一套；页面底色 --bg 不铺，跟随宿主）
private struct Palette {
    let dark: Bool
    var card: Color { dark ? Color(hex: "#1C1C1E") : .white }
    var fg: Color { dark ? Color(hex: "#F5F5F7") : Color(hex: "#111111") }
    var muted: Color { Color(hex: "#8A8A8E") }
    var line: Color { dark ? Color.white.opacity(0.06) : Color.black.opacity(0.06) }
    var track: Color { dark ? Color.white.opacity(0.12) : Color.black.opacity(0.08) }
}

/// 把 v 在 [a, b] 里换算成 0…1（两端截断），等同 motion 的 useTransform 默认的 clamp
private func ramp(_ v: Double, _ a: Double, _ b: Double) -> Double {
    guard b != a else { return v >= b ? 1 : 0 }
    return min(1, max(0, (v - a) / (b - a)))
}

// MARK: - 弹簧 / 惯性（和 motion 的 spring、inertia 同一套公式）

private struct SpringSpec {
    var stiffness: Double
    var damping: Double
    var mass: Double = 1
    /// nil 时按 motion 的默认：变化量 < 5 用 0.005，否则 0.5
    var restDelta: Double? = nil
}

private struct SpringRun {
    let from: Double
    let to: Double
    let v0: Double
    let spec: SpringSpec
    /// 开始时间（已含 delay）
    let start: CFTimeInterval
    let restDelta: Double
    let restSpeed: Double

    init(from: Double, to: Double, v0: Double, spec: SpringSpec, start: CFTimeInterval) {
        self.from = from
        self.to = to
        self.v0 = v0
        self.spec = spec
        self.start = start
        let granular = abs(to - from) < 5
        restDelta = spec.restDelta ?? (granular ? 0.005 : 0.5)
        restSpeed = granular ? 0.01 : 2
    }

    /// t 时刻的位置、速度（单位 / 秒）和是否停稳；delay 期间停在起点
    func state(at now: CFTimeInterval) -> (x: Double, v: Double, done: Bool) {
        let t = now - start
        guard t > 0 else { return (from, 0, false) }
        let k = spec.stiffness, c = spec.damping, m = spec.mass
        let w0 = sqrt(k / m)
        let zeta = c / (2 * sqrt(k * m))
        // e：离终点还差多少；e(0) = to - from，e'(0) = -v0
        let d = to - from
        let e: Double, de: Double
        if abs(zeta - 1) < 1e-6 {
            let C = w0 * d - v0
            let ex = exp(-w0 * t)
            e = ex * (d + C * t)
            de = ex * (C - w0 * (d + C * t))
        } else if zeta < 1 {
            let a = zeta * w0
            let wd = w0 * sqrt(1 - zeta * zeta)
            let B = (a * d - v0) / wd
            let ex = exp(-a * t), cs = cos(wd * t), sn = sin(wd * t)
            e = ex * (d * cs + B * sn)
            de = ex * (-a * (d * cs + B * sn) + wd * (B * cs - d * sn))
        } else {
            let wd = w0 * sqrt(zeta * zeta - 1)
            let slow = zeta * w0 - wd, fast = zeta * w0 + wd
            let C1 = (fast * d - v0) / (fast - slow)
            let C2 = d - C1
            e = C1 * exp(-slow * t) + C2 * exp(-fast * t)
            de = -slow * C1 * exp(-slow * t) - fast * C2 * exp(-fast * t)
        }
        let x = to - e, v = -de
        let done = abs(to - x) <= restDelta && abs(v) <= restSpeed
        return (done ? to : x, done ? 0 : v, done)
    }
}

/// motion 的 inertia：amplitude = power·v，x(t) = target - amplitude·e^(-t/τ)；越界后换成弹簧拉回边界
private struct InertiaRun {
    let amplitude: Double
    let target: Double
    let start: CFTimeInterval
    let lo: Double
    let hi: Double
    var bounce: SpringRun?

    init(origin: Double, velocity: Double, lo: Double, hi: Double, start: CFTimeInterval) {
        amplitude = 0.8 * velocity
        target = origin + amplitude
        self.start = start
        self.lo = lo
        self.hi = hi
    }

    private func friction(_ now: CFTimeInterval) -> (x: Double, v: Double, done: Bool) {
        let t = (now - start) * 1000
        let decay = exp(-t / 325)
        let delta = -amplitude * decay
        let done = abs(delta) <= 0.5
        return (done ? target : target + delta, amplitude / 325 * decay * 1000, done)
    }

    func velocity(at now: CFTimeInterval) -> Double {
        if let b = bounce { return b.state(at: now).v }
        return friction(now).v
    }

    mutating func step(_ now: CFTimeInterval) -> (x: Double, done: Bool) {
        if let b = bounce {
            let s = b.state(at: now)
            return (s.x, s.done)
        }
        let f = friction(now)
        if f.x < lo || f.x > hi {
            let edge = abs(lo - f.x) < abs(hi - f.x) ? lo : hi
            bounce = SpringRun(from: f.x, to: edge, v0: f.v, spec: bounceSpec, start: now)
            return (f.x, false)
        }
        return (f.x, f.done)
    }
}

private enum Motion {
    case spring(SpringRun)
    case inertia(InertiaRun)

    func velocity(at now: CFTimeInterval) -> Double {
        switch self {
        case let .spring(s): return s.state(at: now).v
        case let .inertia(i): return i.velocity(at: now)
        }
    }

    mutating func step(_ now: CFTimeInterval) -> (x: Double, done: Bool) {
        switch self {
        case let .spring(s):
            let r = s.state(at: now)
            return (r.x, r.done)
        case var .inertia(i):
            let r = i.step(now)
            self = .inertia(i)
            return r
        }
    }
}

/// 逐帧回调（CADisplayLink）；回调返回 false 就停
@MainActor
private final class FrameLink: NSObject {
    private var link: CADisplayLink?
    var onFrame: ((CFTimeInterval) -> Bool)?

    func start() {
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ l: CADisplayLink) {
        if onFrame?(l.targetTimestamp) != true { stop() }
    }
}

// MARK: - 状态和手势逻辑

@MainActor
@Observable
private final class PullModel {
    /// 列表的位移：> 0 是被拉下来，< 0 是往上滚进内容
    var y: Double = 0
    var phase: PullPhase = .idle

    // 由视图每次渲染时写入
    @ObservationIgnored var threshold = 80.0
    @ObservationIgnored var resistance = 0.55
    @ObservationIgnored var haptics = true
    @ObservationIgnored var handler: (@MainActor () async -> Void)?
    @ObservationIgnored private var viewportH = 0.0
    @ObservationIgnored private var contentH = 0.0

    private struct Drag {
        /// 按下时手指对应的「原始」位置（去掉橡皮筋之后）
        var startRaw: Double
        /// 手势认出时的位移（扣掉 6pt 的点按容差，列表不跳）
        var t0: Double
        var last: Double
        var max: Double
        var dim: Double
    }

    @ObservationIgnored private var drag: Drag?
    @ObservationIgnored private var anim: Motion?
    @ObservationIgnored private let link = FrameLink()
    /// 这次按下停住了一段动画（松手要接着落位）
    @ObservationIgnored private var caught = false
    /// 这次按下变成了拖动（松手由拖动处理）
    @ObservationIgnored private var dragged = false
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var idleTimer: Task<Void, Never>?

    init() {
        link.onFrame = { [weak self] now in self?.frame(now) ?? false }
    }

    func configure(threshold: Double, resistance: Double, haptics: Bool, handler: @escaping @MainActor () async -> Void) {
        self.threshold = threshold
        self.resistance = resistance
        self.haptics = haptics
        self.handler = handler
    }

    private var maxScroll: Double { max(0, contentH - viewportH) }
    private var dim: Double { max(viewportH, 520) }
    /// 刷新中列表的「顶」是 hold，平时是 0
    private var top: Double { phase == .refreshing ? hold : 0 }

    // iOS 式橡皮筋：越拉越沉，永远拉不到 dim
    private func rubber(_ over: Double, _ dim: Double) -> Double { (1 - 1 / (over * resistance / dim + 1)) * dim }
    private func unrubber(_ d: Double, _ dim: Double) -> Double { dim / resistance * (1 / (1 - min(d, dim - 1) / dim) - 1) }
    /// 橡皮筋的斜率：把手指速度换算成列表速度
    private func slope(_ over: Double, _ dim: Double) -> Double {
        let q = over * resistance / dim + 1
        return resistance / (q * q)
    }

    // MARK: 逐帧动画

    private var velocity: Double { anim?.velocity(at: CACurrentMediaTime()) ?? 0 }

    private func stopAnim() { anim = nil }

    private func run(_ m: Motion) {
        anim = m
        link.start()
    }

    private func spring(to target: Double, _ spec: SpringSpec, velocity v0: Double, delay: Double = 0) {
        run(.spring(SpringRun(from: y, to: target, v0: v0, spec: spec, start: CACurrentMediaTime() + delay)))
    }

    private func frame(_ now: CFTimeInterval) -> Bool {
        guard var a = anim else { return false }
        let r = a.step(now)
        y = r.x
        if r.done {
            anim = nil
            return false
        }
        anim = a
        return true
    }

    // MARK: 布局变化

    func viewportChanged(_ h: Double) {
        viewportH = h
        clampToBottom()
    }

    func contentChanged(_ h: Double) {
        contentH = h
        clampToBottom()
    }

    /// 视口变高 / 内容变矮：已经滚过新的底部就弹回底部，不留空白
    private func clampToBottom() {
        guard drag == nil else { return }
        let mx = maxScroll
        if y < -mx - 1 {
            let v = velocity
            spring(to: -mx, settleSpec, velocity: v)
        }
    }

    // MARK: 触摸

    func touchDown() {
        guard drag == nil else { return }
        dragged = false
        caught = anim != nil
        stopAnim()
    }

    func touchUp() {
        defer { caught = false }
        guard drag == nil, !dragged, caught else { return }
        settle(velocity: 0)
    }

    func dragChanged(_ translation: Double) {
        if drag == nil {
            stopAnim()
            dragged = true
            let cur = y, t = top, mx = maxScroll, dm = dim
            var raw = cur
            if cur > t { raw = t + unrubber(cur - t, dm) } else if cur < -mx { raw = -mx - unrubber(-mx - cur, dm) }
            drag = Drag(startRaw: raw, t0: translation, last: translation, max: mx, dim: dm)
        }
        guard var d = drag else { return }
        d.last = translation
        drag = d
        let raw = d.startRaw + (translation - d.t0)
        let t = top
        var v = raw
        if raw > t { v = t + rubber(raw - t, d.dim) } else if raw < -d.max { v = -d.max - rubber(-d.max - raw, d.dim) }
        y = v
        guard phase != .refreshing else { return }
        let armed = v >= threshold
        if armed && phase != .armed {
            phase = .armed
            Haptics.tap(haptics)
        } else if !armed && phase == .armed {
            phase = .idle
        }
    }

    func dragEnded(velocity fingerV: Double) {
        guard let d = drag else { return }
        drag = nil
        // 橡皮筋区域里列表比手指慢，按斜率换算离手速度
        let raw = d.startRaw + (d.last - d.t0)
        let t = top
        var v = fingerV
        if raw > t { v *= slope(raw - t, d.dim) } else if raw < -d.max { v *= slope(-d.max - raw, d.dim) }
        if phase == .armed {
            refresh(velocity: v)
            return
        }
        settle(velocity: v)
    }

    func dragCancelled() {
        dragEnded(velocity: 0)
    }

    private func settle(velocity v: Double) {
        let cur = y, t = top, mx = maxScroll
        if cur > t {
            spring(to: t, settleSpec, velocity: v)
        } else if cur < -mx {
            spring(to: -mx, settleSpec, velocity: v)
        } else {
            run(.inertia(InertiaRun(origin: cur, velocity: v, lo: -mx, hi: t, start: CACurrentMediaTime())))
        }
    }

    // MARK: 刷新

    func refresh(velocity: Double? = nil) {
        guard phase != .refreshing else { return }
        phase = .refreshing
        announce("正在刷新")
        if drag == nil {
            let v0 = velocity ?? self.velocity
            // 就算已经滚进内容里，也先回到顶部再刷新
            spring(to: hold, y < -200 ? farSpec : settleSpec, velocity: v0)
        }
        idleTimer?.cancel()
        work?.cancel()
        let h = handler
        work = Task { [weak self] in
            if let h { await h() } else { try? await Task.sleep(for: .milliseconds(1200)) }
            guard !Task.isCancelled else { return }
            self?.finish()
        }
    }

    private func finish() {
        phase = .done
        Haptics.pop(haptics)
        announce("刷新完成")
        if var d = drag {
            // 手指还按着：「顶」从 hold 变回 0，换算一下起点，列表不跳
            let cur = y
            let raw = cur > 0 ? unrubber(cur, d.dim) : cur
            d.startRaw = raw - (d.last - d.t0)
            drag = d
        } else if y > 0 {
            let v = velocity
            spring(to: 0, backSpec, velocity: v, delay: 0.32)
        }
        idleTimer?.cancel()
        idleTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1300))
            guard !Task.isCancelled, let self, self.phase == .done else { return }
            self.phase = .idle
        }
    }

    private func announce(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }

    /// 旁白三指滑动：一次翻大半屏
    func scrollPage(_ edge: Edge) {
        guard drag == nil else { return }
        let mx = maxScroll, t = top
        let page = max(100, viewportH * 0.8)
        let target: Double
        switch edge {
        case .bottom: target = max(-mx, min(t, y) - page)
        case .top: target = min(t, y + page)
        default: return
        }
        spring(to: target, settleSpec, velocity: 0)
    }
}

// MARK: - 内容层、指示器层

private struct ContentLayer: View {
    let model: PullModel
    let content: AnyView

    var body: some View {
        content
            // 内容按自己的理想高度排版，超出视口的部分靠 y 移进来
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { model.contentChanged(Double($0)) }
            .offset(y: model.y)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private struct IndicatorLayer: View {
    let model: PullModel
    let threshold: Double
    let kind: PullToRefresh.Indicator
    let color: Color
    let pal: Palette
    let doneText: String

    var body: some View {
        let v = model.y
        let phase = model.phase
        let p = min(max(v / threshold, 0), 1)
        HStack(spacing: 10) {
            IndicatorIcon(kind: kind, phase: phase, progress: p, color: color, track: pal.track)
                .frame(width: 28, height: 28)
                .scaleEffect(0.6 + 0.4 * p)
            PhaseLabel(text: label(phase), color: pal.muted)
        }
        .frame(maxWidth: .infinity)
        .frame(height: hold)
        // 指示器始终在拉开的那一截正中间
        .offset(y: max(v, 0) / 2 - hold / 2)
        .opacity(ramp(v, 6, 36))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .mask(alignment: .top) { Rectangle().frame(height: max(0, v)) }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func label(_ phase: PullPhase) -> String {
        switch phase {
        case .idle: "下拉刷新"
        case .armed: "松手刷新"
        case .refreshing: "正在刷新"
        case .done: doneText
        }
    }
}

/// 状态文字：旧的往上淡出、新的从下面淡入（0.2s）
private struct PhaseLabel: View {
    let text: String
    let color: Color

    var body: some View {
        ZStack(alignment: .leading) {
            Text(text)
                .id(text)
                .transition(.asymmetric(
                    insertion: .offset(y: 8).combined(with: .opacity),
                    removal: .offset(y: -8).combined(with: .opacity)
                ))
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(color)
        .lineLimit(1)
        .frame(minWidth: 78, alignment: .leading)
        .animation(swapCurve(0.2), value: text)
    }
}

private struct IndicatorIcon: View {
    let kind: PullToRefresh.Indicator
    let phase: PullPhase
    let progress: Double
    let color: Color
    let track: Color

    var body: some View {
        if phase == .done {
            DoneCheck(color: color)
        } else if kind == .ios {
            IosSpinner(spinning: phase == .refreshing, progress: progress, color: color)
        } else if phase == .refreshing {
            SpinningArc(color: color, track: track)
        } else if kind == .arrow {
            ArrowIcon(armed: phase == .armed, progress: progress, color: color)
        } else {
            ProgressArc(armed: phase == .armed, progress: progress, color: color, track: track)
        }
    }
}

/// 圆环（r = 10、线宽 3）：灰色轨道 + 从 start 角度开始顺时针画 fraction 圈的彩色弧
private struct ArcRing: View {
    let fraction: Double
    let start: Double
    let color: Color
    let track: Color

    var body: some View {
        ZStack {
            Circle().stroke(track, lineWidth: 3)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(start))
        }
        .frame(width: 20, height: 20)
        .frame(width: 28, height: 28)
    }
}

/// 圆弧：长度 0.03 → 0.8 圈，同时从 -180° 转回 0°；过阈值放大到 1.12
private struct ProgressArc: View {
    let armed: Bool
    let progress: Double
    let color: Color
    let track: Color

    var body: some View {
        ArcRing(fraction: 0.03 + 0.77 * progress, start: -90, color: color, track: track)
            .rotationEffect(.degrees(-180 + 180 * progress))
            .animation(popAnimation) { $0.scaleEffect(armed ? 1.12 : 1) }
    }
}

/// 刷新中：0.7 圈的弧匀速转（0.7s 一圈），出现时从 1.12 弹回 1
private struct SpinningArc: View {
    let color: Color
    let track: Color
    @State private var begin = Date()
    @State private var scale = 1.12

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSince(begin)
            ArcRing(fraction: 0.7, start: 0, color: color, track: track)
                .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 0.7) / 0.7 * 360))
        }
        .scaleEffect(scale)
        .onAppear { withAnimation(popAnimation) { scale = 1 } }
    }
}

/// 菊花：8 根短线随进度依次亮起；刷新中按 8 格跳着转（0.8s 一圈）
private struct IosSpinner: View {
    let spinning: Bool
    let progress: Double
    let color: Color
    @State private var begin = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: !spinning)) { tl in
            let step = spinning ? floor(max(0, tl.date.timeIntervalSince(begin)) / 0.1).truncatingRemainder(dividingBy: 8) : 0
            ZStack {
                ForEach(0..<8, id: \.self) { i in
                    Capsule()
                        .fill(color)
                        .frame(width: 2.6, height: 7.6)
                        .offset(y: -8)
                        .rotationEffect(.degrees(Double(i) * 45))
                        .opacity(spinning ? 1 - Double(i) * 0.11 : ramp(progress, Double(i) / 8, Double(i + 1) / 8))
                }
            }
            .frame(width: 28, height: 28)
            .rotationEffect(.degrees(step * 45))
        }
        .onChange(of: spinning) { _, now in if now { begin = Date() } }
    }
}

/// 箭头：随进度从 -6 落到 0，过阈值翻转 180°
private struct ArrowIcon: View {
    let armed: Bool
    let progress: Double
    let color: Color

    var body: some View {
        ArrowShape()
            .stroke(color, style: StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
            .frame(width: 28, height: 28)
            .animation(popAnimation) { $0.rotationEffect(.degrees(armed ? 180 : 0)) }
            .offset(y: -6 + 6 * progress)
    }
}

/// 完成：实心圆从 0.4 弹到 1，白色对勾 0.28s 画出来
private struct DoneCheck: View {
    let color: Color
    @State private var scale = 0.4
    @State private var drawn = 0.0

    var body: some View {
        ZStack {
            Circle().fill(color).frame(width: 22, height: 22)
            CheckShape()
                .trim(from: 0, to: drawn)
                .stroke(.white, style: StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 28, height: 28)
        .scaleEffect(scale)
        .onAppear {
            withAnimation(popAnimation) { scale = 1 }
            withAnimation(swapCurve(0.28).delay(0.06)) { drawn = 1 }
        }
    }
}

/// 网站版 28 × 28 的 SVG：M14 6v15 M8 15l6 6 6-6
private struct ArrowShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 14, y: 6))
        p.addLine(to: CGPoint(x: 14, y: 21))
        p.move(to: CGPoint(x: 8, y: 15))
        p.addLine(to: CGPoint(x: 14, y: 21))
        p.addLine(to: CGPoint(x: 20, y: 15))
        let k = min(rect.width, rect.height) / 28
        return p.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: k, y: k))
    }
}

/// 网站版 28 × 28 的 SVG：M9 14.5l3.2 3.2L19 11
private struct CheckShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 9, y: 14.5))
        p.addLine(to: CGPoint(x: 12.2, y: 17.7))
        p.addLine(to: CGPoint(x: 19, y: 11))
        let k = min(rect.width, rect.height) / 28
        return p.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: k, y: k))
    }
}

// MARK: - 示例内容（网页演示的动态列表；宿主传了 content 时不用）

private enum Media: Sendable { case sunset, snow, film, vinyl, tiles }

private struct Post: Identifiable, Sendable {
    let id: Int
    let name: String
    let avatar: String
    let hue: (String, String)
    let time: String
    let text: String
    var media: Media? = nil
}

private let seedPosts: [Post] = [
    Post(id: 1, name: "林小满", avatar: "🌿", hue: ("#BBF7D0", "#34D399"), time: "3 分钟前", text: "今天的晚霞像被谁打翻了一整瓶橘子汽水。", media: .sunset),
    Post(id: 2, name: "阿哲", avatar: "🎧", hue: ("#C7D2FE", "#818CF8"), time: "12 分钟前", text: "新歌单整理好了，适合写代码的深夜，一共 42 首。"),
    Post(id: 3, name: "Momo", avatar: "🐱", hue: ("#FDE68A", "#F59E0B"), time: "半小时前", text: "猫主子第一次见到雪，整只猫当场僵住。", media: .snow),
    Post(id: 4, name: "周末去哪儿", avatar: "⛰️", hue: ("#A5F3FC", "#06B6D4"), time: "1 小时前", text: "推荐三条适合新手的城郊徒步路线，全程不超过 8 公里。"),
    Post(id: 5, name: "设计日报", avatar: "✏️", hue: ("#FBCFE8", "#EC4899"), time: "2 小时前", text: "弹簧动画的刚度和阻尼到底怎么调？一张图讲清楚。"),
    Post(id: 6, name: "陈一一", avatar: "☕️", hue: ("#FED7AA", "#EA580C"), time: "3 小时前", text: "换了新的手冲壶，这杯耶加雪菲有明显的柑橘味。"),
    Post(id: 7, name: "小森", avatar: "📷", hue: ("#DDD6FE", "#8B5CF6"), time: "昨天", text: "胶片冲出来了，最喜欢这张逆光。", media: .film),
]

private let incomingPosts: [Post] = [
    Post(id: 0, name: "今日天气", avatar: "🌤️", hue: ("#BAE6FD", "#38BDF8"), time: "", text: "午后转晴，最高 24°，适合出门走走。"),
    Post(id: 0, name: "阿哲", avatar: "🎧", hue: ("#C7D2FE", "#818CF8"), time: "", text: "刚刚收藏了你的歌单，品味可以。", media: .vinyl),
    Post(id: 0, name: "林小满", avatar: "🌿", hue: ("#BBF7D0", "#34D399"), time: "", text: "楼下的桂花开了，整条街都是甜的。"),
    Post(id: 0, name: "设计日报", avatar: "✏️", hue: ("#FBCFE8", "#EC4899"), time: "", text: "本周最佳微交互合集已上线，第 3 个绝了。", media: .tiles),
]

@MainActor
@Observable
private final class SampleFeedModel {
    var posts = seedPosts
    var freshId = 0
    @ObservationIgnored private var nextId = 100

    func insertNext() {
        let src = incomingPosts[nextId % incomingPosts.count]
        let id = nextId
        nextId += 1
        posts.insert(Post(id: id, name: src.name, avatar: src.avatar, hue: src.hue, time: "刚刚", text: src.text, media: src.media), at: 0)
        freshId = id
    }
}

private struct SampleFeed: View {
    let model: SampleFeedModel
    let color: Color
    let pal: Palette

    var body: some View {
        VStack(spacing: 0) {
            ForEach(model.posts) { post in
                PostRow(post: post, fresh: post.id == model.freshId, color: color, pal: pal)
            }
            Text("没有更多了")
                .font(.system(size: 12))
                .foregroundStyle(pal.muted)
                .frame(maxWidth: .infinity)
                .padding(.top, 14)
                .padding(.bottom, 8)
        }
        .padding(.top, 4)
        .padding(.horizontal, 12)
        .padding(.bottom, 24)
        .frame(maxWidth: 430)
        .frame(maxWidth: .infinity)
    }
}

/// 高度按进度展开（progress 是动画量，内容高度随量随用）；展开完（settled）就不再限高。
/// 始终挂着同一个修饰符、只换参数，卡片的视图身份不变（高亮动画不会被打断）
private struct RevealHeight: ViewModifier, Animatable {
    var progress: Double
    let height: CGFloat
    let settled: Bool
    nonisolated var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        content.frame(height: settled ? nil : max(0, height * progress), alignment: .top)
    }
}

/// 一行动态：新插入的先撑开高度（320 / 34）、0.12s 后淡入；卡片从 0.96、-8 弹到位（380 / 26，延迟 0.08s）
private struct PostRow: View {
    let post: Post
    let fresh: Bool
    let color: Color
    let pal: Palette
    var selected = false

    @State private var open: Double
    @State private var settled: Bool
    @State private var shown: Double
    @State private var popped: Bool
    @State private var height: CGFloat = 0

    init(post: Post, fresh: Bool, color: Color, pal: Palette, selected: Bool = false) {
        self.post = post
        self.fresh = fresh
        self.color = color
        self.pal = pal
        self.selected = selected
        let isNew = post.id >= 100
        _open = State(initialValue: isNew ? 0 : 1)
        _settled = State(initialValue: !isNew)
        _shown = State(initialValue: isNew ? 0 : 1)
        _popped = State(initialValue: !isNew)
    }

    var body: some View {
        let card = PostCard(post: post, fresh: fresh, color: color, pal: pal, selected: selected)
            .scaleEffect(popped ? 1 : 0.96)
            .offset(y: popped ? 0 : -8)
            .padding(.bottom, 8)
        card
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .modifier(RevealHeight(progress: open, height: height, settled: settled))
            .clipped()
            .opacity(shown)
        .onAppear {
            guard !settled else { return }
            withAnimation(.motionSpring(stiffness: 320, damping: 34)) { open = 1 } completion: { settled = true }
            withAnimation(.easeInOut(duration: 0.3).delay(0.12)) { shown = 1 }
            withAnimation(.motionSpring(stiffness: 380, damping: 26).delay(0.08)) { popped = true }
        }
    }
}

private struct PostCard: View {
    let post: Post
    let fresh: Bool
    let color: Color
    let pal: Palette
    var selected = false
    /// 新动态的高亮：前 35% 保持，之后 ease-out 褪掉（共 2.4s）
    @State private var glow: Double = 0

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(post: post, size: 40)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(post.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(post.time).font(.system(size: 12)).foregroundStyle(pal.muted).lineLimit(1)
                }
                Text(post.text)
                    .font(.system(size: 14.5))
                    .lineSpacing(4.4)
                    .padding(.top, 6)
                    .fixedSize(horizontal: false, vertical: true)
                if let media = post.media {
                    MediaArt(kind: media)
                        .frame(height: 132)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.top, 10)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .foregroundStyle(pal.fg)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 18)
                    .fill(pal.card)
                    .shadow(color: pal.line, radius: 0, x: 0, y: 1)
                RoundedRectangle(cornerRadius: 18).fill(color.opacity(0.09 * glow))
                RoundedRectangle(cornerRadius: 18).strokeBorder(color.opacity(0.55 * glow), lineWidth: 1.5)
                // iPad 预览里的选中态：主题色淡底 + 细描边
                RoundedRectangle(cornerRadius: 18).fill(color.opacity(selected ? 0.07 : 0))
                RoundedRectangle(cornerRadius: 18).strokeBorder(color.opacity(selected ? 0.38 : 0), lineWidth: 1.5)
            }
            .animation(swapCurve(0.2), value: selected)
        }
        .onAppear {
            guard fresh else { return }
            glow = 1
            withAnimation(.timingCurve(0, 0, 0.58, 1, duration: 1.56).delay(0.84)) { glow = 0 }
        }
        .onChange(of: fresh) { _, now in if !now { glow = 0 } }
    }
}

private struct Avatar: View {
    let post: Post
    let size: CGFloat

    var body: some View {
        Text(post.avatar)
            .font(.system(size: size / 2))
            .frame(width: size, height: size)
            .background(Circle().fill(LinearGradient(colors: [Color(hex: post.hue.0), Color(hex: post.hue.1)], startPoint: .topLeading, endPoint: .bottomTrailing)))
            .accessibilityHidden(true)
    }
}

// MARK: - 配图（网页是 CSS 渐变画的：晚霞、雪地、逆光、唱片、拼贴；这里用 Canvas 按同样的层次画）

private func stop(_ hex: String, _ opacity: Double = 1, _ at: Double) -> Gradient.Stop {
    .init(color: Color(hex: hex).opacity(opacity), location: at)
}

/// CSS linear-gradient(角度) 在 size 里的渐变线起止点
private func cssLine(_ deg: Double, _ s: CGSize) -> (CGPoint, CGPoint) {
    let a = deg * .pi / 180
    let dx = sin(a), dy = -cos(a)
    let len = abs(s.width * sin(a)) + abs(s.height * cos(a))
    let c = CGPoint(x: s.width / 2, y: s.height / 2)
    return (CGPoint(x: c.x - dx * len / 2, y: c.y - dy * len / 2), CGPoint(x: c.x + dx * len / 2, y: c.y + dy * len / 2))
}

/// radial-gradient 默认的 farthest-corner 半径
private func farthest(_ c: CGPoint, _ s: CGSize) -> CGFloat {
    [CGPoint.zero, CGPoint(x: s.width, y: 0), CGPoint(x: 0, y: s.height), CGPoint(x: s.width, y: s.height)]
        .map { hypot($0.x - c.x, $0.y - c.y) }
        .max() ?? 0
}

private struct MediaArt: View, Equatable {
    let kind: Media

    var body: some View {
        Canvas { ctx, size in
            let full = Path(CGRect(origin: .zero, size: size))
            let W = size.width, H = size.height
            func linear(_ deg: Double, _ stops: [Gradient.Stop]) {
                let (a, b) = cssLine(deg, size)
                ctx.fill(full, with: .linearGradient(Gradient(stops: stops), startPoint: a, endPoint: b))
            }
            func radial(_ c: CGPoint, _ stops: [Gradient.Stop]) {
                ctx.fill(full, with: .radialGradient(Gradient(stops: stops), center: c, startRadius: 0, endRadius: farthest(c, size)))
            }
            switch kind {
            case .sunset:
                linear(180, [stop("#FB923C", 1, 0), stop("#F472B6", 1, 0.7), stop("#C084FC", 1, 1)])
                radial(CGPoint(x: W * 0.66, y: H * 0.76), [stop("#FFF3C4", 1, 0), stop("#FFF3C4", 1, 0.11), stop("#FFF3C4", 0.5, 0.12), stop("#FFF3C4", 0, 0.3), stop("#FFF3C4", 0, 1)])
                ctx.fill(Path(CGRect(x: 0, y: H * 0.76, width: W, height: H * 0.24)), with: .color(Color(hex: "#5B21B6").opacity(0.55)))
            case .snow:
                linear(170, [stop("#93C5FD", 1, 0), stop("#C7D2FE", 1, 1)])
                dots(ctx, size, tile: CGSize(width: 17, height: 19), offset: CGPoint(x: 7, y: 21), r: 1.2, opacity: 0.6)
                dots(ctx, size, tile: CGSize(width: 23, height: 31), offset: CGPoint(x: 19, y: 13), r: 1.6, opacity: 0.85)
                dots(ctx, size, tile: CGSize(width: 37, height: 29), offset: CGPoint(x: 3, y: 5), r: 2.2, opacity: 1)
                ctx.fill(Path(ellipseIn: CGRect(x: W * 0.85 - W * 0.6, y: H * 1.1 - H * 0.34, width: W * 1.2, height: H * 0.68)), with: .color(Color(hex: "#F1F5FF")))
                ctx.fill(Path(ellipseIn: CGRect(x: W * 0.25 - W * 0.7, y: H * 1.05 - H * 0.4, width: W * 1.4, height: H * 0.8)), with: .color(.white))
            case .film:
                linear(200, [stop("#F59E0B", 1, 0), stop("#DB2777", 1, 0.55), stop("#6D28D9", 1, 1)])
                linear(0, [stop("#1E1B4B", 0.65, 0), stop("#1E1B4B", 0, 0.45), stop("#1E1B4B", 0, 1)])
                radial(CGPoint(x: W * 0.8, y: H * 0.2), [stop("#FFFBE6", 1, 0), stop("#FFFBE6", 1, 0.05), stop("#FDE047", 0.75, 0.12), stop("#FDE047", 0, 0.46), stop("#FDE047", 0, 1)])
            case .vinyl:
                linear(120, [stop("#A78BFA", 1, 0), stop("#22D3EE", 1, 1)])
                let c = CGPoint(x: W * 0.3, y: H * 0.5)
                let R = farthest(c, size)
                var rings = Path()
                for r in stride(from: 3.5, through: R, by: 4) {
                    rings.addEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
                }
                ctx.stroke(rings, with: .color(.white.opacity(0.05)), lineWidth: 1)
                for (f, hex) in [(0.30, "#1F1F23"), (0.09, "#111111"), (0.04, "#F5F3FF")] {
                    let r = R * f
                    ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)), with: .color(Color(hex: hex)))
                }
            case .tiles:
                linear(135, [stop("#F9A8D4", 1, 0), stop("#FDE68A", 1, 1)])
                ctx.fill(Path(CGRect(x: 14, y: 14, width: W * 0.3, height: H * 0.44)), with: .color(.white.opacity(0.6)))
                ctx.fill(Path(CGRect(x: 14 + W * 0.3 + 10, y: 14, width: W * 0.3, height: H * 0.44)), with: .color(.white.opacity(0.4)))
                ctx.fill(Path(CGRect(x: 14, y: 14 + H * 0.44 + 10, width: W * 0.6 + 10, height: H * 0.28)), with: .color(.white.opacity(0.267)))
            }
        }
        .accessibilityHidden(true)
    }

    /// 平铺的雪点：每格中心一个圆（CSS 的 background-size / position）
    private func dots(_ ctx: GraphicsContext, _ size: CGSize, tile: CGSize, offset: CGPoint, r: CGFloat, opacity: Double) {
        var x0 = offset.x.truncatingRemainder(dividingBy: tile.width)
        if x0 > 0 { x0 -= tile.width }
        var y0 = offset.y.truncatingRemainder(dividingBy: tile.height)
        if y0 > 0 { y0 -= tile.height }
        var p = Path()
        var y = y0
        while y < size.height {
            var x = x0
            while x < size.width {
                p.addEllipse(in: CGRect(x: x + tile.width / 2 - r, y: y + tile.height / 2 - r, width: r * 2, height: r * 2))
                x += tile.width
            }
            y += tile.height
        }
        ctx.fill(p, with: .color(.white.opacity(opacity)))
    }
}

// MARK: - 预览

/// 手机：宿主用导航栏提供「动态」标题，组件只管下拉刷新
#Preview("手机 · 示例动态") {
    NavigationStack {
        PullToRefresh()
            .navigationTitle("动态")
    }
}

/// 宿主自己的内容 + async onRefresh；导航栏按钮通过 refreshTrigger 触发刷新（对应网页标题栏的刷新按钮）
private struct CustomContentPreview: View {
    @State private var items = (1...20).map { "第 \($0) 条" }
    @State private var trigger = 0

    var body: some View {
        NavigationStack {
            PullToRefresh(indicator: .ios, color: Color(hex: "#8E8E93"), refreshTrigger: trigger) {
                try? await Task.sleep(for: .seconds(1.5))
                items.insert("新内容 \(items.count + 1)", at: 0)
            } content: {
                LazyVStack(spacing: 0) {
                    ForEach(items, id: \.self) { item in
                        Text(item)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                        Divider()
                    }
                }
            }
            .navigationTitle("系统")
            .toolbar {
                Button("刷新", systemImage: "arrow.clockwise") { trigger += 1 }
            }
        }
    }
}

#Preview("手机 · 自定义内容") {
    CustomContentPreview()
}

#Preview("手机 · 厚重") {
    NavigationStack {
        PullToRefresh(threshold: 120, resistance: 0.35, indicator: .arrow, color: Color(hex: "#FF6B2C"))
            .navigationTitle("动态")
    }
}

/// iPad：网页的「左列表 + 右详情」两栏在原生端由宿主用 NavigationSplitView 拼，下拉刷新只发生在左边列表里，刷新不打扰详情
private struct SplitPreview: View {
    @State private var feed = SampleFeedModel()
    @State private var selected = 1
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let pal = Palette(dark: scheme == .dark)
        let color = Color(hex: "#0A84FF")
        NavigationSplitView {
            PullToRefresh {
                try? await Task.sleep(for: .milliseconds(1200))
                feed.insertNext()
            } content: {
                VStack(spacing: 0) {
                    ForEach(feed.posts) { post in
                        PostRow(post: post, fresh: post.id == feed.freshId, color: color, pal: pal, selected: post.id == selected)
                            .contentShape(Rectangle())
                            .onTapGesture { selected = post.id }
                    }
                }
                .padding(.top, 4)
                .padding(.horizontal, 12)
                .padding(.bottom, 24)
            }
            .navigationTitle("动态")
            .navigationSplitViewColumnWidth(340)
        } detail: {
            let post = feed.posts.first { $0.id == selected } ?? feed.posts[0]
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 14) {
                        Avatar(post: post, size: 52)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(post.name).font(.system(size: 17, weight: .semibold))
                            Text(post.time).font(.system(size: 13)).foregroundStyle(pal.muted)
                        }
                    }
                    Text(post.text)
                        .font(.system(size: 19))
                        .lineSpacing(7)
                        .padding(.top, 20)
                    if let media = post.media {
                        MediaArt(kind: media)
                            .aspectRatio(4 / 3, contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .padding(.top, 20)
                    }
                }
                .padding(EdgeInsets(top: 28, leading: 32, bottom: 40, trailing: 32))
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
                .id(post.id)
                .transition(.asymmetric(insertion: .offset(y: 14).combined(with: .opacity), removal: .opacity))
            }
            .foregroundStyle(pal.fg)
            .animation(.motionSpring(stiffness: 380, damping: 38), value: selected)
        }
    }
}

#Preview("iPad", traits: .fixedLayout(width: 1024, height: 768)) {
    SplitPreview()
}
