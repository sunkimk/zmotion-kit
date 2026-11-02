// 滚轮计数器：加减时每一位数字像里程表一样独立滚动，方向跟随加减，滚得越快越模糊；
// 长按越按越快，到达上下限时数字左右一抖。
// 对应网站 src/cases/rolling-counter（React + motion）。尺寸按容器的 cqmin 换算（和 CSS 的 clamp(…, n cqmin, …) 一致）。
// 所有动画都按时间直接算（TimelineView 逐帧取样）：每一位是一根「数字轴」，motion 的 useSpring 在这里是解析解弹簧，
// 改目标时从当前值、带当前速度接着走；模糊半径取自弹簧的瞬时速度（useVelocity）。
import SwiftUI
import UIKit

public struct RollingCounter: View {
    let step: Double
    let min: Double
    let max: Double
    let stiffness: Double
    let blur: Bool
    let haptics: Bool
    let value: Binding<Double>?
    let onValueChange: ((Double) -> Void)?

    /// - Parameters:
    ///   - step: 每次加减的数值（1–25）
    ///   - min: 允许的最小值，可以是负数（-99–0）
    ///   - max: 允许的最大值，位数会随数值自动增减（9–9999）
    ///   - stiffness: 数字滚动的弹簧刚度，越小滚得越慢、越有惯性（60–700）
    ///   - blur: 滚动越快，数字越模糊
    ///   - haptics: 每走一步的棘轮触感、撞到上下限时的触感
    ///   - value: 外部绑定的当前数值；不传则组件内部自己管理（初始 9）
    ///   - onValueChange: 用户加减后回调新的数值
    public init(
        step: Double = 1,
        min: Double = 0,
        max: Double = 120,
        stiffness: Double = 240,
        blur: Bool = true,
        haptics: Bool = true,
        value: Binding<Double>? = nil,
        onValueChange: ((Double) -> Void)? = nil
    ) {
        self.step = step
        self.min = min
        self.max = max
        self.stiffness = stiffness
        self.blur = blur
        self.haptics = haptics
        self.value = value
        self.onValueChange = onValueChange
        let lo = Int(Swift.min(min, max).rounded()), hi = Int(Swift.max(min, max).rounded())
        _internalValue = State(initialValue: rcClamp(9, lo, hi))
    }

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduce

    @State private var internalValue: Int
    /// 每一位（个位 = 0）的数字轴和出现 / 消失进度
    @State private var cols: [Int: RCColumn] = [:]
    /// 负号的出现进度
    @State private var sign = RCValue(0)
    /// 进度条 scaleX
    @State private var fill = RCValue(0)
    /// 撞到上下限时数字和按钮的左右一抖
    @State private var shake = RCValue(0)
    @State private var shakeMinus = RCValue(0)
    @State private var shakePlus = RCValue(0)
    /// 按钮按下缩放（whileTap）
    @State private var pressMinus = RCValue(1)
    @State private var pressPlus = RCValue(1)
    @State private var holdDir = 0
    @State private var holdGen = 0
    @State private var lastTick = Date.distantPast
    @State private var ready = false
    @State private var activeUntil = Date.distantPast
    @State private var wake = 0

    private static let colSpring = (k: 420.0, c: 34.0)
    private static let fillSpring = (k: 260.0, c: 30.0)

    private var lo: Int { Int(Swift.min(min, max).rounded()) }
    private var hi: Int { Int(Swift.max(min, max).rounded()) }
    private var stepInt: Int { Swift.max(1, Int(step.rounded())) }
    private var current: Int {
        if let value { return rcClamp(Int(value.wrappedValue.rounded()), lo, hi) }
        return internalValue
    }
    private var places: Int { String(Swift.max(abs(lo), abs(hi))).count }
    private var progress: Double { hi == lo ? 1 : Double(current - lo) / Double(hi - lo) }
    private var digitDamping: Double { stiffness.squareRoot() * (reduce ? 2 : 1.45) }

    public var body: some View {
        let _ = wake
        GeometryReader { geo in
            let cq = Swift.min(geo.size.width, geo.size.height) / 100
            let running = Date() < activeUntil
            TimelineView(.animation(paused: !running)) { tl in
                content(cq: cq, width: geo.size.width, now: running ? tl.date : Date())
                    .frame(width: geo.size.width, height: geo.size.height)
            }
        }
        .onAppear {
            guard !ready else { return }
            ready = true
            fill = RCValue(progress)
            sign = RCValue(current < 0 ? 1 : 0)
        }
        .onChange(of: current) { old, new in apply(from: old, to: new) }
        .onChange(of: lo) { _, _ in clampIntoRange() }
        .onChange(of: hi) { _, _ in clampIntoRange() }
    }

    // MARK: - 视图

    private var palette: RCPalette { scheme == .dark ? .dark : .light }

    @ViewBuilder
    private func content(cq: Double, width: Double, now: Date) -> some View {
        let pal = palette
        let btn = rcClampD(13 * cq, 40, 60)
        let fs = rcClampD(15 * cq, 40, 88)
        VStack(spacing: rcClampD(5 * cq, 14, 28)) {
            HStack(spacing: rcClampD(3 * cq, 8, 18)) {
                button(dir: -1, size: btn, now: now, pal: pal)
                valueView(fs: fs, now: now, pal: pal)
                button(dir: 1, size: btn, now: now, pal: pal)
            }
            .padding(rcClampD(2 * cq, 6, 10))
            .background(pill(pal))
            meta(width: Swift.min(width * 0.7, 260), now: now, pal: pal)
        }
    }

    /// 胶囊底：0 1px 2px rgb(0 0 0 / .06), 0 10px 30px rgb(0 0 0 / .07)
    private func pill(_ pal: RCPalette) -> some View {
        ZStack {
            Capsule().fill(pal.pill)
                .shadow(color: .black.opacity(0.07), radius: 15, x: 0, y: 10)
            Capsule().fill(pal.pill)
                .shadow(color: .black.opacity(0.06), radius: 1, x: 0, y: 1)
        }
    }

    @ViewBuilder
    private func button(dir: Int, size: Double, now: Date, pal: RCPalette) -> some View {
        let off = dir < 0 ? current <= lo : current >= hi
        let scale = (dir < 0 ? pressMinus : pressPlus).sample(now).x
        let dx = (dir < 0 ? shakeMinus : shakePlus).sample(now).x
        ZStack {
            Circle().fill(pal.btn)
            RCIcon(plus: dir > 0)
                .stroke(pal.btnFg, style: StrokeStyle(lineWidth: size * 0.42 * 2.6 / 24, lineCap: .round))
                .frame(width: size * 0.42, height: size * 0.42)
        }
        .frame(width: size, height: size)
        .opacity(off ? 0.35 : 1)
        .animation(.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.2), value: off)
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if holdDir != dir { holdDir = dir; pressStart(dir) }
                }
                .onEnded { _ in
                    holdDir = 0
                    release(dir)
                }
        )
        .scaleEffect(scale)
        .offset(x: dx)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(dir < 0 ? "减少 \(stepInt)" : "增加 \(stepInt)")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { _ = bump(dir) }
    }

    @ViewBuilder
    private func valueView(fs: Double, now: Date, pal: RCPalette) -> some View {
        let font = UIFont.monospacedDigitSystemFont(ofSize: fs, weight: .bold)
        let ch = ("0" as NSString).size(withAttributes: [.font: font]).width
        let h = 1.2 * fs
        let a = abs(current)
        let signP = sign.sample(now).x
        HStack(spacing: 0) {
            if signP > 0.001 {
                Text("−")
                    .font(.system(size: fs, weight: .bold))
                    .foregroundStyle(pal.fg)
                    .fixedSize()
                    .frame(width: Swift.max(0, 0.9 * ch * signP), height: h)
                    .clipped()
                    .opacity(rcClampD(signP, 0, 1))
            }
            ForEach((0..<places).reversed(), id: \.self) { p in
                let col = cols[p] ?? RCColumn.resting(place: p, abs: a)
                let pres = col.presence.sample(now).x
                if col.shown || pres > 0.001 {
                    column(col, ch: ch, h: h, fs: fs, now: now, pal: pal)
                        .frame(width: Swift.max(0, ch * pres), height: h)
                        .clipped()
                        .mask(RCColumn.mask)
                        .opacity(rcClampD(pres, 0, 1))
                }
            }
        }
        .padding(.horizontal, 4)
        .frame(minWidth: 2 * ch + 8)
        .offset(x: shake.sample(now).x)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("当前数值 \(current)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: _ = bump(1)
            case .decrement: _ = bump(-1)
            @unknown default: break
            }
        }
    }

    /// 一根数字轴：0–9 按与当前值的环形距离摆放，比当前大的在下方，小的在上方
    @ViewBuilder
    private func column(_ col: RCColumn, ch: Double, h: Double, fs: Double, now: Date, pal: RCPalette) -> some View {
        let s = col.digit.sample(now)
        let pv = (s.x.truncatingRemainder(dividingBy: 10) + 10).truncatingRemainder(dividingBy: 10)
        let radius = blur && !reduce ? Swift.min(abs(s.v) * 0.2, 4) : 0
        ZStack {
            ForEach(0..<10, id: \.self) { d in
                let raw = (10 + Double(d) - pv).truncatingRemainder(dividingBy: 10)
                let offset = raw > 5 ? raw - 10 : raw
                if abs(offset) < 1.5 {
                    Text("\(d)")
                        .font(.system(size: fs, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(pal.fg)
                        .fixedSize()
                        .frame(width: ch, height: h)
                        .offset(y: offset * h)
                }
            }
        }
        .frame(width: ch, height: h)
        .blur(radius: radius)
    }

    @ViewBuilder
    private func meta(width: Double, now: Date, pal: RCPalette) -> some View {
        VStack(spacing: 8) {
            ZStack(alignment: .leading) {
                Capsule().fill(pal.track)
                Capsule().fill(pal.fill)
                    .scaleEffect(x: fill.sample(now).x, y: 1, anchor: .leading)
            }
            .frame(height: 4)
            .clipShape(Capsule())
            .accessibilityHidden(true)
            HStack {
                Text("\(lo)")
                Spacer(minLength: 0)
                Text("\(hi)")
            }
            .font(.system(size: 11))
            .monospacedDigit()
            .foregroundStyle(pal.muted)
        }
        .frame(width: width)
    }

    // MARK: - 交互

    private func pressStart(_ dir: Int) {
        let atLimit = dir < 0 ? current <= lo : current >= hi
        // whileTap：到达极限的那颗按钮不缩
        if !atLimit { setPress(dir) { $0.tween(to: 0.9, duration: 0.09, curve: RCCurve.press, now: Date()) } }
        start(dir)
    }

    private func release(_ dir: Int) {
        holdGen &+= 1
        setPress(dir) { $0.tween(to: 1, duration: 0.26, curve: RCCurve.pop, now: Date()) }
    }

    private func setPress(_ dir: Int, _ change: (inout RCValue) -> Void) {
        if dir < 0 { change(&pressMinus) } else { change(&pressPlus) }
        keepAlive(0.3)
    }

    /// 长按：先走一步，420ms 后开始连走，间隔从 150ms 指数收敛到 32ms（越按越快）
    private func start(_ dir: Int) {
        holdGen &+= 1
        let g = holdGen
        guard bump(dir) else { return }
        Task { @MainActor in
            var n = 0
            var delay = 0.42
            while true {
                try? await Task.sleep(for: .seconds(delay))
                guard g == holdGen else { return }
                guard bump(dir) else {
                    // 走到头了：whileTap 撤掉，按钮弹回
                    setPress(dir) { $0.tween(to: 1, duration: 0.26, curve: RCCurve.pop, now: Date()) }
                    return
                }
                n += 1
                delay = Swift.max(0.032, 0.15 * pow(0.88, Double(n)))
            }
        }
    }

    /// 走一步，返回是否成功（到达极限则抖动并返回 false）
    @discardableResult
    private func bump(_ dir: Int) -> Bool {
        let cur = current
        let next = rcClamp(cur + dir * stepInt, lo, hi)
        if next == cur {
            knock(dir)
            return false
        }
        commit(next)
        // 长按加速到 30 次/秒时不要每步都震，最多 ~16 次/秒，像棘轮
        let now = Date()
        if haptics && now.timeIntervalSince(lastTick) > 0.06 {
            lastTick = now
            UISelectionFeedbackGenerator().selectionChanged()
        }
        return true
    }

    private func knock(_ dir: Int) {
        let now = Date()
        let k = Double(dir) * (reduce ? 0.4 : 1)
        shake.keys([0, 7 * k, -6 * k, 4 * k, -2 * k, 0], duration: 0.42, curve: RCCurve.easeOut, now: now)
        if dir < 0 {
            shakeMinus.keys([0, 5 * k, -4 * k, 2 * k, 0], duration: 0.36, curve: RCCurve.easeOut, now: now)
        } else {
            shakePlus.keys([0, 5 * k, -4 * k, 2 * k, 0], duration: 0.36, curve: RCCurve.easeOut, now: now)
        }
        keepAlive(0.42)
        Haptics.pop(haptics)
    }

    private func commit(_ next: Int) {
        if let value { value.wrappedValue = Double(next) } else { internalValue = next }
        onValueChange?(Double(next))
    }

    /// 上下限变化时把当前值收回范围内
    private func clampIntoRange() {
        let raw = value.map { Int($0.wrappedValue.rounded()) } ?? internalValue
        let v = rcClamp(raw, lo, hi)
        if v != raw { commit(v) }
        fill.spring(to: progress, stiffness: Self.fillSpring.k, damping: Self.fillSpring.c, now: Date())
        keepAlive(fill.settle)
    }

    /// 数值变了：每一位的数字轴弹到新目标，位数增减时整列宽度 0 ↔ 1ch 弹进弹出
    private func apply(from old: Int, to new: Int) {
        let now = Date()
        let absDir: Double = abs(new) >= abs(old) ? 1 : -1
        let a = abs(new)
        var until = 0.0
        for p in 0..<places {
            var col = cols[p] ?? RCColumn.resting(place: p, abs: abs(old))
            let unit = rcPow10(p)
            let show = p == 0 || a >= unit
            let target = Double(a / unit)
            if show {
                if !col.shown {
                    // 新出现的位从「上一个数字」滚进来
                    if col.presence.sample(now).x < 0.001 { col.digit = RCValue(target - absDir) }
                    col.presence.spring(to: 1, stiffness: Self.colSpring.k, damping: Self.colSpring.c, now: now)
                    col.shown = true
                }
                if col.digit.target != target {
                    col.digit.spring(to: target, stiffness: stiffness, damping: digitDamping, now: now)
                }
            } else if col.shown {
                // 消失的位保持最后的数字，只收起宽度
                col.shown = false
                col.presence.spring(to: 0, stiffness: Self.colSpring.k, damping: Self.colSpring.c, now: now)
            }
            until = Swift.max(until, col.digit.settle, col.presence.settle)
            cols[p] = col
        }
        let wantSign: Double = new < 0 ? 1 : 0
        if sign.target != wantSign {
            sign.spring(to: wantSign, stiffness: Self.colSpring.k, damping: Self.colSpring.c, now: now)
        }
        fill.spring(to: progress, stiffness: Self.fillSpring.k, damping: Self.fillSpring.c, now: now)
        keepAlive(Swift.max(until, sign.settle, fill.settle))
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

// MARK: - 一位

private struct RCColumn {
    var digit: RCValue
    var presence: RCValue
    var shown: Bool

    /// 还没动过的位：直接停在该在的位置
    static func resting(place p: Int, abs a: Int) -> RCColumn {
        let show = p == 0 || a >= rcPow10(p)
        return RCColumn(digit: RCValue(Double(a / rcPow10(p))), presence: RCValue(show ? 1 : 0), shown: show)
    }

    /// 上下渐隐：linear-gradient(to bottom, transparent, #000 22%, #000 78%, transparent)
    static let mask = LinearGradient(
        stops: [
            .init(color: .clear, location: 0),
            .init(color: .black, location: 0.22),
            .init(color: .black, location: 0.78),
            .init(color: .clear, location: 1),
        ],
        startPoint: .top, endPoint: .bottom
    )
}

private func rcPow10(_ p: Int) -> Int {
    var v = 1
    for _ in 0..<p { v *= 10 }
    return v
}

private func rcClamp(_ v: Int, _ lo: Int, _ hi: Int) -> Int { Swift.min(hi, Swift.max(lo, v)) }
private func rcClampD(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }

// MARK: - 图标（lucide Minus / Plus，viewBox 24）

private struct RCIcon: Shape {
    let plus: Bool
    func path(in rect: CGRect) -> Path {
        let u = Swift.min(rect.width, rect.height) / 24
        let ox = rect.midX - 12 * u, oy = rect.midY - 12 * u
        var p = Path()
        p.move(to: CGPoint(x: ox + 5 * u, y: oy + 12 * u))
        p.addLine(to: CGPoint(x: ox + 19 * u, y: oy + 12 * u))
        if plus {
            p.move(to: CGPoint(x: ox + 12 * u, y: oy + 5 * u))
            p.addLine(to: CGPoint(x: ox + 12 * u, y: oy + 19 * u))
        }
        return p
    }
}

// MARK: - 颜色（style.css 浅色 / 深色）

private struct RCPalette {
    let fg, muted, pill, btn, btnFg, track, fill: Color

    static let light = RCPalette(
        fg: Color(hex: "#111111"), muted: Color(hex: "#8A8A8A"), pill: Color(hex: "#FFFFFF"),
        btn: Color(hex: "#F1F1F1"), btnFg: Color(hex: "#111111"), track: Color(hex: "#E6E6E6"), fill: Color(hex: "#111111")
    )
    static let dark = RCPalette(
        fg: Color(hex: "#F5F5F5"), muted: Color(hex: "#6F6F6F"), pill: Color(hex: "#1D1D1D"),
        btn: Color(hex: "#2A2A2A"), btnFg: Color(hex: "#F5F5F5"), track: Color(hex: "#2A2A2A"), fill: Color(hex: "#F5F5F5")
    )
}

// MARK: - 曲线

/// CSS / motion 的 cubic-bezier(x1, y1, x2, y2)，y 可以超出 0…1（回弹曲线）
private struct RCBezier {
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

private enum RCCurve {
    /// whileTap 按下：{ duration: 0.09, ease: [0.3, 0, 0.5, 1] }
    static let press = RCBezier(0.3, 0, 0.5, 1)
    /// 松开弹回：{ duration: 0.26, ease: [0.28, 1.3, 0.36, 1] }
    static let pop = RCBezier(0.28, 1.3, 0.36, 1)
    /// motion 的 easeOut
    static let easeOut = RCBezier(0, 0, 0.58, 1)
}

// MARK: - 一个会动的数值（motion 的 MotionValue + animate / useSpring 的最小复刻）

private struct RCValue {
    private enum Mode {
        case still
        case tween(from: Double, duration: Double, curve: RCBezier)
        case keys([Double], duration: Double, curve: RCBezier)
        case spring(from: Double, v0: Double, k: Double, c: Double)
    }

    private var mode: Mode = .still
    private(set) var target: Double
    private var start = Date.distantPast
    /// 这段动画多久后停下（秒，从开始算）
    private var length: Double = 0

    init(_ v: Double) { target = v }

    /// 距离停下还剩多久（秒）
    var settle: Double { Swift.max(0, length - Date().timeIntervalSince(start)) }

    /// 当前值和速度（单位 / 秒）
    func sample(_ now: Date) -> (x: Double, v: Double) {
        let t = Swift.max(0, now.timeIntervalSince(start))
        switch mode {
        case .still:
            return (target, 0)
        case let .tween(from, duration, curve):
            if t >= duration { return (target, 0) }
            return (from + (target - from) * curve(t / duration), 0)
        case let .keys(values, duration, curve):
            // 关键帧均匀分布，每段各用一次 ease（motion 的单个 ease 作用在每一段上）
            if t >= duration || values.count < 2 { return (values.last ?? target, 0) }
            let segs = Double(values.count - 1)
            let f = t / duration * segs
            let i = Swift.min(Int(f), values.count - 2)
            return (values[i] + (values[i + 1] - values[i]) * curve(f - Double(i)), 0)
        case let .spring(from, v0, k, c):
            if t >= length { return (target, 0) }
            let s = Self.solve(t, delta: target - from, v0: v0, k: k, c: c)
            return (target - s.e, -s.de)
        }
    }

    mutating func tween(to v: Double, duration: Double, curve: RCBezier, now: Date) {
        let from = sample(now).x
        mode = .tween(from: from, duration: duration, curve: curve)
        target = v
        start = now
        length = duration
    }

    mutating func keys(_ values: [Double], duration: Double, curve: RCBezier, now: Date) {
        mode = .keys(values, duration: duration, curve: curve)
        target = values.last ?? 0
        start = now
        length = duration
    }

    /// 弹簧：从当前值、带当前速度出发（mass = 1）
    mutating func spring(to v: Double, stiffness k: Double, damping c: Double, now: Date) {
        let s = sample(now)
        let delta = v - s.x
        mode = .spring(from: s.x, v0: s.v, k: k, c: c)
        target = v
        start = now
        // 估算停下的时刻：和 useSpring 一样 restDelta 0.001、restSpeed 0.01
        var t = 0.0
        while t < 6 {
            let r = Self.solve(t, delta: delta, v0: s.v, k: k, c: c)
            if abs(r.e) < 0.001 && abs(r.de) < 0.01 { break }
            t += 1.0 / 120
        }
        length = t
    }

    /// 阻尼弹簧解析解（和 motion 的 spring 一致），e = 离目标的距离，de = 它的导数
    private static func solve(_ t: Double, delta: Double, v0: Double, k: Double, c: Double) -> (e: Double, de: Double) {
        let zeta = c / (2 * k.squareRoot())
        let w0 = k.squareRoot()
        if zeta < 1 {
            let a = zeta * w0
            let wd = w0 * (1 - zeta * zeta).squareRoot()
            let A = (-v0 + a * delta) / wd
            let env = exp(-a * t)
            let s = sin(wd * t), co = cos(wd * t)
            return (env * (delta * co + A * s), env * ((-a * delta + A * wd) * co + (-a * A - delta * wd) * s))
        } else if zeta == 1 {
            let B = -v0 + w0 * delta
            let env = exp(-w0 * t)
            return (env * (delta + B * t), env * (B - w0 * (delta + B * t)))
        } else {
            let wd = w0 * (zeta * zeta - 1).squareRoot()
            let slow = zeta * w0 - wd, fast = zeta * w0 + wd
            let C1 = (fast * delta - v0) / (fast - slow)
            let C2 = delta - C1
            return (C1 * exp(-slow * t) + C2 * exp(-fast * t), -slow * C1 * exp(-slow * t) - fast * C2 * exp(-fast * t))
        }
    }
}

#Preview("默认") {
    RollingCounter()
        .frame(height: 320)
}

#Preview("大跨度 · 深色") {
    struct Demo: View {
        @State private var v: Double = 0
        var body: some View {
            VStack(spacing: 0) {
                RollingCounter(step: 25, min: -99, max: 9999, stiffness: 360, value: $v)
                    .frame(height: 320)
                RollingCounter(stiffness: 80)
                    .frame(height: 320)
            }
            .background(Color(hex: "#111111"))
            .environment(\.colorScheme, .dark)
        }
    }
    return Demo()
}
