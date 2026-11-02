// 底部标签栏（Tab bar）：点一下标签，指示器沿着标签栏弹性滑过去；图标按下时一缩、松手后带着初速度往上一跳；
// 连点、来回点都能随时接住。指示器有胶囊 / 下划线 / 圆点三种，切换样式时也平滑过渡；未读角标弹出、收起。
//
// 多端（按组件自己的宽度，和网页断点一致）：< 600 手机底部悬浮栏；600–899 iPad 底部居中的悬浮栏（图标和文字横排）；
// ≥ 900 桌面左侧侧边栏（220pt，顶部应用名，图标和文字横排；关掉文字时收成 76pt 的图标栏）。
//
// 原生端说明：
// - 网页演示里的假状态栏、示例页面（首页 / 发现 / 消息 / 我的的内容）不属于标签栏，不画；标签由宿主传（标题 + SF Symbol + 角标），
//   选中项用 selection 绑定读写（不传就组件自己管），每次点按回调 onSelect。
// - 只要栏：TabBar(...) 铺满宿主给的区域（通常 .overlay 在页面上），只有栏本身接触摸，其余区域透传；桌面侧栏时宿主自己给内容让出 sidebarWidth。
// - 要连页面切换动画一起：TabBar(...) { index in 页面 } —— 组件负责摆页面、按切换方向左右（桌面上下）滑入滑出、给栏让位。
//
// 动画说明：指示器用 matchedGeometryEffect 在标签之间飞（spring stiffness / damping = 1.24√k）；图标的按压和弹跳需要
// 「从当前状态带初速度起步」，SwiftUI 的隐式动画给不了绝对初速度，所以用 CADisplayLink 自己解析求解弹簧（与 motion 一致）。
import SwiftUI
import UIKit
import Observation

public struct TabBar: View {
    /// 选中标签的标记样式
    public enum Indicator: String, CaseIterable, Sendable {
        case pill, underline, dot
    }

    /// 栏的形态（按组件宽度：< 600 手机，600–899 iPad，≥ 900 桌面）
    public enum Form: Sendable {
        case phone, pad, desktop

        public init(width: CGFloat) {
            self = width >= 900 ? .desktop : width >= 600 ? .pad : .phone
        }
    }

    /// 一个标签：标题 + SF Symbol 名 + 角标数字（0 不显示）
    public struct Tab: Identifiable, Sendable {
        public var id: String
        public var title: String
        public var systemImage: String
        public var badge: Int

        public init(_ title: String, systemImage: String, badge: Int = 0, id: String? = nil) {
            self.id = id ?? title
            self.title = title
            self.systemImage = systemImage
            self.badge = badge
        }

        /// 网页演示的四个标签
        public static let samples: [Tab] = [
            Tab("首页", systemImage: "house", id: "home"),
            Tab("发现", systemImage: "safari", id: "discover"),
            Tab("消息", systemImage: "message", badge: 3, id: "inbox"),
            Tab("我的", systemImage: "person", id: "me"),
        ]
    }

    /// 桌面侧边栏顶部的应用名
    public struct Brand: Sendable {
        public var title: String
        public var mark: String
        public init(title: String, mark: String) {
            self.title = title
            self.mark = mark
        }
        public static let sample = Brand(title: "狐狸日常", mark: "狐")
    }

    /// 桌面侧边栏的宽度（宿主只用栏、自己摆内容时，给内容让出这么宽）
    public static func sidebarWidth(showLabels: Bool) -> CGFloat { showLabels ? 220 : 76 }

    private let selection: Binding<Int>?
    private let tabs: [Tab]
    private let indicator: Indicator
    private let color: Color
    private let showLabels: Bool
    private let stiffness: Double
    private let brand: Brand?
    private let haptics: Bool
    private let onSelect: ((Int) -> Void)?
    private let page: ((Int) -> AnyView)?

    @State private var internalSelection = 0
    @State private var shown = 0
    @State private var dir: Double = 1
    @Namespace private var ns
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 只要标签栏（铺满宿主给的区域，栏按宽度自己定位）
    /// - Parameters:
    ///   - selection: 外部绑定的选中下标；不传则组件内部自己管理
    ///   - tabs: 标签（标题 + SF Symbol + 角标），默认网页的四个
    ///   - indicator: 选中标签的标记样式，切换样式时也会平滑过渡
    ///   - color: 选中标签和指示器的颜色
    ///   - showLabels: 图标下方（iPad / 桌面为右侧）是否显示标签文字
    ///   - stiffness: 指示器滑动和图标弹跳的力度，越大越快、越利落（120–900）
    ///   - brand: 桌面侧边栏顶部的应用名，nil 不显示
    ///   - haptics: 点标签时的触感反馈
    ///   - onSelect: 每次点按标签（包括再点一次当前标签）都会回调下标
    public init(
        selection: Binding<Int>? = nil,
        tabs: [Tab] = Tab.samples,
        indicator: Indicator = .pill,
        color: Color = Color(hex: "#5B5BF6"),
        showLabels: Bool = true,
        stiffness: Double = 420,
        brand: Brand? = .sample,
        haptics: Bool = true,
        onSelect: ((Int) -> Void)? = nil
    ) {
        self.init(selection: selection, tabs: tabs, indicator: indicator, color: color, showLabels: showLabels, stiffness: stiffness,
                  brand: brand, haptics: haptics, onSelect: onSelect, anyPage: nil)
    }

    /// 标签栏 + 页面容器：页面按切换方向滑入滑出（手机 / iPad 左右，桌面上下），并给栏让位
    /// - Parameter page: 按下标返回宿主的页面
    public init<Page: View>(
        selection: Binding<Int>? = nil,
        tabs: [Tab] = Tab.samples,
        indicator: Indicator = .pill,
        color: Color = Color(hex: "#5B5BF6"),
        showLabels: Bool = true,
        stiffness: Double = 420,
        brand: Brand? = .sample,
        haptics: Bool = true,
        onSelect: ((Int) -> Void)? = nil,
        @ViewBuilder page: @escaping (Int) -> Page
    ) {
        self.init(selection: selection, tabs: tabs, indicator: indicator, color: color, showLabels: showLabels, stiffness: stiffness,
                  brand: brand, haptics: haptics, onSelect: onSelect, anyPage: { AnyView(page($0)) })
    }

    private init(
        selection: Binding<Int>?, tabs: [Tab], indicator: Indicator, color: Color, showLabels: Bool, stiffness: Double,
        brand: Brand?, haptics: Bool, onSelect: ((Int) -> Void)?, anyPage: ((Int) -> AnyView)?
    ) {
        self.selection = selection
        self.tabs = tabs
        self.indicator = indicator
        self.color = color
        self.showLabels = showLabels
        self.stiffness = stiffness
        self.brand = brand
        self.haptics = haptics
        self.onSelect = onSelect
        self.page = anyPage
        _shown = State(initialValue: selection?.wrappedValue ?? 0)
    }

    private var current: Int {
        let i = selection?.wrappedValue ?? internalSelection
        return tabs.isEmpty ? 0 : Swift.min(Swift.max(0, i), tabs.count - 1)
    }

    private var palette: TBPalette { colorScheme == .dark ? .dark : .light }

    public var body: some View {
        GeometryReader { geo in
            let form = Form(width: geo.size.width)
            let safe = geo.safeAreaInsets
            ZStack(alignment: .topLeading) {
                if page != nil { pages(form: form, safe: safe) }
                if form == .desktop {
                    sidebar(safe: safe)
                } else {
                    floatingBar(form: form, safe: safe)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
        .onChange(of: current) { _, new in
            guard new != shown else { return }
            // 先定方向，下一拍再换页：离场的页面拿到的是新方向（往右点就从右边进来、旧页往左出去）
            dir = new > shown ? 1 : -1
            DispatchQueue.main.async { shown = new }
        }
    }

    /* ---------- 页面容器 ---------- */

    private func pages(form: Form, safe: EdgeInsets) -> some View {
        let side: CGFloat = form == .desktop ? Self.sidebarWidth(showLabels: showLabels) : 0
        let gap = bottomGap(form: form, safe: safe)
        let barH: CGFloat = (form == .phone ? (showLabels ? 56 : 48) : (showLabels ? 50 : 48)) + 12
        let reserve = form == .desktop ? 0 : Swift.max(0, barH + gap + 8 - safe.bottom)
        let vertical = form == .desktop
        let idx = tabs.isEmpty ? 0 : Swift.min(Swift.max(0, shown), tabs.count - 1)
        return ZStack {
            if let page {
                page(idx)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .id(idx)
                    .transition(pageTransition(vertical: vertical))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaPadding(.bottom, reserve)
        .clipped()
        .padding(.leading, side)
        .animation(.timingCurve(0.33, 0.55, 0.2, 1, duration: 0.4), value: side)
    }

    /// 网页：进场 x/y 从 ±44 用 spring 380 / 38 归位、透明度 0.2s；离场往反方向 44、透明度 0.12s 先淡掉
    private func pageTransition(vertical: Bool) -> AnyTransition {
        let d = reduceMotion ? 0 : CGFloat(dir) * 44
        let spring = Animation.motionSpring(stiffness: 380, damping: 38)
        let inMove = AnyTransition.modifier(active: TBShift(d: d, vertical: vertical), identity: TBShift(d: 0, vertical: vertical)).animation(spring)
        let inFade = AnyTransition.opacity.animation(.timingCurve(0.33, 0.55, 0.2, 1, duration: 0.2))
        let outMove = AnyTransition.modifier(active: TBShift(d: -d, vertical: vertical), identity: TBShift(d: 0, vertical: vertical)).animation(spring)
        let outFade = AnyTransition.opacity.animation(.easeOut(duration: 0.12))
        return .asymmetric(insertion: inMove.combined(with: inFade), removal: outMove.combined(with: outFade))
    }

    /* ---------- 手机 / iPad：底部悬浮栏 ---------- */

    /// 栏底离屏幕底的距离：网页手机 18、iPad 22；有 Home 条时再往上让一点
    private func bottomGap(form: Form, safe: EdgeInsets) -> CGFloat {
        let base: CGFloat = form == .pad ? 22 : 18
        return Swift.max(base, safe.bottom - 12)
    }

    private func floatingBar(form: Form, safe: EdgeInsets) -> some View {
        let p = palette
        let shape = RoundedRectangle(cornerRadius: 28, style: .circular)
        return VStack(spacing: 0) {
            Spacer(minLength: 0)
            tabStack(form: form, axis: .horizontal)
                .padding(6)
                .background {
                    // 半透明 + 背景模糊（backdrop-filter: blur(18px) saturate(1.8)）、0.5px 内描边、投影
                    shape
                        .fill(p.bar)
                        .background(.ultraThinMaterial, in: shape)
                        .overlay(shape.strokeBorder(p.barEdge, lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.12), radius: 15, x: 0, y: 10)
                }
                .frame(width: form == .pad ? 480 : nil)
                .padding(.horizontal, form == .phone ? 14 : 0)
                .padding(.bottom, bottomGap(form: form, safe: safe) - safe.bottom)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /* ---------- 桌面：左侧侧边栏 ---------- */

    private func sidebar(safe: EdgeInsets) -> some View {
        let p = palette
        let side = Self.sidebarWidth(showLabels: showLabels)
        let curve = Animation.timingCurve(0.33, 0.55, 0.2, 1, duration: 0.4)
        return ZStack(alignment: .topLeading) {
            tabStack(form: .desktop, axis: .vertical)
                .padding(.top, 80 + safe.top)
                .padding(.horizontal, 12)
                .padding(.bottom, 16 + safe.bottom)
                .frame(maxHeight: .infinity, alignment: .top)
            if let brand {
                HStack(spacing: 10) {
                    Text(brand.mark)
                        .font(.system(size: 15))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .circular)
                                .fill(LinearGradient(colors: [color, tbMix(color, Color(hex: "#FF9A62"), 0.45)], startPoint: .topLeading, endPoint: .bottomTrailing))
                        )
                    Text(brand.title)
                        .font(.system(size: 16, weight: .heavy))
                        .foregroundStyle(p.fg)
                        .lineLimit(1)
                        .fixedSize()
                        .opacity(showLabels ? 1 : 0)
                        .animation(.easeInOut(duration: 0.2), value: showLabels)
                }
                .padding(.horizontal, 22)
                .frame(height: 72)
                .padding(.top, safe.top)
                .accessibilityHidden(true)
            }
        }
        .frame(width: side, alignment: .topLeading)
        .frame(maxHeight: .infinity)
        .background(p.card)
        .overlay(alignment: .trailing) { Rectangle().fill(p.line).frame(width: 1) }
        .clipped()
        .animation(curve, value: showLabels)
        .padding(.top, -safe.top)
        .padding(.bottom, -safe.bottom)
        .padding(.leading, -safe.leading)
    }

    /* ---------- 标签 ---------- */

    @ViewBuilder
    private func tabStack(form: Form, axis: Axis) -> some View {
        let k = stiffness
        // 指示器：阻尼比约 0.62，到位时轻轻过冲一点再停
        let slide = Animation.motionSpring(stiffness: k, damping: 1.24 * k.squareRoot())
        let labelSpring = Animation.motionSpring(stiffness: 420, damping: 36)
        let items = ForEach(Array(tabs.enumerated()), id: \.element.id) { i, tab in
            TBTabButton(
                tab: tab,
                on: i == current,
                form: form,
                showLabel: showLabels,
                indicator: indicator,
                color: color,
                palette: palette,
                dark: colorScheme == .dark,
                stiffness: stiffness,
                reduceMotion: reduceMotion,
                ns: ns,
                onSelect: { select(i) }
            )
        }
        Group {
            if axis == .horizontal {
                HStack(spacing: 0) { items }
            } else {
                VStack(spacing: 4) { items }
            }
        }
        .animation(labelSpring, value: showLabels)
        .animation(slide, value: current)
        .animation(slide, value: indicator)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("主导航")
    }

    private func select(_ i: Int) {
        Haptics.tap(haptics)
        onSelect?(i)
        guard i != current else { return }
        if let selection { selection.wrappedValue = i } else { internalSelection = i }
    }
}

/* ---------- 单个标签：按压一缩、松手带初速度弹回，选中时图标往上一跳 ---------- */

private struct TBTabButton: View {
    let tab: TabBar.Tab
    let on: Bool
    let form: TabBar.Form
    let showLabel: Bool
    let indicator: TabBar.Indicator
    let color: Color
    let palette: TBPalette
    let dark: Bool
    let stiffness: Double
    let reduceMotion: Bool
    let ns: Namespace.ID
    let onSelect: () -> Void

    @State private var motion = TBIconMotion()
    @State private var hovering = false
    @State private var down = false
    @State private var inside = false
    @State private var size: CGSize = .zero
    @GestureState private var touching = false

    var body: some View {
        let active = dark ? tbMix(color, .white, 0.28) : color
        let tint = on ? active : (hovering && form != .phone ? palette.fg : palette.muted)
        let lineKind = indicator != .pill

        stack
            .foregroundStyle(tint)
            .animation(.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.2), value: on)
            .animation(.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.2), value: hovering)
            .padding(.bottom, form != .desktop && lineKind ? (form == .phone ? 6 : 12) : 0)
            .frame(maxWidth: .infinity, minHeight: minHeight, alignment: form == .desktop && showLabel ? .leading : .center)
            .background { pill }
            .overlay(alignment: form == .desktop ? .leading : .bottom) { line }
            .contentShape(Rectangle())
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .gesture(press)
            .onChange(of: touching) { _, t in
                // 手势被系统打断时 onEnded 不会触发（相当于 pointercancel）
                if !t && down {
                    down = false
                    motion.release(stiffness: stiffness)
                }
            }
            .onHover { hovering = $0 }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(tab.badge > 0 ? "\(tab.title)，\(tab.badge) 条未读" : tab.title)
            .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { tapped() }
    }

    private var minHeight: CGFloat {
        switch form {
        case .phone: return showLabel ? 56 : 48
        case .pad: return showLabel ? 50 : 48
        case .desktop: return 44
        }
    }

    @ViewBuilder
    private var stack: some View {
        switch form {
        case .phone:
            VStack(spacing: 2) {
                icon
                if showLabel { label.transition(.opacity) }
            }
            .padding(.vertical, 6)
        case .pad:
            HStack(spacing: showLabel ? 8 : 0) {
                icon
                if showLabel { label.transition(.opacity) }
            }
            .padding(.horizontal, 6)
        case .desktop:
            HStack(spacing: showLabel ? 12 : 0) {
                icon
                if showLabel { label.transition(.opacity) }
            }
            .padding(.horizontal, showLabel ? 14 : 0)
        }
    }

    private var icon: some View {
        let box: CGFloat = form == .desktop ? 20 : 23
        return Image(systemName: tab.systemImage)
            .font(.system(size: box * 0.82, weight: on ? .semibold : .regular))
            .frame(width: box, height: box)
            .overlay(alignment: .topTrailing) {
                ZStack {
                    if tab.badge > 0 {
                        badge.transition(.scale(scale: 0.01))
                    }
                }
                .animation(.motionSpring(stiffness: 560, damping: 22), value: tab.badge > 0)
            }
            .scaleEffect(motion.scale)
            .offset(y: motion.y)
    }

    private var badge: some View {
        Text("\(tab.badge)")
            .font(.system(size: 10.5, weight: .bold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 4)
            .frame(minWidth: 17, minHeight: 17, maxHeight: 17)
            .background(Capsule().fill(Color(hex: "#FF3B30")))
            // box-shadow: 0 0 0 2px var(--card)
            .background(Capsule().fill(palette.card).padding(-2))
            .fixedSize()
            .offset(x: form == .pad ? 7 : 9, y: -5)
    }

    private var label: some View {
        let (size, line): (CGFloat, CGFloat) = form == .phone ? (11, 14) : form == .pad ? (13, 18) : (14, 20)
        return Text(tab.title)
            .font(.system(size: size, weight: .semibold))
            .lineLimit(1)
            .fixedSize()
            .frame(height: line)
    }

    /// 胶囊：手机 / iPad 左右各缩 4、圆角 22；桌面铺满整格、圆角 12
    @ViewBuilder
    private var pill: some View {
        if on && indicator == .pill {
            RoundedRectangle(cornerRadius: form == .desktop ? 12 : 22, style: .circular)
                .fill(color.opacity(dark ? 0.26 : 0.14))
                .matchedGeometryEffect(id: "tab-bar-indicator", in: ns)
                .padding(.horizontal, form == .desktop ? 0 : 4)
        }
    }

    /// 下划线 / 圆点：横栏贴底居中；桌面侧栏里下划线变成贴栏左边的竖条，圆点挪到图标左侧
    @ViewBuilder
    private var line: some View {
        if on && indicator == .underline {
            RoundedRectangle(cornerRadius: 2, style: .circular)
                .fill(color)
                .frame(width: form == .desktop ? 3 : 22, height: form == .desktop ? 20 : 3)
                .matchedGeometryEffect(id: "tab-bar-indicator", in: ns)
                .padding(.bottom, form == .desktop ? 0 : 4)
                .offset(x: form == .desktop ? -12 : 0)
        } else if on && indicator == .dot {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .matchedGeometryEffect(id: "tab-bar-indicator", in: ns)
                .padding(.bottom, form == .desktop ? 0 : 4)
                .offset(x: form == .desktop ? 3 : 0)
        }
    }

    private var press: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($touching) { _, s, _ in s = true }
            .onChanged { v in
                if !down {
                    down = true
                    inside = true
                    motion.press()
                } else if inside && !CGRect(origin: .zero, size: size).insetBy(dx: -10, dy: -10).contains(v.location) {
                    // 滑出标签 = pointerleave：弹回，松手也不算点
                    inside = false
                    motion.release(stiffness: stiffness)
                }
            }
            .onEnded { _ in
                guard down else { return }
                down = false
                if inside {
                    motion.release(stiffness: stiffness)
                    tapped()
                }
            }
    }

    private func tapped() {
        // 选中时图标往上一跳：给一个向上的初速度，交给弹簧收回
        if !reduceMotion { motion.pop(stiffness: stiffness) }
        onSelect()
    }
}

/// 页面滑动（横向 x 或竖向 y）
private struct TBShift: ViewModifier {
    let d: CGFloat
    let vertical: Bool
    func body(content: Content) -> some View {
        content.offset(x: vertical ? 0 : d, y: vertical ? d : 0)
    }
}

/* ---------- 颜色（style.css 浅色 / 深色） ---------- */

private struct TBPalette {
    let card: Color
    let fg: Color
    let muted: Color
    let line: Color
    let bar: Color
    let barEdge: Color

    static let light = TBPalette(
        card: Color(hex: "#FFFFFF"),
        fg: Color(hex: "#111111"),
        muted: Color(hex: "#8E8E93"),
        line: Color.black.opacity(0.06),
        bar: Color.white.opacity(0.78),
        barEdge: Color.black.opacity(0.06)
    )
    static let dark = TBPalette(
        card: Color(hex: "#1C1C1E"),
        fg: Color(hex: "#F5F5F7"),
        muted: Color(hex: "#7C7C82"),
        line: Color.white.opacity(0.07),
        bar: Color(.sRGB, red: 36 / 255, green: 36 / 255, blue: 40 / 255, opacity: 0.78),
        barEdge: Color.white.opacity(0.08)
    )
}

/// color-mix(in srgb, a (1-t), b t)
private func tbMix(_ a: Color, _ b: Color, _ t: Double) -> Color {
    var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
    var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
    UIColor(a).getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
    UIColor(b).getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
    let k = CGFloat(t)
    return Color(.sRGB, red: Double(r1 + (r2 - r1) * k), green: Double(g1 + (g2 - g1) * k), blue: Double(b1 + (b2 - b1) * k), opacity: Double(a1 + (a2 - a1) * k))
}

/* ---------- 图标的按压 / 弹跳（与 motion 的 animate(value, …) 一致） ---------- */

/// 一段动画：物理弹簧（解析解，显式初速度）或 cubic-bezier 补间
private enum TBAnim {
    case spring(from: Double, to: Double, v0: Double, k: Double, c: Double, begin: CFTimeInterval)
    case tween(from: Double, to: Double, duration: Double, begin: CFTimeInterval)

    /// 返回 (位置, 速度, 是否结束)
    func sample(_ now: CFTimeInterval) -> (x: Double, v: Double, done: Bool) {
        switch self {
        case let .tween(from, to, duration, begin):
            let p = Swift.min(1, Swift.max(0, (now - begin) / duration))
            // 按下：0.09s，ease [0.33, 0.55, 0.2, 1]
            let e = tbCubicBezier(0.33, 0.55, 0.2, 1, p)
            return (from + (to - from) * e, 0, p >= 1)
        case let .spring(from, to, v0, k, c, begin):
            let t = Swift.max(0, now - begin)
            let zeta = c / (2 * k.squareRoot())
            let w0 = k.squareRoot()
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
            // motion 的静止判定：变化量 < 5 时用细粒度阈值
            let granular = abs(delta) < 5
            let done = t > 0.02 && abs(v) <= (granular ? 0.01 : 2) && abs(to - x) <= (granular ? 0.005 : 0.5)
            return done ? (to, 0, true) : (x, v, false)
        }
    }
}

@Observable
private final class TBIconMotion {
    enum Channel: Hashable { case scale, y }

    var scale: Double = 1
    var y: Double = 0

    @ObservationIgnored private var anims: [Channel: TBAnim] = [:]
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private lazy var proxy = TBLinkProxy(motion: self)

    deinit { link?.invalidate() }

    /// 按下：90ms 缩到 0.86
    func press() {
        run(.scale, .tween(from: scale, to: 0.86, duration: 0.09, begin: CACurrentMediaTime()))
    }

    /// 松手：从当前缩放带初速度弹回 1（缩得够深才给速度 3）
    func release(stiffness: Double) {
        let k = stiffness * 1.2
        run(.scale, .spring(from: scale, to: 1, v0: scale < 0.95 ? 3 : 0, k: k, c: 0.85 * k.squareRoot(), begin: CACurrentMediaTime()))
    }

    /// 选中：y 从当前位置以 -240 的初速度往上一跳，再由弹簧收回 0
    func pop(stiffness: Double) {
        let k = stiffness * 1.2
        run(.y, .spring(from: y, to: 0, v0: -240, k: k, c: 0.85 * k.squareRoot(), begin: CACurrentMediaTime()))
    }

    private func run(_ ch: Channel, _ a: TBAnim) {
        anims[ch] = a
        guard link == nil else { return }
        let l = CADisplayLink(target: proxy, selector: #selector(TBLinkProxy.tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    fileprivate func tick() {
        let now = CACurrentMediaTime()
        for (ch, a) in anims {
            let s = a.sample(now)
            switch ch {
            case .scale: if scale != s.x { scale = s.x }
            case .y: if y != s.x { y = s.x }
            }
            if s.done { anims[ch] = nil }
        }
        if anims.isEmpty {
            link?.invalidate()
            link = nil
        }
    }
}

private final class TBLinkProxy: NSObject {
    weak var motion: TBIconMotion?
    init(motion: TBIconMotion) { self.motion = motion }
    @objc func tick(_ link: CADisplayLink) { motion?.tick() }
}

/// CSS cubic-bezier(x1, y1, x2, y2) 在进度 x 处的值（二分求 t）
private func tbCubicBezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    func bx(_ t: Double) -> Double { let u = 1 - t; return 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t }
    func by(_ t: Double) -> Double { let u = 1 - t; return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t }
    var lo = 0.0, hi = 1.0
    for _ in 0..<24 {
        let mid = (lo + hi) / 2
        if bx(mid) < x { lo = mid } else { hi = mid }
    }
    return by((lo + hi) / 2)
}

/* ---------- 预览（示例页面只是预览用的占位，不属于组件） ---------- */

private struct TabBarPreviewHost: View {
    @State private var selection = 0
    @State private var tabs = TabBar.Tab.samples
    @State private var indicator: TabBar.Indicator = .pill
    @State private var showLabels = true

    var body: some View {
        TabBar(selection: $selection, tabs: tabs, indicator: indicator, showLabels: showLabels, onSelect: { i in
            // 网页演示的角标逻辑：进「消息」清零，离开 2.4s 后来一条新消息
            if i == 2 {
                tabs[2].badge = 0
            } else if tabs[2].badge == 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { if selection != 2 { tabs[2].badge = 1 } }
            }
        }) { i in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(tabs[i].title).font(.system(size: 30, weight: .bold))
                    Picker("指示器", selection: $indicator) {
                        ForEach(TabBar.Indicator.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Toggle("显示文字", isOn: $showLabels)
                    ForEach(0..<12, id: \.self) { n in
                        RoundedRectangle(cornerRadius: 18).fill(Color.secondary.opacity(0.12)).frame(height: 72)
                            .overlay(Text("\(tabs[i].title) · \(n + 1)").foregroundStyle(.secondary))
                    }
                }
                .padding(18)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

#Preview("手机") {
    TabBarPreviewHost()
}

#Preview("手机 · 只要栏") {
    Color(hex: "#F4F4F7")
        .ignoresSafeArea()
        .overlay { TabBar(indicator: .dot, color: Color(hex: "#FF3B5C"), showLabels: false, stiffness: 820) }
}

#Preview("iPad", traits: .fixedLayout(width: 820, height: 1000)) {
    TabBarPreviewHost()
}

#Preview("桌面宽度", traits: .fixedLayout(width: 1180, height: 820)) {
    TabBarPreviewHost()
}
