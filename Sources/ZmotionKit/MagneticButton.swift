// 磁吸按钮（Magnetic button）：指针靠近时按钮被「吸」过去，文字比按钮跑得更远形成视差，磁场随距离渐亮；
// 离开后弹簧回位，点击泛起涟漪，文案换成「已开始」1.5 秒后换回。
//
// 指针 / 触屏：
// - iPad 接了触控板 / 鼠标时（onContinuousHover）和网页鼠标一样：悬停就有磁吸，悬在按钮上放大到 1.03。
// - 触屏没有悬停。网页在粗指针上靠的是「按住移动时的 pointermove + 抬手 pointerup 复位」：
//   按下不吸，手指按住移动时按钮跟着吸，抬手弹回原位；按在按钮上会缩到 0.95，抬手时手指还在按钮上就算点击。
//   原生端照搬这套：整个组件区域一个 DragGesture(minimumDistance: 0) 负责按下 / 移动 / 抬手，没有第二个手势。
//
// 动画：按钮位移 x / y 和磁场亮度都是 motion 的 useSpring（每次目标改变都从当前值、带着当前速度重新起弹簧），
// 文字 / 箭头的视差是对 x / y 逐帧做软限幅（tanh），所以这里用 CADisplayLink 逐帧求解弹簧（SwiftUI 的 Spring，和 motion 同一物理模型）。
// 按下 / 悬停缩放、涟漪、文案切换是声明式小动画，直接用 SwiftUI 动画（曲线和网站一致）。
import SwiftUI
import UIKit
import Observation

public struct MagneticButton: View {
    let strength: Double
    let radius: Double
    let stiffness: Double
    let parallax: Double
    let color: Color
    let title: String
    let doneTitle: String
    let haptics: Bool
    let onTap: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = MBModel()
    /// 每次点击 +1，用来重启「已开始」的计时；0 = 显示「开始体验」
    @State private var doneCount = 0
    @State private var ripples: [MBRipple] = []
    @State private var buttonSize: CGSize = .zero
    @State private var pressed = false
    @State private var hovering = false
    @GestureState private var touching = false

    /// - Parameters:
    ///   - strength: 吸力：按钮跟随指针的比例，越大被拉得越远（0.1–1）
    ///   - radius: 磁场半径：指针距离按钮边缘多近时开始产生吸引（pt，30–160）
    ///   - stiffness: 弹簧刚度：越大跟手越紧，越小越黏滞、回弹越慢（60–600）
    ///   - parallax: 文字视差：文字位移是按钮位移的几倍，1 为不视差（1–2.5）
    ///   - color: 按钮与磁场光晕的颜色
    ///   - title: 按钮文案（默认「开始体验」）
    ///   - doneTitle: 点击后 1.5 秒内显示的文案（默认「已开始」）
    ///   - haptics: 触感反馈（进入磁场轻触一下，点击时成功反馈；网站版的音效在原生端换成触感）
    ///   - onTap: 点击回调
    public init(
        strength: Double = 0.4,
        radius: Double = 90,
        stiffness: Double = 220,
        parallax: Double = 1.6,
        color: Color = Color(hex: "#5B5BF6"),
        title: String = "开始体验",
        doneTitle: String = "已开始",
        haptics: Bool = true,
        onTap: (() -> Void)? = nil
    ) {
        self.strength = strength
        self.radius = radius
        self.stiffness = stiffness
        self.parallax = parallax
        self.color = color
        self.title = title
        self.doneTitle = doneTitle
        self.haptics = haptics
        self.onTap = onTap
    }

    private var done: Bool { doneCount > 0 }

    /// 阻尼比 ≈ 0.68：被吸过去时有一点点过冲，松开后利落回位，不会晃个不停
    private var magnetSpring: Spring {
        let mass = 0.7
        return Spring(mass: mass, stiffness: stiffness, damping: 2 * (stiffness * mass).squareRoot() * 0.68, allowOverDamping: true)
    }

    public var body: some View {
        GeometryReader { geo in
            let size = geo.size
            // 根字号跟着画布走：clamp(15px, 4.4cqmin, 19px)
            let fs = min(max(min(size.width, size.height) * 0.044, 15), 19)
            ZStack {
                if buttonSize.width > 0 { field }
                button(fs)
            }
            .frame(width: size.width, height: size.height)
            .contentShape(Rectangle())
            .gesture(drag(size))
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case .active(let p):
                    move(p, size)
                    let over = buttonRect(size).contains(p)
                    if over != hovering { withAnimation(MBCurve.pop) { hovering = over } }
                case .ended:
                    if hovering { withAnimation(MBCurve.pop) { hovering = false } }
                    if model.touch == nil { reset() }
                }
            }
        }
        .clipped()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(done ? doneTitle : title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { click(at: nil) }
        .task(id: doneCount) {
            guard doneCount > 0 else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { doneCount = 0 }
        }
        .onChange(of: touching) { _, isTouching in
            // 手势被系统打断时 onEnded 不会触发，这里兜底（相当于 pointercancel）
            guard !isTouching else { return }
            DispatchQueue.main.async {
                guard model.touch != nil else { return }
                model.touch = nil
                if pressed { withAnimation(MBCurve.pop) { pressed = false } }
                reset()
            }
        }
    }

    /* ---------- 磁场 ---------- */

    /// 磁场范围：胶囊外扩 radius，正好是「距离按钮边缘 radius」的等值线；指针越近越亮
    private var field: some View {
        let dark = colorScheme == .dark
        let line = color.opacity(dark ? 0.30 : 0.22)
        let fill = color.opacity(dark ? 0.16 : 0.10)
        let p = mbClamp(model.power.value, 0, 1)
        return Capsule()
            // radial-gradient(closest-side, fill, transparent)：椭圆贴着四条边
            .fill(EllipticalGradient(colors: [fill, fill.opacity(0)], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5))
            .overlay(Capsule().strokeBorder(line, lineWidth: 1))
            .frame(width: buttonSize.width + radius * 2, height: buttonSize.height + radius * 2)
            .scaleEffect(0.86 + 0.14 * p)
            .opacity(p)
            .allowsHitTesting(false)
    }

    /* ---------- 按钮 ---------- */

    private func button(_ fs: CGFloat) -> some View {
        let dark = colorScheme == .dark
        let x = model.x.value
        let y = model.y.value
        let k = parallax - 1
        // 文字相对按钮再多走 (parallax - 1) 倍，但被软限幅在按钮里，箭头再多一点
        let lx = mbSoft(x * k, 14)
        let ly = mbSoft(y * k, 6)
        let ax = mbSoft(x * k * 0.5, 4)
        let fg = mbReadableText(color)
        let scale: CGFloat = pressed ? 0.95 : hovering ? 1.03 : 1

        return label(fs, fg: fg, arrowX: ax)
            .offset(x: lx, y: ly)
            .padding(.vertical, fs)
            .padding(.horizontal, fs * 1.75)
            .frame(minWidth: fs * 9.5)
            .background {
                ZStack(alignment: .topLeading) {
                    color
                    // 高光：跟着指针位置的径向光，亮度随磁场
                    Rectangle()
                        .fill(RadialGradient(
                            stops: [.init(color: .white.opacity(0.32), location: 0), .init(color: .white.opacity(0), location: 0.7)],
                            center: UnitPoint(x: model.hx, y: model.hy),
                            startRadius: 0,
                            endRadius: 120
                        ))
                        .opacity(mbClamp(model.power.value, 0, 1))
                    ForEach(ripples) { r in
                        MBRippleView(diameter: fs * 20)
                            .position(x: r.x, y: r.y)
                    }
                }
            }
            .clipShape(Capsule())
            .overlay {
                // inset 0 1px 0 rgb(255 255 255 / .22)：顶边内侧 1pt 的亮边
                ZStack {
                    Capsule().fill(Color.white.opacity(dark ? 0.18 : 0.22))
                    Capsule().offset(y: 1).blendMode(.destinationOut)
                }
                .compositingGroup()
                .clipShape(Capsule())
                .allowsHitTesting(false)
            }
            .overlay {
                // 深色：0 0 0 1px rgb(255 255 255 / .04) 外描边
                if dark {
                    Capsule().inset(by: -1).strokeBorder(Color.white.opacity(0.04), lineWidth: 1).allowsHitTesting(false)
                }
            }
            .shadow(color: dark ? .clear : .black.opacity(0.12), radius: 1, x: 0, y: 1)
            .background {
                // 0 12px 28px -10px：收缩 10pt 的胶囊、下移 12pt、模糊 14（= CSS blur 28 的 σ）
                Capsule()
                    .fill(mbShadowColor(color, dark: dark))
                    .padding(10)
                    .offset(y: 12)
                    .blur(radius: 14)
                    .allowsHitTesting(false)
            }
            .onGeometryChange(for: CGSize.self, of: { $0.size }) { buttonSize = $0 }
            .scaleEffect(scale)
            .offset(x: x, y: y)
    }

    private func label(_ fs: CGFloat, fg: Color, arrowX: CGFloat) -> some View {
        let lh = fs * 1.2
        // 新文案从下方 110% 进入，旧文案向上 110% 退出（AnimatePresence popLayout，初次渲染不动）
        let move = AnyTransition.asymmetric(
            insertion: .offset(y: lh * 1.1).combined(with: .opacity),
            removal: .offset(y: -lh * 1.1).combined(with: .opacity)
        )
        return ZStack {
            if done {
                HStack(spacing: fs * 0.45) {
                    MBCheckIcon(color: fg).frame(width: fs * 1.1, height: fs * 1.1)
                    Text(doneTitle)
                }
                .transition(move)
            } else {
                HStack(spacing: fs * 0.45) {
                    Text(title)
                    MBArrowIcon(color: fg)
                        .frame(width: fs * 1.1, height: fs * 1.1)
                        .offset(x: arrowX)
                }
                .transition(move)
            }
        }
        .font(.system(size: fs, weight: .semibold))
        .tracking(fs * 0.02)
        .foregroundStyle(fg)
        .lineLimit(1)
        .fixedSize()
        .frame(height: lh)
        .animation(MBCurve.text, value: done)
    }

    /* ---------- 磁吸逻辑（和网页 onMove 一致） ---------- */

    /// 按钮静止时（未位移）的位置：组件正中
    private func anchorRect(_ size: CGSize) -> CGRect {
        CGRect(x: (size.width - buttonSize.width) / 2, y: (size.height - buttonSize.height) / 2, width: buttonSize.width, height: buttonSize.height)
    }

    /// 按钮当前（被吸走后）的位置，用来判断按下 / 抬手 / 悬停是否在按钮上
    private func buttonRect(_ size: CGSize) -> CGRect {
        anchorRect(size).offsetBy(dx: model.x.value, dy: model.y.value)
    }

    private func move(_ p: CGPoint, _ size: CGSize) {
        guard buttonSize.width > 0 else { return }
        let r = anchorRect(size)
        let dx = p.x - r.midX
        let dy = p.y - r.midY
        // 指针到胶囊形按钮边缘的距离（按钮内部为 0）
        let half = r.height / 2
        let qx = max(abs(dx) - (r.width / 2 - half), 0)
        let d = max(hypot(qx, dy) - half, 0)
        let f = d >= radius ? 0 : mbSmooth(1 - d / radius)
        let k = reduceMotion ? strength * 0.25 : strength

        model.x.follow(dx * k * f, magnetSpring)
        model.y.follow(dy * k * f, magnetSpring)
        model.power.follow(f, MBModel.powerSpring)
        model.hx = (p.x - r.minX) / r.width
        model.hy = (p.y - r.minY) / r.height

        // 只在「进入磁场」那一下轻触一下
        if f > 0 && !model.inField { Haptics.tap(haptics) }
        model.inField = f > 0
    }

    private func reset() {
        model.x.follow(0, magnetSpring)
        model.y.follow(0, magnetSpring)
        model.power.follow(0, MBModel.powerSpring)
        model.inField = false
    }

    /* ---------- 触屏：按住移动 = 磁吸，抬手复位；按在按钮上抬手 = 点击 ---------- */

    private func drag(_ size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($touching) { _, state, _ in state = true }
            .onChanged { v in
                if model.touch == nil {
                    let onButton = buttonRect(size).contains(v.startLocation)
                    model.touch = MBTouch(onButton: onButton)
                    if onButton { withAnimation(MBCurve.press) { pressed = true } }
                    return // 网页上按下本身不触发 pointermove，移动后才开始吸
                }
                move(v.location, size)
            }
            .onEnded { v in
                guard let t = model.touch else { return }
                model.touch = nil
                let rect = buttonRect(size)
                if t.onButton && rect.contains(v.location) {
                    click(at: CGPoint(x: v.location.x - rect.minX, y: v.location.y - rect.minY))
                }
                if pressed { withAnimation(MBCurve.pop) { pressed = false } }
                // 网页：非鼠标的 pointerup → 复位
                reset()
            }
    }

    /// 点击：在按下位置泛起涟漪（读屏 / 键盘触发时在正中），文案切到「已开始」
    private func click(at p: CGPoint?) {
        let pt = p ?? CGPoint(x: buttonSize.width / 2, y: buttonSize.height / 2)
        let ripple = MBRipple(x: pt.x, y: pt.y)
        ripples = Array(ripples.suffix(3)) + [ripple]
        Task {
            try? await Task.sleep(for: .seconds(0.6))
            ripples.removeAll { $0.id == ripple.id }
        }
        if done { Haptics.tap(haptics) } else { Haptics.success(haptics) }
        doneCount += 1
        onTap?()
    }
}

/* ---------- 曲线 ---------- */

private enum MBCurve {
    /// 悬停放大 / 回弹：{ duration: 0.26, ease: [0.28, 1.3, 0.36, 1] }
    static let pop = Animation.timingCurve(0.28, 1.3, 0.36, 1, duration: 0.26)
    /// 按下：{ duration: 0.09, ease: [0.3, 0, 0.5, 1] }
    static let press = Animation.timingCurve(0.3, 0, 0.5, 1, duration: 0.09)
    /// 文案切换：motion { type: "spring", duration: 0.38, bounce: 0.2 }，按 motion 的 findSpring 换算成刚度 / 阻尼
    static let text: Animation = {
        let s = mbFindSpring(duration: 0.38, bounce: 0.2)
        return .motionSpring(stiffness: s.stiffness, damping: s.damping)
    }()
}

/* ---------- 小工具 ---------- */

private func mbClamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }
private func mbSmooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }
/// 软限幅：小位移原样通过，越往外越难拉，永远不超过 max
private func mbSoft(_ v: Double, _ max: Double) -> Double { max * tanh(v / max) }

private func mbRGB(_ c: Color) -> (r: Double, g: Double, b: Double) {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    UIColor(c).getRed(&r, green: &g, blue: &b, alpha: &a)
    return (Double(r), Double(g), Double(b))
}

/// 根据背景色选择黑/白文字，保证浅色按钮也可读
private func mbReadableText(_ c: Color) -> Color {
    let (r, g, b) = mbRGB(c)
    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return lum > 0.62 ? Color(hex: "#111111") : .white
}

/// 按钮投影色：浅色 color-mix(color 50%, transparent)；深色 color-mix(color 40%, black)
private func mbShadowColor(_ c: Color, dark: Bool) -> Color {
    guard dark else { return c.opacity(0.5) }
    let (r, g, b) = mbRGB(c)
    return Color(.sRGB, red: r * 0.4, green: g * 0.4, blue: b * 0.4, opacity: 1)
}

/// motion-dom spring.mjs 的 findSpring（bounce ≥ 0 的部分）：duration 是「停稳时间」，求出 stiffness / damping
private func mbFindSpring(duration durationSec: Double, bounce: Double) -> (stiffness: Double, damping: Double) {
    let safeMin = 0.001
    let ratio = max(1 - bounce, 0.05)
    let duration = mbClamp(durationSec, 0.01, 10)
    func angular(_ f: Double, _ r: Double) -> Double { f * (1 - r * r).squareRoot() }
    let envelope: (Double) -> Double
    let derivative: (Double) -> Double
    if ratio < 1 {
        envelope = { f in
            let decay = f * ratio
            return safeMin - (decay / angular(f, ratio)) * exp(-decay * duration)
        }
        derivative = { f in
            let decay = f * ratio
            let e = ratio * ratio * f * f * duration
            let ff = exp(-decay * duration)
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
    let stiffness = f * f
    let damping = ratio * 2 * stiffness.squareRoot()
    guard stiffness > 0, stiffness.isFinite, damping >= 0, damping.isFinite else { return (100, 10) }
    return (stiffness, damping)
}

/* ---------- 涟漪 ---------- */

private struct MBRipple: Identifiable {
    let id = UUID()
    let x: CGFloat
    let y: CGFloat
}

/// 20em 的白色圆：scale 0 → 1、opacity 0.4 → 0，0.6s，ease [0.2, 0.7, 0.3, 1]
private struct MBRippleView: View {
    let diameter: CGFloat
    @State private var go = false
    var body: some View {
        Circle()
            .fill(Color.white.opacity(0.5))
            .frame(width: diameter, height: diameter)
            .scaleEffect(go ? 1 : 0.001)
            .opacity(go ? 0 : 0.4)
            .allowsHitTesting(false)
            .onAppear {
                withAnimation(.timingCurve(0.2, 0.7, 0.3, 1, duration: 0.6)) { go = true }
            }
    }
}

/* ---------- 图标（lucide ArrowRight / Check，24 格坐标） ---------- */

private struct MBArrowIcon: View {
    let color: Color
    var body: some View {
        Canvas { ctx, size in
            let k = size.width / 24
            var p = Path()
            p.move(to: CGPoint(x: 5 * k, y: 12 * k)); p.addLine(to: CGPoint(x: 19 * k, y: 12 * k))
            p.move(to: CGPoint(x: 12 * k, y: 5 * k)); p.addLine(to: CGPoint(x: 19 * k, y: 12 * k)); p.addLine(to: CGPoint(x: 12 * k, y: 19 * k))
            ctx.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: 2.4 * k, lineCap: .round, lineJoin: .round))
        }
    }
}

private struct MBCheckIcon: View {
    let color: Color
    var body: some View {
        Canvas { ctx, size in
            let k = size.width / 24
            var p = Path()
            p.move(to: CGPoint(x: 20 * k, y: 6 * k)); p.addLine(to: CGPoint(x: 9 * k, y: 17 * k)); p.addLine(to: CGPoint(x: 4 * k, y: 12 * k))
            ctx.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: 2.6 * k, lineCap: .round, lineJoin: .round))
        }
    }
}

/* ---------- 状态 + 逐帧弹簧（对应 motion 的 useSpring） ---------- */

private struct MBTouch {
    /// 按下时是否在按钮上（网页：按钮 touch-action: none，按在按钮上才会触发点击）
    let onButton: Bool
}

@MainActor
@Observable
private final class MBModel {
    static let powerSpring = Spring(mass: 1, stiffness: 300, damping: 30, allowOverDamping: true)

    let x = MBValue(0)
    let y = MBValue(0)
    let power = MBValue(0)
    /// 高光中心（相对按钮 0…1）
    var hx = 0.5
    var hy = 0.5
    @ObservationIgnored var inField = false
    @ObservationIgnored var touch: MBTouch?
}

/// 一个跟随目标的弹簧值：目标一变，就从当前值、带着当前速度向新目标起一段新弹簧（= motion 的 useSpring）
@MainActor
@Observable
private final class MBValue {
    var value: Double
    @ObservationIgnored private var run: Run?

    private struct Run {
        var from: Double
        var to: Double
        var v0: Double
        var spring: Spring
        var start: CFTimeInterval
    }

    init(_ v: Double) { value = v }

    private func sample(_ r: Run, _ now: CFTimeInterval) -> (x: Double, v: Double) {
        let t = max(0, now - r.start)
        let d = r.to - r.from
        return (r.from + r.spring.value(target: d, initialVelocity: r.v0, time: t), r.spring.velocity(target: d, initialVelocity: r.v0, time: t))
    }

    func follow(_ target: Double, _ spring: Spring) {
        let now = CACurrentMediaTime()
        var from = value
        var v0 = 0.0
        if let r = run {
            if r.to == target { return }
            (from, v0) = sample(r, now)
        } else if target == value {
            return
        }
        run = Run(from: from, to: target, v0: v0, spring: spring, start: now)
        MBTicker.shared.add(self)
    }

    /// 走一帧；返回 false 表示停稳了
    func step(_ now: CFTimeInterval) -> Bool {
        guard let r = run else { return false }
        let (p, v) = sample(r, now)
        // motion 的默认收尾阈值：变化量很小（< 5，比如亮度）时用更细的阈值
        let granular = abs(r.to - r.from) < 5
        if abs(r.to - p) <= (granular ? 0.005 : 0.5) && abs(v) <= (granular ? 0.01 : 2) {
            run = nil
            value = r.to
            return false
        }
        value = p
        return true
    }
}

@MainActor
private final class MBTicker: NSObject {
    static let shared = MBTicker()
    private var link: CADisplayLink?
    private var items: [ObjectIdentifier: MBValue] = [:]

    func add(_ v: MBValue) {
        items[ObjectIdentifier(v)] = v
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick(_ l: CADisplayLink) {
        let now = CACurrentMediaTime()
        for (id, v) in items where !v.step(now) {
            items[id] = nil
        }
        if items.isEmpty {
            link?.invalidate()
            link = nil
        }
    }
}

#Preview("手机 · 默认") {
    MagneticButton()
        .frame(height: 360)
}

#Preview("强磁 · 深色") {
    MagneticButton(strength: 0.8, radius: 150, stiffness: 360, parallax: 2.2, color: Color(hex: "#FF5FA2"))
        .frame(height: 420)
        .background(Color.black)
        .preferredColorScheme(.dark)
}

#Preview("轻柔 · 浅色按钮") {
    MagneticButton(strength: 0.2, radius: 60, stiffness: 120, parallax: 1.3, color: Color(hex: "#FFD60A"))
        .frame(width: 320, height: 280)
}
