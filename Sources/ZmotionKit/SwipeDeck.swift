// 滑卡选择（Swipe deck）：拖动顶部卡片，它会按你捏住的位置倾斜，显出「喜欢 / 跳过」印章，下面的卡片同时升起；
// 越过阈值或甩得够快就带着离手速度飞出，否则弹回原位。
// 多端：组件宽 < 600 手机布局（牌堆 + 下方按钮）；600–899 iPad（牌堆限高居中、按钮在两侧、右边一栏「已喜欢」，
// 喜欢的卡边飞边缩小落进去）；≥ 900 桌面（同 iPad，留白更多）。断点按组件自己的宽度（GeometryReader）。
// 网页演示里的假状态栏和「发现」标题行（含计数）原生端不画——系统状态栏和宿主导航栏已经有了，结果走 onSwipe 交给宿主。
//
// 动效说明：拖动相关的值（牌堆位置 pos、升起量 lift、顶卡 x / y / 倾斜 / 缩放）和网站版一样是「可打断、带离手速度」的弹簧，
// 这里用 SwiftUI 的 Spring(mass:stiffness:damping:)（和 Animation.motionSpring 同一个弹簧模型）逐帧求值，
// 这样能在动画中途重新捏住卡片、把离手速度（pt/s）原样带进甩出 / 回弹，并在每一帧从 x 推出升起量和按钮状态。
// 声明式的小动画（右栏新行撑开、缩略图落位、按钮按下）直接用 Animation.motionSpring。
import SwiftUI
import UIKit

public struct SwipeDeck: View {
    /// 甩出阈值（pt）：横向拖过这个距离松手才会飞出；甩得够快时不受限制
    let threshold: Double
    /// 倾斜角度（°）：拖到阈值时卡片的倾斜角度
    let rotation: Double
    /// 叠放层数：牌堆里能看到几张卡
    let depth: Double
    /// 显示印章：拖动时是否显示「喜欢 / 跳过」印章
    let stamps: Bool
    /// 触感反馈（网站版的音效在原生端换成触感）
    let haptics: Bool
    /// 每甩走一张卡回调一次：卡片标题、是否喜欢（右滑 / 喜欢按钮为 true）。
    /// 网页演示里的「发现」标题行和计数在原生端交给宿主页面（导航栏）去显示
    let onSwipe: ((_ title: String, _ liked: Bool) -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @State private var model = DeckModel()

    public init(threshold: Double = 110, rotation: Double = 12, depth: Double = 3, stamps: Bool = true, haptics: Bool = true, onSwipe: ((_ title: String, _ liked: Bool) -> Void)? = nil) {
        self.threshold = threshold
        self.rotation = rotation
        self.depth = depth
        self.stamps = stamps
        self.haptics = haptics
        self.onSwipe = onSwipe
    }

    public var body: some View {
        GeometryReader { geo in
            DeckContent(
                size: geo.size,
                model: model,
                threshold: max(1, threshold),
                rotation: rotation,
                layers: max(1, Int(depth.rounded())),
                stamps: stamps,
                haptics: haptics,
                onSwipe: onSwipe,
                pal: Palette(dark: colorScheme == .dark)
            )
        }
    }
}

// MARK: - 数据

private struct Place {
    let title: String
    let sub: String
    let rating: String
    let dist: String
    let a: String
    let b: String
    let sun: CGPoint
    let hills: (String, String)
}

private let places: [Place] = [
    Place(title: "京都", sub: "日本 · 秋叶季", rating: "4.9", dist: "1,820 km", a: "#FFB38A", b: "#D6336C", sun: CGPoint(x: 210, y: 120), hills: ("#B8235A", "#7A1340")),
    Place(title: "雷克雅未克", sub: "冰岛 · 极光", rating: "4.8", dist: "7,900 km", a: "#7FE3E8", b: "#2B3A9A", sun: CGPoint(x: 90, y: 96), hills: ("#27408F", "#141F5C")),
    Place(title: "大理", sub: "云南 · 苍山洱海", rating: "4.7", dist: "2,100 km", a: "#D4F29A", b: "#13866F", sun: CGPoint(x: 220, y: 90), hills: ("#1A8A6C", "#0B5747")),
    Place(title: "里斯本", sub: "葡萄牙 · 黄色电车", rating: "4.8", dist: "9,600 km", a: "#FFE08A", b: "#F06A1D", sun: CGPoint(x: 80, y: 130), hills: ("#E0621C", "#A8430F")),
    Place(title: "开普敦", sub: "南非 · 桌山", rating: "4.6", dist: "11,800 km", a: "#D3C2FF", b: "#5634B8", sun: CGPoint(x: 200, y: 110), hills: ("#5A37B8", "#33207A")),
]

private func place(_ serial: Int) -> Place { places[((serial % places.count) + places.count) % places.count] }

// 叠放：每往后一层缩小 5%、下移 12pt
private let layerScale = 0.05
private let layerY = 12.0
private let deckSpace = "swipe-deck"

/// 弹簧参数（和网站版 motion 的 stiffness / damping / mass 一一对应）
private struct SpringSpec {
    var stiffness: Double
    var damping: Double
    var mass: Double = 1
    var spring: Spring { Spring(mass: mass, stiffness: stiffness, damping: damping) }
}

private let settleSpring = SpringSpec(stiffness: 420, damping: 34)
/// 卡片离场的弹簧：手机甩出屏幕、大屏飞进「已喜欢」都用这一条
private let flySpring = SpringSpec(stiffness: 160, damping: 26)
/// 松手没甩出去时的回弹
private let returnSpring = SpringSpec(stiffness: 520, damping: 30)

/// 已喜欢的一张：serial 是牌堆里的序号（卡面按它取），arrived 表示飞行的卡已经落进右栏
private struct Liked: Identifiable, Equatable {
    let serial: Int
    var arrived: Bool
    var id: Int { serial }
}

private enum DeckEnd { case phone, ipad, desktop }

/// 颜色（来自 style.css，浅色 / 深色各一套）
private struct Palette {
    let dark: Bool
    var bg: Color { dark ? Color(hex: "#0C0C0D") : Color(hex: "#F4F4F5") }
    var fg: Color { dark ? Color(hex: "#F5F5F7") : Color(hex: "#111111") }
    var muted: Color { Color(hex: "#8A8A8E") }
    var btn: Color { dark ? Color(hex: "#1C1C1E") : .white }
    var btnLine: Color { dark ? Color.white.opacity(0.08) : Color.black.opacity(0.04) }
    var like: Color { Color(hex: "#FF3B5C") }
    var nope: Color { dark ? Color(hex: "#F5F5F7") : Color(hex: "#1C1C1E") }
}

/// 把 v 在 [a, b] 里换算成 0…1（两端截断），等同 motion 的 useTransform 默认的 clamp
private func ramp(_ v: Double, _ a: Double, _ b: Double) -> Double {
    guard b != a else { return v >= b ? 1 : 0 }
    return min(1, max(0, (v - a) / (b - a)))
}

// MARK: - 逐帧弹簧（对应 motion 的 MotionValue + animate）

@MainActor
private final class Ticker: NSObject {
    static let shared = Ticker()
    private var link: CADisplayLink?
    private var items: [ObjectIdentifier: MotionValue] = [:]

    func add(_ m: MotionValue) {
        items[ObjectIdentifier(m)] = m
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    func remove(_ m: MotionValue) { items[ObjectIdentifier(m)] = nil }

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

/// 一个会动的数：set 立即改值；animate 用弹簧过去（默认带上当前速度）；stop 停在当前帧的值上，可随时被手指接住
@MainActor
@Observable
private final class MotionValue {
    var value: Double
    /// 值每次变化后回调（对应 motion 的 useMotionValueEvent(x, "change")）
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
        let t = max(0, CACurrentMediaTime() - r.start)
        return r.spring.velocity(target: r.to - r.from, initialVelocity: r.v0, time: t)
    }

    func stop() {
        guard run != nil else { return }
        run = nil
        Ticker.shared.remove(self)
    }

    func set(_ v: Double) {
        stop()
        value = v
        onChange?(v)
    }

    /// 和 motion 的 animate(value, to, { type: "spring", stiffness, damping, mass, velocity, restDelta }) 一样
    func animate(to target: Double, _ s: SpringSpec, velocity: Double? = nil, restDelta: Double? = nil, completion: (() -> Void)? = nil) {
        let v0 = velocity ?? self.velocity
        // motion 的默认收尾阈值：变化量很小（< 5，比如进度、缩放）时用更细的阈值
        let granular = abs(target - value) < 5
        run = Run(
            from: value, to: target, v0: v0, spring: s.spring, start: CACurrentMediaTime(),
            restDelta: restDelta ?? (granular ? 0.005 : 0.5),
            restSpeed: granular ? 0.01 : 2,
            done: completion
        )
        Ticker.shared.add(self)
    }

    /// 走一帧；返回 false 表示这一段动画结束了
    func step(_ now: CFTimeInterval) -> Bool {
        guard let r = run else { return false }
        let t = max(0, now - r.start)
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

/// 一张卡自己的运动量：x / y 位移、grab（抓上半部分 1、下半部分 -1，决定倾斜方向）、scale（只有飞进右栏时才会变小）
@MainActor
private final class CardMotion {
    let x = MotionValue(0)
    let y = MotionValue(0)
    let grab = MotionValue(1)
    let scale = MotionValue(1)
    var gone = false
    var drag: DragInfo?

    struct DragInfo {
        var sx: CGFloat
        var sy: CGFloat
        var x0: Double
        var y0: Double
        var over: Bool
    }
}

// MARK: - 牌堆状态和手势逻辑

@MainActor
@Observable
private final class DeckModel {
    var top = 0
    var flying: [Int] = []
    // 喜欢过的卡（新的在前）；手机端不显示列表但照样记，切到大屏时右栏直接有内容
    var liked: [Liked] = []
    /// 每喜欢一张（大屏）加一，右栏据此滚回顶部
    var scrollToken = 0

    // pos：牌堆的「当前位置」（可以是小数，弹簧过渡）；lift：拖动顶卡时下面的卡跟着升起的量
    let pos = MotionValue(0)
    let lift = MotionValue(0)
    let dragX = MotionValue(0)

    @ObservationIgnored private var cards: [Int: CardMotion] = [:]

    // 由视图每次渲染时写入的参数和量到的布局（命名坐标空间 swipe-deck 里）
    @ObservationIgnored var threshold = 110.0
    @ObservationIgnored var haptics = true
    @ObservationIgnored var wide = false
    @ObservationIgnored var width: CGFloat = 400
    @ObservationIgnored var peek: CGFloat = 42
    @ObservationIgnored var listPad: CGFloat = 8
    @ObservationIgnored var stackFrame: CGRect = .zero
    @ObservationIgnored var listFrame: CGRect = .zero
    @ObservationIgnored var onSwipe: ((_ title: String, _ liked: Bool) -> Void)?

    func configure(threshold: Double, haptics: Bool, wide: Bool, width: CGFloat, peek: CGFloat, listPad: CGFloat, onSwipe: ((String, Bool) -> Void)?) {
        self.onSwipe = onSwipe
        self.threshold = threshold
        self.haptics = haptics
        self.wide = wide
        self.width = width
        self.peek = peek
        self.listPad = listPad
    }

    /// 卡槽：牌堆区去掉底部露出叠层的那一条
    var slotFrame: CGRect {
        CGRect(x: stackFrame.minX, y: stackFrame.minY, width: stackFrame.width, height: max(0, stackFrame.height - peek))
    }

    func card(_ serial: Int) -> CardMotion {
        if let c = cards[serial] { return c }
        let c = CardMotion()
        c.x.onChange = { [weak self] v in self?.topXChanged(serial, v) }
        cards[serial] = c
        return c
    }

    /// 顶卡 x 变化：同步按钮状态和下面卡片的升起量；拖动中跨过阈值时轻触一下
    private func topXChanged(_ serial: Int, _ v: Double) {
        guard serial == top, let c = cards[serial], !c.gone else { return }
        dragX.set(v)
        // 回弹时 lift 有自己的弹簧（和网站版一样由它说了算）
        if !lift.isAnimating { lift.set(min(1, abs(v) / threshold) * 0.85) }
        if var d = c.drag {
            let over = abs(v) > threshold
            if over != d.over {
                d.over = over
                c.drag = d
                Haptics.tap(haptics)
            }
        }
    }

    // MARK: 拖动
    //
    // 整个牌堆只挂一个拖动手势，一次触摸只对应一张卡：按下时认定当时的顶卡（touch = .dragging(serial)），
    // 之后的移动、松手都只作用在这张卡上；松手甩走后顶卡换了，也不会把同一次触摸再交给下一张卡。
    // （之前每张卡各挂一个手势，叠在一起的几张卡会对同一次触摸各自收到 changed / ended，
    //  顶卡甩走、下一张变成顶卡后紧接着收到同一次触摸的最后一帧和松手，于是一次滑动连甩好几张。）

    private enum Touch {
        case idle
        case dragging(serial: Int, start: CGPoint)
        /// 这次触摸没按在顶卡上（比如按在底部露出的叠层、或者顶卡正在飞走），整次忽略
        case ignored(start: CGPoint)
    }
    @ObservationIgnored private var touch: Touch = .idle

    func dragChanged(_ v: DragGesture.Value) {
        switch touch {
        case let .dragging(serial, start) where start == v.startLocation:
            move(serial, v)
            return
        case let .ignored(start) where start == v.startLocation:
            return
        case let .dragging(serial, _):
            // 上一次触摸没收到松手（手势被系统取消）：先让那张卡按零速度松手，再开始这一次
            if let c = cards[serial], c.drag != nil {
                c.drag = nil
                release(serial, c, vx: 0, vy: 0)
            }
        default:
            break
        }
        // 新的一次按下：只认当前顶卡，而且要按在卡片上
        let serial = top
        let c = card(serial)
        let r = slotFrame.offsetBy(dx: c.x.value, dy: c.y.value)
        guard !c.gone, r.contains(v.startLocation) else {
            touch = .ignored(start: v.startLocation)
            return
        }
        // 按下：停在当前帧（回弹途中也能接住），按抓的位置决定倾斜方向
        c.x.stop()
        c.y.stop()
        lift.stop()
        c.grab.set(v.startLocation.y < r.midY ? 1 : -1)
        c.drag = .init(sx: v.startLocation.x, sy: v.startLocation.y, x0: c.x.value, y0: c.y.value, over: abs(c.x.value) > threshold)
        touch = .dragging(serial: serial, start: v.startLocation)
        move(serial, v)
    }

    private func move(_ serial: Int, _ v: DragGesture.Value) {
        guard let c = cards[serial], !c.gone, let d = c.drag else { return }
        c.x.set(d.x0 + Double(v.location.x - d.sx))
        c.y.set(d.y0 + Double(v.location.y - d.sy) * 0.7)
    }

    func dragEnded(_ v: DragGesture.Value) {
        let current = touch
        touch = .idle
        guard case let .dragging(serial, _) = current, let c = cards[serial], c.drag != nil else { return }
        c.drag = nil
        release(serial, c, vx: Double(v.velocity.width), vy: Double(v.velocity.height) * 0.7)
    }

    private func release(_ serial: Int, _ c: CardMotion, vx: Double, vy: Double) {
        let dx = c.x.value
        // 够远、或者甩得够快（且方向一致）就飞走
        let dir: Double = abs(vx) > 650 ? sign(vx) : abs(dx) > threshold ? sign(dx) : 0
        if dir != 0 && (sign(dx) == dir || abs(dx) < 8) {
            fling(serial, c, dir: dir, vx: vx, vy: vy)
        } else {
            c.x.animate(to: 0, returnSpring, velocity: vx)
            c.y.animate(to: 0, returnSpring, velocity: vy)
            // lift = min(1, |x| / 阈值) × 0.85，换算出它离手时的速度
            let liftV = abs(dx) < threshold ? 0.85 / threshold * vx * sign(dx) : 0
            lift.animate(to: 0, settleSpring, velocity: liftV)
        }
    }

    private func sign(_ v: Double) -> Double { v > 0 ? 1 : v < 0 ? -1 : 0 }

    /// 按钮：顶卡带着一点上扬甩出去
    func flingTop(_ dir: Double) {
        let c = card(top)
        guard c.drag == nil, !c.gone else { return }
        c.grab.set(1)
        fling(top, c, dir: dir, vx: 0, vy: -260)
    }

    private func fling(_ serial: Int, _ c: CardMotion, dir: Double, vx: Double, vy: Double) {
        let v = dir * max(abs(vx), 1100)
        c.gone = true
        swipe(dir: dir, vx: vx)
        if dir > 0 && wide, let to = dockTarget() {
            flyToDock(serial, c, to: to, vx: vx, vy: vy)
            return
        }
        c.x.animate(to: dir * (Double(width) * 1.15 + 120), flySpring, velocity: v, restDelta: 4) { [weak self] in
            self?.landed(serial)
        }
        c.y.animate(to: c.y.value + vy * 0.18, flySpring, velocity: vy)
    }

    /// 顶卡离场：牌堆前进一张
    private func swipe(dir: Double, vx: Double) {
        let next = top + 1
        flying.append(next - 1)
        top = next
        if dir > 0 {
            // 大屏：先在右栏顶部占一行，卡片飞到这一行的缩略图位置后才算落位；手机没有右栏，直接算落位
            liked.insert(Liked(serial: next - 1, arrived: !wide), at: 0)
            if wide { scrollToken += 1 }
        }
        // 把拖动时已经升起的量并进 pos，再弹到下一张，画面连续
        pos.set(pos.value + lift.value)
        lift.set(0)
        pos.animate(to: Double(next), settleSpring)
        dragX.animate(to: 0, settleSpring, velocity: vx)
        Haptics.pop(haptics)
        onSwipe?(place(next - 1).title, dir > 0)
    }

    private func landed(_ serial: Int) {
        flying.removeAll { $0 == serial }
        if let i = liked.firstIndex(where: { $0.serial == serial && !$0.arrived }) {
            liked[i].arrived = true
        }
        cards[serial] = nil
    }

    /// 大屏右栏顶部那一行缩略图的位置，换算成卡片要走的位移和缩放
    private func dockTarget() -> (x: Double, y: Double, s: Double)? {
        let r = slotFrame
        guard r.width > 0, r.height > 0, listFrame.width > 0 else { return nil }
        // 新行插在列表最上面：缩略图在列表左上角往里（列表内边距 + 行内边距 10 / 6）
        let t = CGRect(x: listFrame.minX + listPad + 10, y: listFrame.minY + 6, width: 45, height: 60)
        // 按面积缩到和缩略图差不多大（卡片比缩略图细长，落位时缩略图弹一下盖过差别）
        let s = sqrt((t.width * t.height) / (r.width * r.height))
        // 卡片的缩放锚点是 50% 60%，缩放后卡片中心会往上偏 0.1 个卡高
        let ox = r.midX
        let oy = r.minY + r.height * 0.6
        return (Double(t.midX - ox), Double(t.midY - oy + r.height * 0.1 * s), Double(s))
    }

    /**
     大屏喜欢：同一条离场弹簧，终点换成右栏顶部那一行的缩略图——边飞边缩小、倾斜回正。
     网站版用 0→1 的进度 px（横向、缩放、回正）和 py（纵向）驱动；这里把同一个进度速度分别乘到每个量的行程上，
     弹簧是线性的，所以和用进度驱动完全等价。
     */
    private func flyToDock(_ serial: Int, _ c: CardMotion, to: (x: Double, y: Double, s: Double), vx: Double, vy: Double) {
        let from = (x: c.x.value, y: c.y.value, g: c.grab.value, s: c.scale.value)
        // 离手速度换算成进度速度（pt/s ÷ 要走的距离）；按钮触发时没有速度，按最低 1100 起步，和手机一样有劲
        func rate(_ v: Double, _ d: Double) -> Double { abs(d) > 1 ? max(-6, min(6, v / d)) : 0 }
        let vpx = max(0, rate(max(abs(vx), 1100), to.x - from.x))
        let vpy = rate(vy, to.y - from.y)
        c.x.animate(to: to.x, flySpring, velocity: vpx * (to.x - from.x), restDelta: max(0.1, abs(to.x - from.x) * 0.004)) { [weak self] in
            self?.landed(serial)
        }
        c.scale.animate(to: to.s, flySpring, velocity: vpx * (to.s - from.s))
        c.grab.animate(to: 0, flySpring, velocity: vpx * (0 - from.g))
        c.y.animate(to: to.y, flySpring, velocity: vpy * (to.y - from.y))
    }
}

// MARK: - 布局

private struct DeckContent: View {
    let size: CGSize
    let model: DeckModel
    let threshold: Double
    let rotation: Double
    let layers: Int
    let stamps: Bool
    let haptics: Bool
    let onSwipe: ((String, Bool) -> Void)?
    let pal: Palette

    private var end: DeckEnd { size.width >= 900 ? .desktop : size.width >= 600 ? .ipad : .phone }
    private var wide: Bool { end != .phone }
    /// 矮容器（卡片尺寸）：卡面文字、印章、按钮都收小一号
    private var compact: Bool { size.height <= 486 }
    /// 牌堆底部露出叠层的高度
    private var peek: CGFloat { CGFloat(layers) * layerY + 6 }
    private var listPad: CGFloat { end == .desktop ? 10 : 8 }

    var body: some View {
        let _ = model.configure(threshold: threshold, haptics: haptics, wide: wide, width: size.width, peek: peek, listPad: listPad, onSwipe: onSwipe)
        // 原生端不画网页演示里的手机外壳（假状态栏、「发现」标题行和计数）：系统状态栏和宿主的导航栏已经有了，
        // 组件只剩牌堆 + 跳过 / 喜欢按钮，大屏再加「已喜欢」一栏；甩走的结果通过 onSwipe 交给宿主
        VStack(spacing: 0) {
            if wide { wideBody } else { phoneBody }
        }
        .padding(rootPadding)
        .frame(width: size.width, height: size.height)
        .foregroundStyle(pal.fg)
        // 不铺底色：背景跟随宿主 App
        .clipped()
        .coordinateSpace(.named(deckSpace))
    }

    /// 去掉标题行后重新分配的留白：上方留一点给牌堆抬起时的阴影，下方给按钮留出手指的位置
    private var rootPadding: EdgeInsets {
        if size.height <= 460 { return EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16) }
        switch end {
        case .phone: return EdgeInsets(top: 16, leading: 20, bottom: 24, trailing: 20)
        case .ipad: return EdgeInsets(top: 24, leading: 20, bottom: 24, trailing: 20)
        case .desktop: return EdgeInsets(top: 32, leading: 28, bottom: 32, trailing: 28)
        }
    }

    // 手机：牌堆铺满屏宽（最宽 380），跳过 / 喜欢按钮在牌堆下方
    @ViewBuilder private var phoneBody: some View {
        deckStack
            .frame(maxWidth: 380, maxHeight: .infinity)
        HStack(spacing: compact ? 20 : 28) {
            actionButton(like: false, size: compact ? 46 : 60)
            actionButton(like: true, size: compact ? 46 : 60)
        }
        .padding(.top, compact ? 8 : 16)
    }

    // iPad / 桌面：「牌堆区 + 右栏」两列
    private var wideBody: some View {
        HStack(spacing: end == .desktop ? 28 : 20) {
            GeometryReader { g in mainGrid(g.size) }
                .zIndex(2) // 飞向右栏的卡片从右栏上面经过
            likedPanel
                .frame(width: min(280, max(200, (size.width - rootPadding.leading - rootPadding.trailing) * 0.28)))
                .frame(maxHeight: .infinity)
        }
        .frame(maxHeight: .infinity)
    }

    /// 牌堆区：跳过在左、喜欢在右，和牌堆垂直居中；牌堆保持手机上的卡片比例（含叠层约 350 × 646）
    private func mainGrid(_ ms: CGSize) -> some View {
        // 窄 iPad（牌堆区不到 440）：按钮小一号、间距收紧，把宽度让给卡片
        let narrow = ms.width <= 440
        let gap: CGFloat = narrow ? 10 : (end == .desktop ? 28 : 16)
        let btn: CGFloat = narrow ? 52 : (compact ? 46 : 60)
        let maxW: CGFloat = (end == .desktop && !narrow) ? 400 : 380
        let side: CGFloat = narrow ? 124 : (end == .desktop ? 176 : 152)
        let w = max(0, min(maxW, ms.width - side, ms.height * 350 / 646))
        return HStack(spacing: gap) {
            // 牌堆底部有露出叠层的一条，按钮往上让出一半，和卡片本身垂直居中
            actionButton(like: false, size: btn).padding(.bottom, peek)
            deckStack.frame(width: w, height: w * 646 / 350)
            actionButton(like: true, size: btn).padding(.bottom, peek)
        }
        .frame(width: ms.width, height: ms.height)
    }

    private var deckStack: some View {
        GeometryReader { g in
            let slot = CGSize(width: g.size.width, height: max(0, g.size.height - peek))
            let serials = model.flying + Array(model.top...(model.top + layers))
            ZStack(alignment: .top) {
                ForEach(serials, id: \.self) { serial in
                    CardView(
                        serial: serial,
                        isTop: serial == model.top,
                        layers: layers,
                        model: model,
                        motion: model.card(serial),
                        slot: slot,
                        threshold: threshold,
                        rotation: rotation,
                        stamps: stamps,
                        compact: compact,
                        pal: pal
                    )
                    .zIndex(Double(-serial))
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .top)
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(deckSpace)) } action: { model.stackFrame = $0 }
        // 整个牌堆只挂一个拖动手势（一次触摸只驱动按下时的那张顶卡），见 DeckModel.dragChanged
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .named(deckSpace))
                .onChanged { model.dragChanged($0) }
                .onEnded { model.dragEnded($0) }
        )
    }

    private func actionButton(like: Bool, size: CGFloat) -> some View {
        ActionButton(like: like, size: size, dragX: model.dragX, threshold: threshold, pal: pal) {
            model.flingTop(like ? 1 : -1)
        }
    }

    private var likedPanel: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("已喜欢").font(.system(size: 15, weight: .semibold))
                Spacer(minLength: 0)
                Text("\(model.liked.count)")
                    .font(.system(size: 13, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(pal.muted)
            }
            .padding(end == .desktop ? EdgeInsets(top: 18, leading: 20, bottom: 10, trailing: 20)
                     : EdgeInsets(top: 16, leading: 18, bottom: 8, trailing: 18))

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        Color.clear.frame(height: 0).id("sd-top")
                        if model.liked.isEmpty {
                            Text("右滑喜欢，卡片会收在这里")
                                .font(.system(size: 13))
                                .foregroundStyle(pal.muted)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(model.liked) { item in
                            LikedRow(item: item, pal: pal)
                        }
                    }
                    .padding(.horizontal, listPad)
                    .padding(.bottom, listPad)
                }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(deckSpace)) } action: { model.listFrame = $0 }
                .onChange(of: model.scrollToken) {
                    withAnimation(.motionSpring(stiffness: 420, damping: 34)) { proxy.scrollTo("sd-top", anchor: .top) }
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 22).fill(pal.btn))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(pal.btnLine, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }
}

// MARK: - 卡片

private struct CardView: View {
    let serial: Int
    let isTop: Bool
    let layers: Int
    let model: DeckModel
    let motion: CardMotion
    let slot: CGSize
    let threshold: Double
    let rotation: Double
    let stamps: Bool
    let compact: Bool
    let pal: Palette

    var body: some View {
        // 在牌堆里的相对层级：0 是顶卡，负数是已经飞走的
        let rel = Double(serial) - model.pos.value - model.lift.value
        let poseY = max(0, rel) * layerY
        let poseScale = 1 - max(0, rel) * layerScale
        let poseOpacity = min(1, max(0, Double(layers) - rel))
        let x = motion.x.value
        let y = motion.y.value
        // 抓在上半部分往右拖是顺时针，抓在下半部分是逆时针，像真的捏着一张卡
        let angle = x / threshold * rotation * motion.grab.value

        CardFace(index: serial, compact: compact)
            .equatable()
            .overlay(alignment: .top) { if stamps { stampLayer(x) } }
            .clipShape(RoundedRectangle(cornerRadius: 26))
            .overlay {
                if pal.dark { RoundedRectangle(cornerRadius: 26).stroke(Color.white.opacity(0.06), lineWidth: 1) }
            }
            .background {
                RoundedRectangle(cornerRadius: 26)
                    .fill(pal.bg)
                    .shadow(color: .black.opacity(pal.dark ? 0 : 0.08), radius: 1, y: 1)
                    .shadow(color: .black.opacity(pal.dark ? 0.55 : 0.22), radius: 12, y: 14)
            }
            .scaleEffect(motion.scale.value, anchor: UnitPoint(x: 0.5, y: 0.6))
            .rotationEffect(.degrees(angle), anchor: UnitPoint(x: 0.5, y: 0.6))
            .offset(x: x, y: y)
            .frame(width: slot.width, height: slot.height)
            // 卡片自己不接触摸，拖动由牌堆上唯一的手势驱动
            .allowsHitTesting(false)
            // 叠放姿态：以卡槽底边为锚点缩小、下移
            .scaleEffect(poseScale, anchor: .bottom)
            .offset(y: poseY)
            .opacity(poseOpacity)
            .accessibilityHidden(!isTop)
    }

    private func stampLayer(_ x: Double) -> some View {
        let likeO = ramp(x, threshold * 0.2, threshold)
        let nopeO = ramp(-x, threshold * 0.2, threshold)
        let inset: CGFloat = compact ? 14 : 22
        return HStack(alignment: .top) {
            Stamp(text: "喜欢", color: Color(hex: "#1FBF6B"), compact: compact)
                .scaleEffect(0.8 + 0.2 * likeO)
                .rotationEffect(.degrees(-12))
                .opacity(likeO)
            Spacer(minLength: 0)
            Stamp(text: "跳过", color: Color(hex: "#FF3B5C"), compact: compact)
                .scaleEffect(0.8 + 0.2 * nopeO)
                .rotationEffect(.degrees(12))
                .opacity(nopeO)
        }
        .padding(.horizontal, inset)
        .padding(.top, compact ? 14 : 26)
        .allowsHitTesting(false)
    }
}

private struct Stamp: View {
    let text: String
    let color: Color
    let compact: Bool

    var body: some View {
        let fs: CGFloat = compact ? 18 : 24
        Text(text)
            .font(.system(size: fs, weight: .heavy))
            .kerning(fs * 0.12)
            .foregroundStyle(color)
            .padding(.vertical, 3 + 3)
            .padding(.horizontal, 12 + 3)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.92)))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(color, lineWidth: 3))
    }
}

/// 卡面（风景 + 信息），只随卡号变化；拖动时不重画
private struct CardFace: View, Equatable {
    let index: Int
    let compact: Bool

    var body: some View {
        let p = place(index)
        ZStack(alignment: .bottomLeading) {
            SceneView(index: index).equatable()
            VStack(alignment: .leading, spacing: 4) {
                if !compact {
                    HStack(spacing: 6) {
                        Chip(text: "★ \(p.rating)")
                        Chip(text: p.dist)
                    }
                    .padding(.bottom, 6)
                }
                Text(p.title)
                    .font(.system(size: compact ? 22 : 30, weight: .bold))
                    .kerning(compact ? -0.22 : -0.3)
                    .shadow(color: .black.opacity(0.18), radius: 6, y: 1)
                Text(p.sub)
                    .font(.system(size: compact ? 13 : 15))
                    .opacity(0.88)
                    .shadow(color: .black.opacity(0.18), radius: 6, y: 1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, compact ? 16 : 22)
            .padding(.bottom, compact ? 14 : 22)
        }
    }
}

private struct Chip: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .monospacedDigit()
            .padding(.vertical, 3)
            .padding(.horizontal, 9)
            .background(Capsule().fill(Color.white.opacity(0.22)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.25), lineWidth: 1))
    }
}

/// 风景插画：网站版 SVG（viewBox 300 × 400，xMidYMid slice）用 Canvas 原样画出来
private struct SceneView: View, Equatable {
    let index: Int

    var body: some View {
        Canvas { ctx, size in
            let p = place(index)
            let k = max(size.width / 300, size.height / 400)
            ctx.translateBy(x: (size.width - 300 * k) / 2, y: (size.height - 400 * k) / 2)
            ctx.scaleBy(x: k, y: k)
            let full = Path(CGRect(x: 0, y: 0, width: 300, height: 400))

            // 天空：SVG 的 x1=0 y1=0 x2=0.4 y2=1 是按外框比例的渐变，换算成画布坐标里的起止点（等值线保持一致）
            let (gx, gy) = (0.4, 1.0)
            let lambda = (gx * gx + gy * gy) / (gx * gx / 90000 + gy * gy / 160000)
            ctx.fill(full, with: .linearGradient(
                Gradient(colors: [Color(hex: p.a), Color(hex: p.b)]),
                startPoint: .zero,
                endPoint: CGPoint(x: lambda * gx / 300, y: lambda * gy / 400)
            ))
            // 太阳光晕 + 太阳
            let s = p.sun
            ctx.fill(Path(ellipseIn: CGRect(x: s.x - 90, y: s.y - 90, width: 180, height: 180)), with: .radialGradient(
                Gradient(stops: [
                    .init(color: .white.opacity(0.9), location: 0),
                    .init(color: .white.opacity(0.45), location: 0.35),
                    .init(color: .white.opacity(0), location: 1),
                ]),
                center: s, startRadius: 0, endRadius: 90
            ))
            ctx.fill(Path(ellipseIn: CGRect(x: s.x - 26, y: s.y - 26, width: 52, height: 52)), with: .color(.white.opacity(0.85)))

            // 三层山
            var h1 = Path()
            h1.move(to: CGPoint(x: 0, y: 250))
            for pt in [(48, 214), (96, 236), (150, 186), (208, 230), (254, 204), (300, 226), (300, 400), (0, 400)] {
                h1.addLine(to: CGPoint(x: pt.0, y: pt.1))
            }
            h1.closeSubpath()
            ctx.fill(h1, with: .color(Color(hex: p.hills.0).opacity(0.55)))

            var h2 = Path()
            h2.move(to: CGPoint(x: 0, y: 292))
            h2.addQuadCurve(to: CGPoint(x: 120, y: 280), control: CGPoint(x: 60, y: 256))
            h2.addQuadCurve(to: CGPoint(x: 240, y: 270), control: CGPoint(x: 180, y: 304))
            h2.addQuadCurve(to: CGPoint(x: 300, y: 262), control: CGPoint(x: 300, y: 236))
            h2.addLine(to: CGPoint(x: 300, y: 400))
            h2.addLine(to: CGPoint(x: 0, y: 400))
            h2.closeSubpath()
            ctx.fill(h2, with: .color(Color(hex: p.hills.0).opacity(0.85)))

            var h3 = Path()
            h3.move(to: CGPoint(x: 0, y: 330))
            h3.addQuadCurve(to: CGPoint(x: 160, y: 322), control: CGPoint(x: 80, y: 300))
            h3.addQuadCurve(to: CGPoint(x: 300, y: 310), control: CGPoint(x: 240, y: 344))
            h3.addLine(to: CGPoint(x: 300, y: 400))
            h3.addLine(to: CGPoint(x: 0, y: 400))
            h3.closeSubpath()
            ctx.fill(h3, with: .color(Color(hex: p.hills.1)))

            // 底部压暗，托住白字
            ctx.fill(full, with: .linearGradient(
                Gradient(stops: [
                    .init(color: .black.opacity(0), location: 0.5),
                    .init(color: .black.opacity(0.42), location: 1),
                ]),
                startPoint: .zero, endPoint: CGPoint(x: 0, y: 400)
            ))
        }
    }
}

// MARK: - 按钮、右栏

private struct ActionButton: View {
    let like: Bool
    let size: CGFloat
    let dragX: MotionValue
    let threshold: Double
    let pal: Palette
    let action: () -> Void

    var body: some View {
        let x = dragX.value
        // 拖向哪边，哪个按钮跟着放大、填色
        let scale = 1 + 0.14 * (like ? ramp(x, 0, threshold) : ramp(-x, 0, threshold))
        let fill = like ? ramp(x, threshold * 0.2, threshold) : ramp(-x, threshold * 0.2, threshold)
        let tint = like ? pal.like : pal.nope
        Button(action: action) {
            ZStack {
                icon(tint)
                ZStack {
                    Circle().fill(tint)
                    icon(like ? .white : pal.bg)
                }
                .opacity(fill)
            }
            .frame(width: size, height: size)
            .background {
                ZStack {
                    Circle()
                        .fill(pal.btn)
                        .shadow(color: .black.opacity(pal.dark ? 0 : 0.06), radius: 1, y: 1)
                        .shadow(color: .black.opacity(pal.dark ? 0.4 : 0.08), radius: 10, y: 8)
                    Circle().strokeBorder(pal.btnLine, lineWidth: 1)
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .scaleEffect(scale)
        .accessibilityLabel(like ? "喜欢" : "跳过")
    }

    @ViewBuilder private func icon(_ color: Color) -> some View {
        if like {
            HeartShape().fill(color).frame(width: 24, height: 24)
        } else {
            CrossShape()
                .stroke(color, style: StrokeStyle(lineWidth: 2.4 * 22 / 24, lineCap: .round))
                .frame(width: 22, height: 22)
        }
    }
}

/// 按下缩到 0.9（对应 whileTap + { stiffness: 600, damping: 30 }）
private struct PressScaleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .animation(.motionSpring(stiffness: 600, damping: 30), value: configuration.isPressed)
    }
}

/// 右栏的一行：新喜欢的一行先撑开高度占位，卡片落进来时缩略图轻轻弹一下
private struct LikedRow: View {
    let item: Liked
    let pal: Palette
    // 挂上时还没落位的是「新飞来的」：要撑开、要弹；手机端喜欢的、切到大屏时已经在的，直接显示
    @State private var fresh: Bool
    @State private var open: Bool

    init(item: Liked, pal: Palette) {
        self.item = item
        self.pal = pal
        _fresh = State(initialValue: !item.arrived)
        _open = State(initialValue: item.arrived)
    }

    var body: some View {
        let p = place(item.serial)
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(pal.bg)
                if item.arrived {
                    PopIn(fresh: fresh) { SceneView(index: item.serial).equatable() }
                }
            }
            .frame(width: 45, height: 60)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(p.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text(p.sub).font(.system(size: 12)).foregroundStyle(pal.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .fixedSize(horizontal: false, vertical: true)
        .frame(height: open ? 72 : 0, alignment: .top)
        .clipped()
        .opacity(open ? 1 : 0)
        .onAppear {
            guard !open else { return }
            withAnimation(.motionSpring(stiffness: 420, damping: 34)) { open = true }
        }
    }
}

/// 缩略图落位：0.88 → 1，弹簧 520 / 18
private struct PopIn<Content: View>: View {
    @State private var scale: CGFloat
    let content: Content

    init(fresh: Bool, @ViewBuilder content: () -> Content) {
        _scale = State(initialValue: fresh ? 0.88 : 1)
        self.content = content()
    }

    var body: some View {
        content
            .scaleEffect(scale)
            .onAppear {
                guard scale != 1 else { return }
                withAnimation(.motionSpring(stiffness: 520, damping: 18)) { scale = 1 }
            }
    }
}

// MARK: - 图标

/// SVG 圆弧（A r r 0 0 1 x y）：只处理本文件用到的情形——小弧、sweep = 1（屏幕坐标里顺时针），拆成两段三次贝塞尔
private func addArc(_ p: inout Path, to b: CGPoint, radius r: CGFloat) {
    guard let a = p.currentPoint else { return }
    let dx = b.x - a.x, dy = b.y - a.y
    let len = sqrt(dx * dx + dy * dy)
    guard len > 0 else { return }
    let ux = dx / len, uy = dy / len
    let h = sqrt(max(0, r * r - len * len / 4))
    let c = CGPoint(x: (a.x + b.x) / 2 - uy * h, y: (a.y + b.y) / 2 + ux * h)
    let a0 = atan2(a.y - c.y, a.x - c.x)
    var a1 = atan2(b.y - c.y, b.x - c.x)
    if a1 < a0 { a1 += 2 * .pi }
    let n = 2
    let step = (a1 - a0) / CGFloat(n)
    let k = 4 / 3 * tan(step / 4)
    for i in 0..<n {
        let s0 = a0 + step * CGFloat(i), s1 = s0 + step
        let p1 = CGPoint(x: c.x + r * cos(s1), y: c.y + r * sin(s1))
        let p0 = CGPoint(x: c.x + r * cos(s0), y: c.y + r * sin(s0))
        p.addCurve(
            to: p1,
            control1: CGPoint(x: p0.x - k * r * sin(s0), y: p0.y + k * r * cos(s0)),
            control2: CGPoint(x: p1.x + k * r * sin(s1), y: p1.y - k * r * cos(s1))
        )
    }
}

/// 心形（网站版 24 × 24 的 SVG 路径）
private struct HeartShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 12, y: 20.5))
        p.addCurve(to: CGPoint(x: 4.5, y: 10.3), control1: CGPoint(x: 12, y: 20.5), control2: CGPoint(x: 4.5, y: 15.9))
        addArc(&p, to: CGPoint(x: 12, y: 7.6), radius: 4.3)
        addArc(&p, to: CGPoint(x: 19.5, y: 10.3), radius: 4.3)
        p.addCurve(to: CGPoint(x: 12, y: 20.5), control1: CGPoint(x: 19.5, y: 15.9), control2: CGPoint(x: 12, y: 20.5))
        p.closeSubpath()
        let k = min(rect.width, rect.height) / 24
        return p.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: k, y: k))
    }
}

/// 叉号（网站版 24 × 24：M6.5 6.5l11 11M17.5 6.5l-11 11）
private struct CrossShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 6.5, y: 6.5))
        p.addLine(to: CGPoint(x: 17.5, y: 17.5))
        p.move(to: CGPoint(x: 17.5, y: 6.5))
        p.addLine(to: CGPoint(x: 6.5, y: 17.5))
        let k = min(rect.width, rect.height) / 24
        return p.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: k, y: k))
    }
}

/// 预览：模拟宿主页面——标题和喜欢计数放在导航栏里，由 onSwipe 更新
private struct SwipeDeckPreviewHost: View {
    @State private var likes = 0

    var body: some View {
        NavigationStack {
            SwipeDeck { _, liked in
                if liked { likes += 1 }
            }
            .navigationTitle("发现")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Label("\(likes)", systemImage: "heart.fill").labelStyle(.titleAndIcon)
                }
            }
        }
    }
}

#Preview("手机") {
    SwipeDeckPreviewHost()
}

#Preview("iPad", traits: .fixedLayout(width: 820, height: 1000)) {
    SwipeDeckPreviewHost()
}

#Preview("桌面宽度", traits: .fixedLayout(width: 1100, height: 760)) {
    SwipeDeck()
}
