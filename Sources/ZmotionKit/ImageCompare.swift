// 前后对比（Before / after slider）：分割线带一点柔和的弹簧跟手，拖过边缘会像橡皮筋一样拉不动、松手弹回；
// 点画面任意位置就滑过去，标签靠近边缘时自动淡出。进场时轻轻晃一下，提示可以拖。
//
// 内容：宿主可以传自己的前 / 后两张图（Image，或任意 View），默认是网站版那张手绘的湖边日落：
// 「修图后」是原色，「修图前」是同一张画按 CSS filter: saturate(.12) contrast(.78) brightness(1.06) 逐色换算后的灰调版本 + 一层灰雾。
// 画面固定 16:10（可改 aspectRatio），在宿主给的空间里等比放到最大（最宽 960）；网页演示四周的留白不画，由宿主排版。
//
// 动画：target 是手指 / 进场晃动直接写的目标值，pos = useSpring(target, { stiffness: 420, damping: 34, mass: 0.6 })。
// 每次目标改变都从当前值、带着当前速度重新起弹簧，所以用 CADisplayLink 逐帧求解（SwiftUI 的 Spring，和 motion 同一物理模型）。
// 把手按下放大是 { duration: 0.25, ease: [0.28, 1.3, 0.36, 1] }。
import SwiftUI
import UIKit
import Observation

public struct ImageCompare: View {
    public enum Orientation: String, CaseIterable, Sendable {
        /// 左右
        case horizontal
        /// 上下
        case vertical
    }

    public enum Handle: String, CaseIterable, Sendable {
        /// 圆形
        case circle
        /// 胶囊
        case bar
        /// 细线
        case line
    }

    let start: Double
    let orientation: Orientation
    let handle: Handle
    let showLabels: Bool
    let before: AnyView?
    let after: AnyView?
    let beforeLabel: String
    let afterLabel: String
    let aspectRatio: Double
    let haptics: Bool
    let onChange: ((Double) -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @State private var model: ICModel
    @State private var active = false
    @GestureState private var touching = false

    /// - Parameters:
    ///   - start: 起始位置：分割线一开始停在哪里（0–100，%）
    ///   - orientation: 方向：左右拖动还是上下拖动
    ///   - handle: 把手样式：分割线中间把手的样子
    ///   - showLabels: 显示标签：是否显示「修图前 / 修图后」标签
    ///   - before: 修图前的图；不传用内置插画的灰调版本
    ///   - after: 修图后的图；不传用内置插画
    ///   - beforeLabel / afterLabel: 两个标签的文案
    ///   - aspectRatio: 画面宽高比（默认 16:10）；图片按 fill 裁切铺满
    ///   - haptics: 触感反馈（按下轻触一下、拖到边缘再轻触一下；网站版的音效在原生端换成触感）
    ///   - onChange: 松手 / 读屏调整后回调最终位置（0–100，修图前占的百分比）
    public init(
        start: Double = 50,
        orientation: Orientation = .horizontal,
        handle: Handle = .circle,
        showLabels: Bool = true,
        before: Image? = nil,
        after: Image? = nil,
        beforeLabel: String = "修图前",
        afterLabel: String = "修图后",
        aspectRatio: Double = 1.6,
        haptics: Bool = true,
        onChange: ((Double) -> Void)? = nil
    ) {
        self.init(
            start: start, orientation: orientation, handle: handle, showLabels: showLabels,
            anyBefore: before.map { AnyView(ICPhoto(image: $0)) },
            anyAfter: after.map { AnyView(ICPhoto(image: $0)) },
            beforeLabel: beforeLabel, afterLabel: afterLabel, aspectRatio: aspectRatio,
            haptics: haptics, onChange: onChange
        )
    }

    /// 任意 View 作为前 / 后画面（比如 AsyncImage、视频帧、自己画的图）；画面会被裁切在对比框里
    public init<Before: View, After: View>(
        start: Double = 50,
        orientation: Orientation = .horizontal,
        handle: Handle = .circle,
        showLabels: Bool = true,
        beforeLabel: String = "修图前",
        afterLabel: String = "修图后",
        aspectRatio: Double = 1.6,
        haptics: Bool = true,
        onChange: ((Double) -> Void)? = nil,
        @ViewBuilder before: () -> Before,
        @ViewBuilder after: () -> After
    ) {
        self.init(
            start: start, orientation: orientation, handle: handle, showLabels: showLabels,
            anyBefore: AnyView(before()), anyAfter: AnyView(after()),
            beforeLabel: beforeLabel, afterLabel: afterLabel, aspectRatio: aspectRatio,
            haptics: haptics, onChange: onChange
        )
    }

    private init(
        start: Double, orientation: Orientation, handle: Handle, showLabels: Bool,
        anyBefore: AnyView?, anyAfter: AnyView?, beforeLabel: String, afterLabel: String,
        aspectRatio: Double, haptics: Bool, onChange: ((Double) -> Void)?
    ) {
        self.start = start
        self.orientation = orientation
        self.handle = handle
        self.showLabels = showLabels
        self.before = anyBefore
        self.after = anyAfter
        self.beforeLabel = beforeLabel
        self.afterLabel = afterLabel
        self.aspectRatio = aspectRatio > 0 ? aspectRatio : 1.6
        self.haptics = haptics
        self.onChange = onChange
        _model = State(initialValue: ICModel(start: icClamp(start)))
    }

    private var horizontal: Bool { orientation != .vertical }

    public var body: some View {
        GeometryReader { geo in
            frame(geo.size)
        }
        .aspectRatio(aspectRatio, contentMode: .fit)
        .frame(maxWidth: 960)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.intro() }
        .onDisappear { model.stopIntro() }
        .onChange(of: start) { _, s in model.jump(icClamp(s)) }
        .onChange(of: touching) { _, isTouching in
            // 手势被系统打断时 onEnded 不会触发，这里兜底（相当于 pointercancel）
            guard !isTouching else { return }
            DispatchQueue.main.async { if model.drag != nil { end() } }
        }
    }

    private func frame(_ size: CGSize) -> some View {
        let W = size.width
        let H = size.height
        let dark = colorScheme == .dark
        let pos = model.pos.value
        let shown = icClamp(pos) / 100
        // border-radius: clamp(12px, 3cqw, 22px)
        let corner = min(max(W * 0.03, 12), 22)
        let rr = RoundedRectangle(cornerRadius: corner, style: .continuous)

        return ZStack(alignment: .topLeading) {
            // 修图后：完整铺底
            Group {
                if let after { after } else { ICScene(graded: false).equatable() }
            }
            .frame(width: W, height: H)
            .clipped()

            // 修图前：只露出分割线前面那一段（网页是两层反向平移，这里直接裁切，效果相同）
            Group {
                if let before {
                    before
                } else {
                    ICScene(graded: true).equatable()
                        .overlay(LinearGradient(
                            colors: [Color.white.opacity(0.1), Color(.sRGB, red: 160 / 255, green: 160 / 255, blue: 160 / 255, opacity: 0.16)],
                            startPoint: .top, endPoint: .bottom
                        ))
                }
            }
            .frame(width: W, height: H)
            .clipped()
            .mask(alignment: .topLeading) {
                Rectangle().frame(width: horizontal ? W * shown : W, height: horizontal ? H : H * shown)
            }

            if showLabels { labels(W, H, pos) }

            divider(W, H, pos)
        }
        .frame(width: W, height: H)
        .clipShape(rr)
        // 细描边画在最上层，避免被图片盖住
        .overlay(rr.strokeBorder(dark ? Color.white.opacity(0.08) : Color.black.opacity(0.06), lineWidth: 1).allowsHitTesting(false))
        .background {
            ZStack {
                rr.fill(Color.black).shadow(color: .black.opacity(dark ? 0.3 : 0.06), radius: 1, x: 0, y: 1)
                rr.fill(Color.black).shadow(color: .black.opacity(dark ? 0.5 : 0.14), radius: 25, x: 0, y: 18)
            }
        }
        .contentShape(rr)
        .gesture(drag(W, H))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("拖动对比修图前后")
        .accessibilityValue("修图前占 \(Int(icClamp(model.target.value).rounded()))%")
        .accessibilityAdjustableAction { dir in
            switch dir {
            case .increment: nudge(5)
            case .decrement: nudge(-5)
            @unknown default: break
            }
        }
    }

    /* ---------- 标签 ---------- */

    private func labels(_ W: CGFloat, _ H: CGFloat, _ pos: Double) -> some View {
        // 靠近边缘时淡出：修图前在 6…24 之间淡入，修图后在 76…94 之间淡出
        let beforeOpacity = icRamp(pos, 6, 24)
        let afterOpacity = 1 - icRamp(pos, 76, 94)
        return ZStack(alignment: horizontal ? .topTrailing : .bottomLeading) {
            Color.clear
            ICChip(text: afterLabel, dark: colorScheme == .dark).opacity(afterOpacity)
        }
        .overlay(alignment: .topLeading) {
            ICChip(text: beforeLabel, dark: colorScheme == .dark).opacity(beforeOpacity)
        }
        .padding(14)
        .frame(width: W, height: H)
        .allowsHitTesting(false)
    }

    /* ---------- 分割线 + 把手 ---------- */

    private func divider(_ W: CGFloat, _ H: CGFloat, _ pos: Double) -> some View {
        let at = pos / 100 // 分割线跟着未截断的 pos 走，橡皮筋时会稍微出界
        let thin = handle == .line
        let lineW: CGFloat = thin ? 1.5 : 2
        return ZStack {
            Rectangle()
                .fill(Color.white)
                .frame(width: horizontal ? lineW : W, height: horizontal ? H : lineW)
                .shadow(color: .black.opacity(thin ? 0.2 : 0.25), radius: thin ? 3 : 5)
                .position(x: horizontal ? W * at : W / 2, y: horizontal ? H / 2 : H * at)
            ICHandle(style: handle, horizontal: horizontal)
                .scaleEffect(active ? 1.1 : 1)
                .animation(.timingCurve(0.28, 1.3, 0.36, 1, duration: 0.25), value: active)
                .position(x: horizontal ? W * at : W / 2, y: horizontal ? H / 2 : H * at)
        }
        .frame(width: W, height: H)
        .allowsHitTesting(false)
    }

    /* ---------- 拖动：按下就跳到手指处，拖出边界橡皮筋，松手弹回边界 ---------- */

    private func drag(_ W: CGFloat, _ H: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($touching) { _, state, _ in state = true }
            .onChanged { v in
                let pct = horizontal ? v.location.x / max(W, 1) * 100 : v.location.y / max(H, 1) * 100
                if model.drag == nil {
                    model.stopIntro()
                    model.drag = ICDrag(edge: icClamp(model.target.value).truncatingRemainder(dividingBy: 100) == 0)
                    active = true
                    Haptics.tap(haptics)
                }
                set(pct)
            }
            .onEnded { _ in end() }
    }

    private func set(_ raw: Double) {
        guard var d = model.drag else { return }
        model.setTarget(icRubber(raw))
        let atEdge = raw <= 0 || raw >= 100
        if atEdge && !d.edge { Haptics.tap(haptics) }
        d.edge = atEdge
        model.drag = d
    }

    private func end() {
        guard model.drag != nil else { return }
        model.drag = nil
        active = false
        // 松手：橡皮筋弹回边界
        let v = icClamp(model.target.value)
        model.setTarget(v)
        onChange?(v)
    }

    private func nudge(_ step: Double) {
        model.stopIntro()
        let v = icClamp(model.target.value + step)
        model.setTarget(v)
        Haptics.tap(haptics)
        onChange?(v)
    }
}

/* ---------- 小工具 ---------- */

private func icClamp(_ v: Double) -> Double { min(100, max(0, v)) }

private func icRamp(_ v: Double, _ a: Double, _ b: Double) -> Double { min(1, max(0, (v - a) / (b - a))) }

/// 拖出边界时的橡皮筋：越往外越拉不动，最多再走 4%
private func icRubber(_ v: Double) -> Double {
    let r = 4.0
    if v < 0 { return -r * (1 - exp(v / r / 2.5)) }
    if v > 100 { return 100 + r * (1 - exp(-(v - 100) / r / 2.5)) }
    return v
}

/// motion 的 easeInOut = cubic-bezier(0.42, 0, 0.58, 1)
private func icEaseInOut(_ p: Double) -> Double {
    if p <= 0 { return 0 }
    if p >= 1 { return 1 }
    let (x1, y1, x2, y2) = (0.42, 0.0, 0.58, 1.0)
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
    return ((ay * t + by) * t + cy) * t
}

private struct ICDrag {
    var edge: Bool
}

/// 宿主传进来的照片：铺满裁切（对应 SVG 的 preserveAspectRatio="xMidYMid slice"）
private struct ICPhoto: View {
    let image: Image
    var body: some View {
        Color.clear.overlay(image.resizable().scaledToFill()).clipped()
    }
}

/* ---------- 标签 / 把手 ---------- */

private struct ICChip: View {
    let text: String
    let dark: Bool
    var body: some View {
        Text(text)
            .font(.system(size: 12.5, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(.white)
            .padding(.vertical, 5)
            .padding(.horizontal, 11)
            .background(Capsule().fill(dark ? Color.black.opacity(0.62) : Color(.sRGB, red: 16 / 255, green: 16 / 255, blue: 20 / 255, opacity: 0.58)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
            .fixedSize()
    }
}

private struct ICHandle: View {
    let style: ImageCompare.Handle
    let horizontal: Bool

    var body: some View {
        switch style {
        case .circle:
            Circle()
                .fill(Color.white)
                .frame(width: 46, height: 46)
                .shadow(color: .black.opacity(0.18), radius: 3, x: 0, y: 2)
                .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 8)
                .overlay {
                    ICChevrons()
                        .frame(width: 22, height: 22)
                        .rotationEffect(.degrees(horizontal ? 0 : 90))
                }
        case .bar:
            Capsule()
                .fill(Color.white)
                .frame(width: horizontal ? 16 : 56, height: horizontal ? 56 : 16)
                .shadow(color: .black.opacity(0.18), radius: 3, x: 0, y: 2)
                .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 8)
                .overlay {
                    let grip = RoundedRectangle(cornerRadius: 1).fill(Color(hex: "#B5B5B5"))
                    if horizontal {
                        VStack(spacing: 3) { ForEach(0..<3, id: \.self) { _ in grip.frame(width: 6, height: 1.5) } }
                    } else {
                        HStack(spacing: 3) { ForEach(0..<3, id: \.self) { _ in grip.frame(width: 1.5, height: 6) } }
                    }
                }
        case .line:
            // box-shadow: 0 0 0 4px rgb(255 255 255 / .35), 0 2px 8px rgb(0 0 0 / .25)
            Circle()
                .fill(Color.white.opacity(0.35))
                .frame(width: 20, height: 20)
                .overlay(Circle().fill(Color.white).frame(width: 12, height: 12))
                .shadow(color: .black.opacity(0.25), radius: 4, x: 0, y: 2)
        }
    }
}

/// 圆形把手里的 ‹ ›：M9 7l-5 5 5 5 M15 7l5 5-5 5，线宽 2.2、圆头
private struct ICChevrons: View {
    var body: some View {
        Canvas { ctx, size in
            let k = size.width / 24
            func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * k, y: y * k) }
            var p = Path()
            p.move(to: pt(9, 7)); p.addLine(to: pt(4, 12)); p.addLine(to: pt(9, 17))
            p.move(to: pt(15, 7)); p.addLine(to: pt(20, 12)); p.addLine(to: pt(15, 17))
            ctx.stroke(p, with: .color(Color(hex: "#1A1A1A")), style: StrokeStyle(lineWidth: 2.2 * k, lineCap: .round, lineJoin: .round))
        }
    }
}

/* ---------- 内置插画：网站 SVG（800 × 500，xMidYMid slice）用 Canvas 原样画 ---------- */

/// graded = true 时每个颜色都按 CSS filter: saturate(0.12) contrast(0.78) brightness(1.06) 换算（这几个滤镜都是仿射变换，逐色换算和整图滤镜等价）
private struct ICScene: View, Equatable {
    let graded: Bool

    var body: some View {
        let g = graded
        Canvas { ctx, size in
            let k = max(size.width / 800, size.height / 500)
            ctx.translateBy(x: (size.width - 800 * k) / 2, y: (size.height - 500 * k) / 2)
            ctx.scaleBy(x: k, y: k)

            func c(_ hex: String, _ a: Double = 1) -> Color { icSceneColor(hex, a, graded: g) }
            func vertical(_ stops: [(String, Double)], _ y0: Double, _ y1: Double) -> GraphicsContext.Shading {
                .linearGradient(
                    Gradient(stops: stops.map { Gradient.Stop(color: c($0.0), location: $0.1) }),
                    startPoint: CGPoint(x: 0, y: y0), endPoint: CGPoint(x: 0, y: y1)
                )
            }

            // 天空
            ctx.fill(Path(CGRect(x: 0, y: 0, width: 800, height: 500)), with: vertical([("#24307e", 0), ("#8f4bb8", 0.38), ("#ef6f8a", 0.6), ("#ff9b5c", 0.78), ("#ffd27a", 1)], 0, 500))
            // 星星
            let stars: [(Double, Double)] = [(80, 40), (160, 90), (250, 30), (340, 70), (120, 140), (700, 50), (640, 110), (470, 40), (760, 120)]
            for (i, s) in stars.enumerated() {
                let r = i % 3 == 0 ? 1.8 : 1.2
                ctx.fill(Path(ellipseIn: CGRect(x: s.0 - r, y: s.1 - r, width: r * 2, height: r * 2)), with: .color(c("#ffffff", 0.7)))
            }
            // 太阳光晕 + 太阳
            ctx.fill(
                Path(ellipseIn: CGRect(x: 370, y: 110, width: 380, height: 380)),
                with: .radialGradient(
                    Gradient(stops: [
                        .init(color: c("#fff3c4", 0.95), location: 0),
                        .init(color: c("#ffc46b", 0.55), location: 0.3),
                        .init(color: c("#ff8a5b", 0), location: 1),
                    ]),
                    center: CGPoint(x: 560, y: 300), startRadius: 0, endRadius: 190
                )
            )
            ctx.fill(Path(ellipseIn: CGRect(x: 512, y: 252, width: 96, height: 96)), with: .color(c("#fff4cf")))
            // 云（整组 0.28 透明度，重叠处不叠深）
            var clouds = ctx
            clouds.opacity = 0.28
            clouds.drawLayer { l in
                for (cx, cy, rx, ry) in [(190.0, 190.0, 110.0, 14.0), (260, 176, 70, 11), (660, 200, 90, 10)] {
                    l.fill(Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2)), with: .color(c("#ffffff")))
                }
            }
            // 飞鸟
            var birds = Path()
            for (x, y, s) in [(300.0, 150.0, 9.0), (350, 128, 6), (268, 170, 5)] {
                birds.move(to: CGPoint(x: x, y: y))
                birds.addQuadCurve(to: CGPoint(x: x + 2 * s, y: y), control: CGPoint(x: x + s, y: y - s))
                birds.addQuadCurve(to: CGPoint(x: x + 4 * s, y: y), control: CGPoint(x: x + 3 * s, y: y - s))
            }
            ctx.stroke(birds, with: .color(c("#3a1f5c")), style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))

            // 远山、近山
            ctx.fill(icPolygon(icFarRidge, bottom: 340), with: vertical([("#b267c9", 0), ("#e88aa8", 1)], 186, 340))
            ctx.fill(icPolygon(icMidRidge, bottom: 362), with: vertical([("#5b2f91", 0), ("#8a4aa6", 1)], 276, 362))

            // 湖面 + 倒影
            ctx.fill(Path(CGRect(x: 0, y: 358, width: 800, height: 142)), with: vertical([("#ffb170", 0), ("#b3549e", 0.4), ("#22296b", 1)], 358, 500))
            for (x, y, w, h, a) in [(508.0, 366.0, 104.0, 4.0, 0.85), (522, 380, 76, 4, 0.7), (532, 396, 56, 3, 0.55), (540, 412, 40, 3, 0.4), (546, 428, 28, 2, 0.3)] {
                ctx.fill(Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: h / 2), with: .color(c("#ffe7a6", a)))
            }

            // 两侧山坡（渐变按各自外框：左 362.6…500，右 388…500）
            var left = Path()
            left.move(to: CGPoint(x: 0, y: 500)); left.addLine(to: CGPoint(x: 0, y: 372))
            left.addQuadCurve(to: CGPoint(x: 220, y: 392), control: CGPoint(x: 110, y: 346))
            left.addQuadCurve(to: CGPoint(x: 350, y: 500), control: CGPoint(x: 300, y: 428))
            left.closeSubpath()
            ctx.fill(left, with: vertical([("#1c6b5a", 0), ("#0b2f33", 1)], 362.6, 500))
            var right = Path()
            right.move(to: CGPoint(x: 800, y: 500)); right.addLine(to: CGPoint(x: 800, y: 392))
            right.addQuadCurve(to: CGPoint(x: 630, y: 424), control: CGPoint(x: 700, y: 376))
            right.addQuadCurve(to: CGPoint(x: 572, y: 500), control: CGPoint(x: 590, y: 456))
            right.closeSubpath()
            ctx.fill(right, with: vertical([("#1c6b5a", 0), ("#0b2f33", 1)], 388, 500))

            // 树
            var trees = Path()
            for (x, y, s) in icTrees {
                trees.move(to: CGPoint(x: x, y: y - 70 * s))
                trees.addLine(to: CGPoint(x: x + 18 * s, y: y))
                trees.addLine(to: CGPoint(x: x - 18 * s, y: y))
                trees.closeSubpath()
            }
            ctx.fill(trees, with: .color(c("#0a2a24")))
        }
        .allowsHitTesting(false)
    }
}

private let icFarRidge: [(Double, Double)] = [(0, 300), (70, 246), (140, 280), (230, 196), (320, 268), (410, 214), (500, 262), (600, 186), (700, 248), (800, 214)]
private let icMidRidge: [(Double, Double)] = [(0, 336), (70, 292), (150, 322), (230, 276), (320, 334), (400, 302), (480, 338), (570, 290), (660, 334), (740, 302), (800, 322)]
private let icTrees: [(Double, Double, Double)] = [(40, 360, 1), (78, 352, 1.3), (118, 366, 0.9), (160, 372, 1.15), (205, 388, 0.85), (728, 382, 1.2), (770, 376, 0.95)]

private func icPolygon(_ ridge: [(Double, Double)], bottom: Double) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: ridge[0].0, y: ridge[0].1))
    for pt in ridge.dropFirst() { p.addLine(to: CGPoint(x: pt.0, y: pt.1)) }
    p.addLine(to: CGPoint(x: 800, y: bottom))
    p.addLine(to: CGPoint(x: 0, y: bottom))
    p.closeSubpath()
    return p
}

/// 插画颜色；graded 时按 CSS 滤镜链 saturate(0.12) → contrast(0.78) → brightness(1.06) 换算（sRGB 空间，每步截断到 0…1）
private func icSceneColor(_ hex: String, _ alpha: Double, graded: Bool) -> Color {
    var s = hex
    if s.hasPrefix("#") { s.removeFirst() }
    var v: UInt64 = 0
    Scanner(string: s).scanHexInt64(&v)
    var r = Double((v >> 16) & 0xFF) / 255
    var g = Double((v >> 8) & 0xFF) / 255
    var b = Double(v & 0xFF) / 255
    if graded {
        let k = 0.12
        let r1 = (0.213 + 0.787 * k) * r + (0.715 - 0.715 * k) * g + (0.072 - 0.072 * k) * b
        let g1 = (0.213 - 0.213 * k) * r + (0.715 + 0.285 * k) * g + (0.072 - 0.072 * k) * b
        let b1 = (0.213 - 0.213 * k) * r + (0.715 - 0.715 * k) * g + (0.072 + 0.928 * k) * b
        func step(_ x: Double) -> Double {
            let c = min(1, max(0, (min(1, max(0, x)) - 0.5) * 0.78 + 0.5))
            return min(1, max(0, c * 1.06))
        }
        (r, g, b) = (step(r1), step(g1), step(b1))
    }
    return Color(.sRGB, red: r, green: g, blue: b, opacity: alpha)
}

/* ---------- 状态 + 逐帧弹簧 ---------- */

@MainActor
@Observable
private final class ICModel {
    /// pos 跟随 target 的弹簧：{ stiffness: 420, damping: 34, mass: 0.6 }（阻尼比 ≈ 1.07，略过阻尼）
    static let spring = Spring(mass: 0.6, stiffness: 420, damping: 34, allowOverDamping: true)

    /// 目标值（手指 / 进场晃动直接写）
    let target: ICValue
    /// 显示用的位置（target 的弹簧）
    let pos: ICValue
    @ObservationIgnored var drag: ICDrag?
    @ObservationIgnored private var introStart: CFTimeInterval?
    @ObservationIgnored private var introKeys: [Double] = []
    @ObservationIgnored private var didIntro = false

    init(start: Double) {
        target = ICValue(start)
        pos = ICValue(start)
    }

    func setTarget(_ v: Double) {
        target.value = v
        pos.follow(v, Self.spring)
    }

    /// 外部改了 start：停掉晃动，目标直接设过去（pos 弹簧过去）
    func jump(_ v: Double) {
        stopIntro()
        setTarget(v)
    }

    /// 进场时轻轻晃一下，提示可以拖：[s, s+8a, s−4a, s]，1.4s，延迟 0.6s，easeInOut，times [0, .38, .72, 1]
    func intro() {
        guard !didIntro else { return }
        didIntro = true
        let s = icClamp(target.value)
        let a: Double = s > 85 ? -1 : 1
        introKeys = [s, icClamp(s + 8 * a), icClamp(s - 4 * a), s]
        introStart = CACurrentMediaTime() + 0.6
        ICTicker.shared.addFrame(self) { [weak self] now in self?.introFrame(now) ?? false }
    }

    func stopIntro() {
        introStart = nil
        ICTicker.shared.removeFrame(self)
    }

    /// 返回 true 表示还没播完
    private func introFrame(_ now: CFTimeInterval) -> Bool {
        guard let t0 = introStart else { return false }
        let t = (now - t0) / 1.4
        if t < 0 { return true }
        let times = [0, 0.38, 0.72, 1.0]
        if t >= 1 {
            setTarget(introKeys[3])
            introStart = nil
            return false
        }
        var i = 0
        while i < 2 && t > times[i + 1] { i += 1 }
        let local = (t - times[i]) / (times[i + 1] - times[i])
        setTarget(introKeys[i] + (introKeys[i + 1] - introKeys[i]) * icEaseInOut(local))
        return true
    }
}

/// 一个跟随目标的弹簧值：目标一变，就从当前值、带着当前速度向新目标起一段新弹簧（= motion 的 useSpring）
@MainActor
@Observable
private final class ICValue {
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
        ICTicker.shared.add(self)
    }

    /// 走一帧；返回 false 表示停稳了
    func step(_ now: CFTimeInterval) -> Bool {
        guard let r = run else { return false }
        let (p, v) = sample(r, now)
        // motion 的默认收尾阈值：变化量很小（< 5）时用更细的阈值
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
private final class ICTicker: NSObject {
    static let shared = ICTicker()
    private var link: CADisplayLink?
    private var items: [ObjectIdentifier: ICValue] = [:]
    /// 进场晃动这类按时间轴写目标值的动画（每个组件一条）；返回 false 表示播完
    private var frames: [ObjectIdentifier: (CFTimeInterval) -> Bool] = [:]

    func addFrame(_ owner: AnyObject, _ f: @escaping (CFTimeInterval) -> Bool) {
        frames[ObjectIdentifier(owner)] = f
        start()
    }

    func removeFrame(_ owner: AnyObject) { frames[ObjectIdentifier(owner)] = nil }

    func add(_ v: ICValue) {
        items[ObjectIdentifier(v)] = v
        start()
    }

    private func start() {
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick(_ l: CADisplayLink) {
        let now = CACurrentMediaTime()
        for (id, f) in frames where !f(now) {
            frames[id] = nil
        }
        for (id, v) in items where !v.step(now) {
            items[id] = nil
        }
        if items.isEmpty && frames.isEmpty {
            link?.invalidate()
            link = nil
        }
    }
}

#Preview("手机 · 默认") {
    ImageCompare()
        .padding(24)
}

#Preview("上下 · 胶囊 · 深色") {
    ImageCompare(start: 40, orientation: .vertical, handle: .bar)
        .padding(24)
        .background(Color.black)
        .preferredColorScheme(.dark)
}

#Preview("极简") {
    ImageCompare(start: 30, handle: .line, showLabels: false)
        .padding(24)
}

#Preview("iPad 宽度", traits: .fixedLayout(width: 1024, height: 768)) {
    ImageCompare()
        .padding(48)
}
