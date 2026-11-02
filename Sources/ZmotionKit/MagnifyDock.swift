// 放大程序坞（Magnify dock）：仿 macOS / iPadOS / iOS 的程序坞。点图标会跳几下再「启动」，再点一次前台的图标就退出。
// 多端（和网站版一样按组件自己的宽度分）：< 600 手机程序坞（等分的毛玻璃条，图标按下缩小变暗、松手回弹）；
// 600–899 iPad 悬浮程序坞（左常用、竖线、右最近使用，图标更大、不放大）；≥ 900 macOS 式放大程序坞。也可以用 layout 固定成某一端。
//
// 触屏没有悬停：网站版在触屏上只点按、不放大（放大只在桌面宽度 + 有鼠标时启用）。原生端手机 / iPad 程序坞照此不放大；
// 桌面式程序坞把「悬停」换成「按住滑动」——手指按住 0.3s 或滑动超过 8pt 进入放大，图标按与手指的距离放大并浮出名称，
// 在图标上松手就打开它，滑出程序坞再松手算取消；轻点仍是直接打开。
//
// 网页演示里的假桌面 / 主屏（壁纸、主屏图标网格、iPad 小组件、状态栏、菜单栏、底部横条）和打开后的假 App 窗口原生端不画：
// 图标由宿主通过 items 传（不传就用网站版的默认图标），打开 / 退出通过 onOpen / onClose 交给宿主；
// onOpen 带上图标在屏幕上的位置，宿主可以像网站版那样从图标处把自己的页面放大出来。
//
// 动效说明：放大时每个图标的尺寸是 motion useSpring({ mass: 0.1, stiffness: 190, damping: 13 }) 跟随目标值，
// 目标每次手指移动都会变，需要「中途改目标时继承速度」，这里用 SwiftUI 的 Spring 逐帧求值（CADisplayLink）；
// 启动跳动 / 退出轻点是 motion 的关键帧（时间点 + 每段 easeOut / easeIn），同样逐帧求值。按压、名称、运行点用 SwiftUI 动画。
import SwiftUI
import UIKit

public struct MagnifyDock: View {
    /// 布局：auto 按组件宽度（< 600 手机、600–899 iPad、≥ 900 桌面），也可以固定成某一端
    public enum Layout: String {
        case auto
        case phone
        case ipad
        case desktop
    }

    /// 程序坞里的一个图标：名称 + 图标 + 渐变底色
    public struct Item: Identifiable {
        public let id: String
        /// 名称：放大时浮在图标上方，也用作无障碍标签
        public var title: String
        /// 图标（按 foreground 着色，适合 SF Symbols 或模板图片）；默认图标用内置的线条图标，这里为 nil
        public var icon: Image?
        /// 底色渐变（160°，从左上到右下），通常两个颜色
        public var colors: [Color]
        /// 图标前景色
        public var foreground: Color
        /// 桌面程序坞里在它前面画一条竖线（网站版「系统设置」前面那条）
        public var divider: Bool
        fileprivate var glyph: MDGlyph?

        public init(
            id: String? = nil,
            title: String,
            icon: Image,
            colors: [Color] = [Color(hex: "#8EE3FF"), Color(hex: "#0A84FF")],
            foreground: Color = .white,
            divider: Bool = false
        ) {
            self.id = id ?? title
            self.title = title
            self.icon = icon
            self.colors = colors
            self.foreground = foreground
            self.divider = divider
            self.glyph = nil
        }

        /// 用 SF Symbol 当图标
        public init(
            id: String? = nil,
            title: String,
            systemImage: String,
            colors: [Color] = [Color(hex: "#8EE3FF"), Color(hex: "#0A84FF")],
            foreground: Color = .white,
            divider: Bool = false
        ) {
            self.init(id: id, title: title, icon: Image(systemName: systemImage), colors: colors, foreground: foreground, divider: divider)
        }

        fileprivate init(_ id: String, _ title: String, _ glyph: MDGlyph, _ a: String, _ b: String, fg: String? = nil, divider: Bool = false) {
            self.id = id
            self.title = title
            self.icon = nil
            self.colors = [Color(hex: a), Color(hex: b)]
            self.foreground = fg.map { Color(hex: $0) } ?? .white
            self.divider = divider
            self.glyph = glyph
        }

        /// 网站版的 11 个默认图标（桌面程序坞用全部）
        public static var defaults: [Item] {
            [
                Item("finder", "访达", .folder, "#7CC8FF", "#1F6BFF"),
                Item("browser", "浏览器", .compass, "#8EE3FF", "#0A84FF"),
                Item("messages", "信息", .message, "#7BEA8C", "#1DB954"),
                Item("mail", "邮件", .mail, "#6FB6FF", "#3157F5"),
                Item("photos", "照片", .photo, "#FFC36B", "#FF4F8B"),
                Item("music", "音乐", .music, "#FF8FA3", "#F2274B"),
                Item("calendar", "日历", .calendar, "#FFFFFF", "#E9E9EE", fg: "#F2453D"),
                Item("maps", "地图", .map, "#B6F37A", "#25B05C"),
                Item("notes", "备忘录", .note, "#FFE58A", "#FFB800"),
                Item("terminal", "终端", .terminal, "#565A66", "#16181D"),
                Item("settings", "系统设置", .settings, "#C9CCD3", "#7A7F8A", divider: true),
            ]
        }

        /// iPad 程序坞左侧固定的 6 个
        public static var ipadDefaults: [Item] { pick(["messages", "browser", "mail", "photos", "music", "calendar"]) }
        /// 手机程序坞的 4 个
        public static var phoneDefaults: [Item] { pick(["browser", "messages", "mail", "music"]) }

        fileprivate static func pick(_ ids: [String]) -> [Item] {
            let all = defaults
            return ids.compactMap { id in all.first { $0.id == id } }
        }
    }

    private let magnification: Double
    private let distance: Double
    private let baseSize: Double
    private let bounce: Bool
    private let labels: Bool
    private let haptics: Bool
    private let items: [Item]?
    private let recents: [Item]?
    private let layout: Layout
    private let active: Binding<String?>?
    private let onOpen: ((_ item: Item, _ iconFrame: CGRect) -> Void)?
    private let onClose: ((_ item: Item) -> Void)?

    @State private var model = MDModel()
    @State private var width: CGFloat?
    @GestureState private var touching = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - magnification: 手指正下方图标的放大倍数，1 为不放大（1–2.6）。只在桌面式程序坞按住滑动时生效
    ///   - distance: 离手指多远以内的图标会被放大，越大衰减越平缓（pt，60–320）。只在桌面式程序坞生效
    ///   - baseSize: 图标静止时的尺寸（pt，32–72），容器太窄时会自动缩小；iPad / 手机以它为基准再放大一点
    ///   - bounce: 启动时图标是否上下跳几下（三端都有；系统开了「减弱动态效果」时不跳）
    ///   - labels: 桌面式程序坞放大时是否在图标上方浮出名称
    ///   - haptics: 触感反馈（网站版的音效：滑过图标 tick → 选择反馈、启动 pop、切换 / 退出 tap）
    ///   - items: 程序坞里的图标；nil 时用网站版的默认图标（桌面 11 个、iPad 6 个、手机 4 个）
    ///   - recents: iPad 程序坞竖线右侧的「最近使用」（最多 3 个，和 items 重复的不显示）；nil 时默认图标下显示「访达」，自定义 items 下为空
    ///   - layout: 固定成某一端；auto 按组件宽度
    ///   - active: 前台 App 的 id（可选绑定）。宿主关掉自己的页面时把它设回 nil，程序坞就把那个 App 当作已退出
    ///   - onOpen: 启动或切到前台时回调，带图标在全局坐标里的位置（启动时在跳动结束、网站版窗口弹出的那一刻回调）
    ///   - onClose: 再点一次前台 App 的图标退出时回调
    public init(
        magnification: Double = 1.8,
        distance: Double = 150,
        baseSize: Double = 48,
        bounce: Bool = true,
        labels: Bool = true,
        haptics: Bool = true,
        items: [Item]? = nil,
        recents: [Item]? = nil,
        layout: Layout = .auto,
        active: Binding<String?>? = nil,
        onOpen: ((_ item: Item, _ iconFrame: CGRect) -> Void)? = nil,
        onClose: ((_ item: Item) -> Void)? = nil
    ) {
        self.magnification = magnification
        self.distance = distance
        self.baseSize = baseSize
        self.bounce = bounce
        self.labels = labels
        self.haptics = haptics
        self.items = items
        self.recents = recents
        self.layout = layout
        self.active = active
        self.onOpen = onOpen
        self.onClose = onClose
    }

    // MARK: - 分端与尺寸

    private var end: MDEnd {
        switch layout {
        case .phone: return .phone
        case .ipad: return .ipad
        case .desktop: return .desktop
        case .auto:
            let w = width ?? 0
            return w >= 900 ? .desktop : w >= 600 ? .ipad : .phone
        }
    }

    private var desktopItems: [Item] { items ?? Item.defaults }

    /// 桌面：按宽度决定放几个、多大（和网站版 fit 一样，挤不下时先缩小、再从中间往后少放几个，最后一个始终保留）
    private var desktopFit: (n: Int, b: Double) {
        let count = desktopItems.count
        guard let width else { return (count, baseSize) }
        return mdFit(width: Double(width), baseSize: baseSize, mag: magnification, dist: distance, count: count)
    }

    private func shownDesktop(_ n: Int) -> [Item] {
        let all = desktopItems
        guard n < all.count, let last = all.last else { return all }
        return Array(all.prefix(max(0, n - 1))) + [last]
    }

    /// 触屏端图标的尺寸基准：比桌面大一点（iPad ×1.3、手机 ×1.25），窄屏时再按宽度收
    private var touchBase: Double { (baseSize * (end == .ipad ? 1.3 : 1.25)).rounded() }

    private var front: String? { active != nil ? active?.wrappedValue : model.localFront }

    // MARK: - 视图

    public var body: some View {
        let pal = MDPalette(dark: colorScheme == .dark)
        let fit = desktopFit
        ZStack {
            switch end {
            case .desktop: desktopDock(pal, fit: fit)
            case .ipad: ipadDock(pal)
            case .phone: phoneDock(pal)
            }
        }
        .frame(maxWidth: .infinity)
        .coordinateSpace(.named(mdSpace))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onAppear(perform: seed)
        .onDisappear { model.cancelTasks() }
        .onChange(of: active?.wrappedValue) { _, new in hostChangedFront(new) }
        // 跨端：放大和名称全部复原
        .onChange(of: end) { _, _ in
            model.cancelTouch()
            model.hovered = nil
            model.jumpAll()
        }
        // 参数或容器变化：静止时直接回到新尺寸
        .onChange(of: fit.b) { _, _ in
            if model.hovered == nil && model.touch == nil { model.jumpAll() }
        }
        // 手势被系统打断时 onEnded 不会触发，这里兜底（相当于 pointercancel）
        .onChange(of: touching) { _, isTouching in
            guard !isTouching else { return }
            DispatchQueue.main.async {
                if model.touch != nil {
                    model.cancelTouch()
                    rest(base: desktopFit.b, list: shownDesktop(desktopFit.n))
                }
            }
        }
    }

    // MARK: 桌面：放大程序坞

    private func desktopDock(_ pal: MDPalette, fit: (n: Int, b: Double)) -> some View {
        let b = fit.b
        let list = shownDesktop(fit.n)
        let gap = mdGap(b)
        let pad = mdPad(b)
        return HStack(alignment: .bottom, spacing: gap) {
            ForEach(list) { item in
                if item.divider {
                    Rectangle()
                        .fill(pal.divider)
                        .frame(width: 1)
                        .padding(.vertical, 4)
                        .padding(.horizontal, 2)
                        .frame(height: b)
                }
                desktopItem(item, base: b, pal: pal)
            }
        }
        .padding(.horizontal, pad)
        .padding(.bottom, pad)
        // 程序坞高度固定在静止尺寸，放大的图标从上沿长出去（和网站版 align-items: flex-end 一样）
        .frame(height: b + pad * 2, alignment: .bottom)
        .background { MDGlass(radius: 18, pal: pal, blur: false) }
        .contentShape(Rectangle())
        .gesture(desktopGesture(list: list, base: b))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("程序坞")
    }

    private func desktopItem(_ item: Item, base: Double, pal: MDPalette) -> some View {
        let s = model.sizes[item.id] ?? base
        let isRunning = model.running.contains(item.id)
        let pressed = model.pressed == item.id
        return MDFace(item: item, size: s)
            .animation(.easeOut(duration: 0.09)) { $0.scaleEffect(pressed ? 0.92 : 1) }
            .offset(y: model.lifts[item.id] ?? 0)
            .frame(width: s, height: s)
            .overlay(alignment: .top) {
                ZStack {
                    if labels && model.hovered == item.id {
                        MDLabel(title: item.title, pal: pal)
                            .transition(.asymmetric(
                                insertion: .scale(scale: 0.9).combined(with: .opacity).combined(with: .offset(y: 6)).animation(mdPop(0.24)),
                                removal: .scale(scale: 0.96).combined(with: .opacity).animation(.easeInOut(duration: 0.07))
                            ))
                    }
                }
                .fixedSize()
                // 名称的下沿在图标上方 12pt
                .alignmentGuide(.top) { d in d[.bottom] + 12 }
                .allowsHitTesting(false)
            }
            .overlay(alignment: .bottom) {
                ZStack {
                    if isRunning {
                        Circle()
                            .fill(pal.dot)
                            .transition(.scale(scale: 0).combined(with: .opacity).animation(mdPop(0.25)))
                    }
                }
                .frame(width: 4, height: 4)
                // 运行点：下沿在图标下方 7pt
                .alignmentGuide(.bottom) { d in d[.bottom] - 7 }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.frames[item.id] = $0 }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isRunning ? "\(item.title)（运行中）" : "打开\(item.title)")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { activate(item, iconSize: base) }
    }

    // MARK: iPad：悬浮程序坞（左常用、竖线、右最近使用）

    private func ipadDock(_ pal: MDPalette) -> some View {
        let list = items ?? Item.ipadDefaults
        let fixed = Set(list.map(\.id))
        let rec = Array((recents ?? (items == nil ? Item.pick(["finder"]) : [])).filter { !fixed.contains($0.id) }.prefix(3))
        let n = Double(max(1, list.count + rec.count))
        let w = Double(width ?? 10_000)
        let icon = max(1, min(touchBase, (w - 32 - 24 - 25 - (n - 1) * 12) / n))
        return HStack(spacing: 12) {
            ForEach(list) { touchIcon($0, size: icon) }
            if !rec.isEmpty {
                Rectangle()
                    .fill(pal.divider)
                    .frame(width: 1, height: max(0, icon - 8))
                    .transition(.opacity)
            }
            ForEach(rec) { item in
                touchIcon(item, size: icon)
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0).combined(with: .opacity),
                        removal: .scale(scale: 0).combined(with: .opacity).animation(.easeInOut(duration: 0.16))
                    ))
            }
        }
        .animation(mdPop(0.3), value: rec.map(\.id))
        .padding(12)
        .background { MDGlass(radius: 28, pal: pal, blur: true) }
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("程序坞")
    }

    // MARK: 手机：等分的毛玻璃程序坞

    private func phoneDock(_ pal: MDPalette) -> some View {
        let list = items ?? Item.phoneDefaults
        let n = Double(max(1, list.count))
        let w = Double(width ?? 390)
        let icon = max(1, min(touchBase, (w - 48) / n - 16))
        return HStack(spacing: 0) {
            ForEach(list) { item in
                touchIcon(item, size: icon).frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 15)
        .padding(.horizontal, 12)
        .background { MDGlass(radius: 34, pal: pal, blur: true) }
        .padding(.horizontal, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("程序坞")
    }

    /// 触屏图标：按下压小、变暗，松手带弹簧回弹（和点赞按钮同一套手感）；点开时和桌面一样会跳动
    private func touchIcon(_ item: Item, size: Double) -> some View {
        Button {
            activate(item, iconSize: size)
        } label: {
            MDFace(item: item, size: size)
        }
        .buttonStyle(MDPressStyle(radius: size * 0.23))
        .offset(y: model.lifts[item.id] ?? 0)
        .frame(width: size, height: size)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.frames[item.id] = $0 }
        .accessibilityLabel(model.running.contains(item.id) ? "\(item.title)（运行中）" : "打开\(item.title)")
    }

    // MARK: - 启动 / 切换 / 退出

    private func seed() {
        guard !model.seeded else { return }
        model.seeded = true
        // 网站版初始状态：访达在运行（桌面程序坞下面有个点）；自定义 items 从空开始
        if items == nil { model.running.insert("finder") }
        if let f = front { model.running.insert(f) }
        model.lastFront = front
    }

    private func setFront(_ id: String?) {
        model.lastFront = id
        if let active { active.wrappedValue = id } else { model.localFront = id }
    }

    /// 宿主自己改了前台 App：设回 nil 相当于网站版点红点 / 返回退出；设成别的 id 相当于切到前台
    private func hostChangedFront(_ new: String?) {
        guard new != model.lastFront else { return }
        if new == nil, let old = model.lastFront { model.running.remove(old) }
        if let new { model.running.insert(new) }
        model.lastFront = new
    }

    private func activate(_ item: Item, iconSize: Double) {
        let id = item.id
        if front == id {
            // 再点前台应用：轻点一下，退出
            model.nudge(id)
            model.running.remove(id)
            setFront(nil)
            Haptics.tap(haptics)
            onClose?(item)
            return
        }
        if model.running.contains(id) {
            // 已在运行：直接切到前台
            setFront(id)
            Haptics.tap(haptics)
            onOpen?(item, model.frames[id] ?? .zero)
            return
        }
        model.running.insert(id)
        let delay: Double
        if bounce && !reduceMotion {
            // 跳动高度按图标尺寸算：桌面是静止尺寸，触屏端是图标实际大小
            model.bounce(id, height: iconSize * 0.62)
            delay = 0.82
        } else {
            delay = 0.08
        }
        let open = onOpen
        let binding = active
        let m = model
        m.later(delay) {
            m.lastFront = id
            if let binding { binding.wrappedValue = id } else { m.localFront = id }
            open?(item, m.frames[id] ?? .zero)
        }
        Haptics.pop(haptics)
    }

    // MARK: - 桌面：按住滑动放大

    private func desktopGesture(list: [Item], base: Double) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named(mdSpace))
            .updating($touching) { _, state, _ in state = true }
            .onChanged { value in
                if model.touch == nil {
                    touchDown(value.location, list: list, base: base)
                } else {
                    touchMove(value, list: list, base: base)
                }
            }
            .onEnded { value in touchUp(value.location, list: list, base: base) }
    }

    /// 每个图标当前的中心 x 和尺寸（相对组件根，按当前帧的弹簧尺寸算，等同网站版每次读 getBoundingClientRect）
    private func layoutNow(_ list: [Item], base: Double) -> (slots: [(id: String, c: Double, s: Double)], left: Double, right: Double) {
        let gap = mdGap(base)
        let pad = mdPad(base)
        var x = pad
        var slots: [(id: String, c: Double, s: Double)] = []
        for item in list {
            if item.divider { x += 5 + gap }
            let s = model.sizes[item.id] ?? base
            slots.append((item.id, x + s / 2, s))
            x += s + gap
        }
        let total = x - gap + pad
        let left = (Double(width ?? 0) - total) / 2
        return (slots.map { ($0.id, $0.c + left, $0.s) }, left, left + total)
    }

    private func hit(_ x: Double, _ slots: [(id: String, c: Double, s: Double)], base: Double) -> String? {
        let half = mdGap(base) / 2
        var found: String?
        for slot in slots where x >= slot.c - slot.s / 2 - half && x <= slot.c + slot.s / 2 + half {
            found = slot.id
        }
        return found
    }

    /// 手指是否还在程序坞上（上方留出放大后图标的高度，相当于网站版指针还在程序坞或放大的图标上）
    private func inside(_ p: CGPoint, base: Double, left: Double, right: Double) -> Bool {
        let h = base + mdPad(base) * 2
        let half = mdGap(base) / 2
        let x = Double(p.x), y = Double(p.y)
        return x >= left - half && x <= right + half && y >= -(base * (magnification - 1)) - 24 && y <= h + 24
    }

    private func magnify(_ x: Double, list: [Item], base: Double) {
        let lay = layoutNow(list, base: base)
        let found = hit(x, lay.slots, base: base)
        for slot in lay.slots {
            model.retarget(slot.id, to: base + (magnification - 1) * base * mdFalloff(abs(x - slot.c) / max(1, distance)), base: base)
        }
        if let found, found != model.hovered {
            model.hovered = found
            if haptics { UISelectionFeedbackGenerator().selectionChanged() }
        }
    }

    private func rest(base: Double, list: [Item]) {
        for item in list { model.retarget(item.id, to: base, base: base) }
        model.hovered = nil
    }

    private func touchDown(_ p: CGPoint, list: [Item], base: Double) {
        var t = MDTouch(start: p, last: p)
        let lay = layoutNow(list, base: base)
        t.pressed = hit(Double(p.x), lay.slots, base: base)
        model.touch = t
        model.pressed = t.pressed
        // 按住不动 0.3s 也进入放大（相当于把指针「停」在程序坞上）
        let m = model
        m.hold = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let t = m.touch, !t.scrubbing else { return }
            beginScrub(list: list, base: base)
        }
    }

    private func touchMove(_ v: DragGesture.Value, list: [Item], base: Double) {
        guard var t = model.touch else { return }
        t.last = v.location
        model.touch = t
        if !t.scrubbing {
            if hypot(v.translation.width, v.translation.height) > 8 { beginScrub(list: list, base: base) }
            return
        }
        track(list: list, base: base)
    }

    private func beginScrub(list: [Item], base: Double) {
        guard var t = model.touch, !t.scrubbing else { return }
        t.scrubbing = true
        model.touch = t
        model.hold?.cancel()
        model.pressed = nil
        track(list: list, base: base)
    }

    private func track(list: [Item], base: Double) {
        guard let t = model.touch else { return }
        let lay = layoutNow(list, base: base)
        if inside(t.last, base: base, left: lay.left, right: lay.right) {
            magnify(Double(t.last.x), list: list, base: base)
        } else {
            rest(base: base, list: list)
        }
    }

    private func touchUp(_ p: CGPoint, list: [Item], base: Double) {
        guard let t = model.touch else { return }
        model.cancelTouch()
        let lay = layoutNow(list, base: base)
        let target = inside(p, base: base, left: lay.left, right: lay.right) ? hit(Double(p.x), lay.slots, base: base) : nil
        if t.scrubbing {
            // 滑动放大后松手：在图标上松手就打开它，滑出程序坞松手算取消
            rest(base: base, list: list)
            if let target, let item = list.first(where: { $0.id == target }) { activate(item, iconSize: base) }
        } else if let pressed = t.pressed, pressed == target, let item = list.first(where: { $0.id == pressed }) {
            activate(item, iconSize: base)
        }
    }
}

// MARK: - 常量与小工具

private let mdSpace = "magnify-dock"

private enum MDEnd { case phone, ipad, desktop }

/// 余弦衰减：手指正下方 1，距离 ≥ dist 时 0
private func mdFalloff(_ t: Double) -> Double { t >= 1 ? 0 : (cos(Double.pi * t) + 1) / 2 }
private func mdGap(_ b: Double) -> Double { (b * 0.2).rounded() }
private func mdPad(_ b: Double) -> Double { (b * 0.2).rounded() }

/// 手指停在中间图标上方时整条程序坞的宽度，用来决定窄容器里放几个、多大
private func mdPeakWidth(_ n: Int, _ b: Double, _ mag: Double, _ dist: Double) -> Double {
    let g = mdGap(b)
    let pitch = b + g
    let c = Double(n - 1) / 2
    var w = 0.0
    for k in 0..<max(0, n) { w += b + (mag - 1) * b * mdFalloff(abs(Double(k) - c) * pitch / max(1, dist)) }
    return w + Double(n - 1) * g + mdPad(b) * 2 + g * 2
}

private func mdFit(width: Double, baseSize: Double, mag: Double, dist: Double, count: Int) -> (n: Int, b: Double) {
    let avail = width - 24
    let minN = min(5, count)
    var n = count
    while n >= minN && n > 0 {
        var b = baseSize
        while b >= 26 {
            if mdPeakWidth(n, b, mag, dist) <= avail {
                if b >= min(36, baseSize) || n == minN { return (n, b) }
                break
            }
            b -= 2
        }
        n -= 1
    }
    return (minN, 26)
}

/// motion 的 cubic-bezier 缓动（y 可以超出 0…1）
private func mdBezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ p: Double) -> Double {
    if p <= 0 { return 0 }
    if p >= 1 { return 1 }
    let cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
    let cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
    var lo = 0.0, hi = 1.0, t = p
    for _ in 0..<40 {
        let x = ((ax * t + bx) * t + cx) * t
        if abs(x - p) < 1e-6 { break }
        if x < p { lo = t } else { hi = t }
        t = (lo + hi) / 2
    }
    return ((ay * t + by) * t + cy) * t
}

/// [0.28, 1.3, 0.36, 1]：名称、运行点、最近使用进场用的带回弹曲线
private func mdPop(_ duration: Double) -> Animation { .timingCurve(0.28, 1.3, 0.36, 1, duration: duration) }

/// 网站版触屏按压：{ duration: 0.09, ease: [0.3, 0, 0.5, 1] }；松手 { type: "spring", stiffness: 520, damping: 20 }
private let mdPressIn = Animation.timingCurve(0.3, 0, 0.5, 1, duration: 0.09)
private let mdRelease = Animation.motionSpring(stiffness: 520, damping: 20)

private struct MDTouch {
    var start: CGPoint
    var last: CGPoint
    var pressed: String?
    var scrubbing = false
}

/// 颜色（style.css 浅色 / 深色）
private struct MDPalette {
    let dark: Bool
    var glass: Color { dark ? Color(.sRGB, red: 44 / 255, green: 44 / 255, blue: 58 / 255, opacity: 0.55) : Color.white.opacity(0.5) }
    var glassLine: Color { dark ? Color.white.opacity(0.14) : Color.white.opacity(0.75) }
    var divider: Color { dark ? Color.white.opacity(0.14 * 0.9) : Color.black.opacity(0.12 * 0.9) }
    var labelBg: Color { dark ? Color(.sRGB, red: 240 / 255, green: 240 / 255, blue: 245 / 255, opacity: 0.92) : Color(.sRGB, red: 30 / 255, green: 30 / 255, blue: 34 / 255, opacity: 0.82) }
    var labelFg: Color { dark ? Color(hex: "#111111") : .white }
    var dot: Color { dark ? Color(hex: "#F2F2F5") : Color(hex: "#2A2A2E") }
}

// MARK: - 逐帧动画（尺寸弹簧 + 跳动关键帧）

/// 尺寸弹簧：motion useSpring(target, { mass: 0.1, stiffness: 190, damping: 13 })，中途改目标时继承当前速度
private struct MDSizeRun {
    static let spring = Spring(mass: 0.1, stiffness: 190, damping: 13)
    let from: Double
    let to: Double
    let v0: Double
    let start: CFTimeInterval

    func sample(_ now: CFTimeInterval) -> (x: Double, v: Double, done: Bool) {
        let t = max(0, now - start)
        let d = to - from
        let x = from + Self.spring.value(target: d, initialVelocity: v0, time: t)
        let v = Self.spring.velocity(target: d, initialVelocity: v0, time: t)
        // motion 的默认收尾阈值
        let granular = abs(d) < 5
        if abs(to - x) <= (granular ? 0.005 : 0.5) && abs(v) <= (granular ? 0.01 : 2) { return (to, 0, true) }
        return (x, v, false)
    }
}

/// 关键帧：motion animate(y, values, { duration, times, ease: [...] })，每段各自缓动
private struct MDLiftRun {
    let values: [Double]
    let times: [Double]
    /// 每段的 cubic-bezier
    let eases: [(Double, Double, Double, Double)]
    let duration: Double
    let start: CFTimeInterval

    static let easeOut = (0.0, 0.0, 0.58, 1.0)
    static let easeIn = (0.42, 0.0, 1.0, 1.0)

    func sample(_ now: CFTimeInterval) -> (y: Double, done: Bool) {
        let p = (now - start) / duration
        if p >= 1 { return (values.last ?? 0, true) }
        if p <= 0 { return (values.first ?? 0, false) }
        var k = 0
        while k < times.count - 2 && p >= times[k + 1] { k += 1 }
        let local = (p - times[k]) / max(1e-6, times[k + 1] - times[k])
        let e = eases[min(k, eases.count - 1)]
        let eased = mdBezier(e.0, e.1, e.2, e.3, local)
        return (values[k] + (values[k + 1] - values[k]) * eased, false)
    }
}

@MainActor
@Observable
private final class MDModel {
    /// 桌面图标当前尺寸（没有的按静止尺寸）
    var sizes: [String: Double] = [:]
    /// 图标的竖直位移（跳动 / 退出时轻点）
    var lifts: [String: Double] = [:]
    var hovered: String?
    var pressed: String?
    var running: Set<String> = []
    var localFront: String?

    @ObservationIgnored var lastFront: String?
    @ObservationIgnored var frames: [String: CGRect] = [:]
    @ObservationIgnored var touch: MDTouch?
    @ObservationIgnored var hold: Task<Void, Never>?
    @ObservationIgnored var seeded = false
    @ObservationIgnored private var sizeRuns: [String: MDSizeRun] = [:]
    @ObservationIgnored private var liftRuns: [String: MDLiftRun] = [:]
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var link: CADisplayLink?

    func retarget(_ id: String, to target: Double, base: Double) {
        let now = CACurrentMediaTime()
        var from = sizes[id] ?? base
        var v = 0.0
        if let r = sizeRuns[id] {
            let s = r.sample(now)
            from = s.x
            v = s.v
        } else if abs(from - target) < 0.0001 {
            return
        }
        sizeRuns[id] = MDSizeRun(from: from, to: target, v0: v, start: now)
        startLink()
    }

    /// 不做动画，全部回到静止尺寸
    func jumpAll() {
        sizeRuns.removeAll()
        if !sizes.isEmpty { sizes = [:] }
    }

    /// 启动跳动：[0, -h, 0, -h/2, 0, -0.18h, 0]，1.1s，时间点 [0, .2, .42, .58, .74, .86, 1]，easeOut / easeIn 交替
    func bounce(_ id: String, height h: Double) {
        liftRuns[id] = MDLiftRun(
            values: [0, -h, 0, -h * 0.5, 0, -h * 0.18, 0],
            times: [0, 0.2, 0.42, 0.58, 0.74, 0.86, 1],
            eases: [MDLiftRun.easeOut, MDLiftRun.easeIn, MDLiftRun.easeOut, MDLiftRun.easeIn, MDLiftRun.easeOut, MDLiftRun.easeIn],
            duration: 1.1,
            start: CACurrentMediaTime()
        )
        startLink()
    }

    /// 退出时轻点一下：[0, 4, 0]，0.24s，easeOut
    func nudge(_ id: String) {
        liftRuns[id] = MDLiftRun(
            values: [0, 4, 0],
            times: [0, 0.5, 1],
            eases: [MDLiftRun.easeOut, MDLiftRun.easeOut],
            duration: 0.24,
            start: CACurrentMediaTime()
        )
        startLink()
    }

    func later(_ seconds: Double, _ body: @escaping @MainActor () -> Void) {
        tasks.append(Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            body()
        })
    }

    func cancelTouch() {
        hold?.cancel()
        hold = nil
        touch = nil
        pressed = nil
    }

    func cancelTasks() {
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
        cancelTouch()
    }

    private func startLink() {
        guard link == nil else { return }
        let l = CADisplayLink(target: MDLinkProxy(self), selector: #selector(MDLinkProxy.tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    fileprivate func tick() {
        let now = CACurrentMediaTime()
        for (id, run) in sizeRuns {
            let s = run.sample(now)
            sizes[id] = s.x
            if s.done { sizeRuns[id] = nil }
        }
        for (id, run) in liftRuns {
            let s = run.sample(now)
            lifts[id] = s.y
            if s.done { liftRuns[id] = nil }
        }
        if sizeRuns.isEmpty && liftRuns.isEmpty {
            link?.invalidate()
            link = nil
        }
    }
}

@MainActor
private final class MDLinkProxy: NSObject {
    weak var model: MDModel?
    init(_ model: MDModel) { self.model = model }
    @objc func tick(_ l: CADisplayLink) {
        if let model { model.tick() } else { l.invalidate() }
    }
}

// MARK: - 外观

/// 图标：160° 渐变圆角方块 + 上下内高光 + 投影，中间是线条图标（网站版 lucide，strokeWidth 2，占 52%）
private struct MDFace: View {
    let item: MagnifyDock.Item
    let size: Double

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.23, style: .circular)
        let g = size * 0.52
        ZStack {
            // linear-gradient(160deg)：方块里的渐变线从 (0.28, -0.10) 到 (0.72, 1.10)
            shape
                .fill(
                    LinearGradient(colors: item.colors, startPoint: UnitPoint(x: 0.281, y: -0.103), endPoint: UnitPoint(x: 0.719, y: 1.103))
                        .shadow(.inner(color: .white.opacity(0.35), radius: 0, x: 0, y: 1))
                        .shadow(.inner(color: .black.opacity(0.08), radius: 0, x: 0, y: -1))
                )
                .shadow(color: .black.opacity(0.22), radius: 3, x: 0, y: 4)
            if let glyph = item.glyph {
                MDGlyphShape(glyph: glyph)
                    .stroke(item.foreground, style: StrokeStyle(lineWidth: g / 12, lineCap: .round, lineJoin: .round))
                    .frame(width: g, height: g)
                    .shadow(color: .black.opacity(0.15), radius: 0.5, x: 0, y: 1)
            } else if let icon = item.icon {
                icon
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(item.foreground)
                    .frame(width: g, height: g)
                    .shadow(color: .black.opacity(0.15), radius: 0.5, x: 0, y: 1)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// 触屏按压：压到 0.86、变暗到 brightness(0.8)（盖一层 20% 黑），松手弹簧回弹、变暗 0.2s 褪去
private struct MDPressStyle: ButtonStyle {
    let radius: Double

    func makeBody(configuration: Configuration) -> some View {
        let p = configuration.isPressed
        configuration.label
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .circular)
                    .fill(Color.black.opacity(p ? 0.2 : 0))
                    .animation(p ? mdPressIn : .easeInOut(duration: 0.2), value: p)
            }
            .animation(p ? mdPressIn : mdRelease) { $0.scaleEffect(p ? 0.86 : 1) }
    }
}

/// 名称气泡：12pt 中等字重，深色底（深色模式反过来）
private struct MDLabel: View {
    let title: String
    let pal: MDPalette
    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(pal.labelFg)
            .lineLimit(1)
            .padding(.vertical, 4)
            .padding(.horizontal, 10)
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(pal.labelBg)
                    .shadow(color: .black.opacity(0.18), radius: 7, x: 0, y: 4)
            }
    }
}

/// 程序坞的玻璃底：半透明底色 + 1px 亮边 + 投影（只画在外面，和 CSS box-shadow 一样不透到半透明底下）；
/// iPad / 手机再垫一层毛玻璃（backdrop-filter: blur(24px) saturate(1.6)）
private struct MDGlass: View {
    let radius: Double
    let pal: MDPalette
    let blur: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        ZStack {
            ZStack {
                // 浅色：0 1px 1px rgb(0 0 0 / .04), 0 12px 32px -12px rgb(40 40 90 / .3)；深色：0 12px 32px -10px rgb(0 0 0 / .6)
                if pal.dark {
                    shape.fill(.black).shadow(color: .black.opacity(0.45), radius: 14, x: 0, y: 12)
                } else {
                    shape.fill(.black).shadow(color: Color(.sRGB, red: 40 / 255, green: 40 / 255, blue: 90 / 255, opacity: 0.22), radius: 14, x: 0, y: 12)
                    shape.fill(.black).shadow(color: .black.opacity(0.04), radius: 0.5, x: 0, y: 1)
                }
            }
            .mask {
                ZStack {
                    Rectangle().padding(-80)
                    shape.blendMode(.destinationOut)
                }
                .compositingGroup()
            }
            if blur { shape.fill(.ultraThinMaterial) }
            if pal.dark {
                // 深色多一道 inset 0 1px 0 rgb(255 255 255 / .06)
                shape.fill(pal.glass.shadow(.inner(color: .white.opacity(0.06), radius: 0, x: 0, y: 1)))
            } else {
                shape.fill(pal.glass)
            }
            shape.strokeBorder(pal.glassLine, lineWidth: 1)
        }
        .allowsHitTesting(false)
    }
}

// MARK: - 默认图标（网站版用的 lucide 图标，viewBox 24，按 SVG 路径画）

fileprivate enum MDGlyph: Sendable {
    case folder, compass, mail, message, photo, music, calendar, map, note, terminal, settings

    fileprivate enum El {
        case path(String)
        case circle(Double, Double, Double)
        case rect(Double, Double, Double, Double, Double)
    }

    var elements: [El] {
        switch self {
        case .folder:
            return [.path("M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z")]
        case .compass:
            return [.circle(12, 12, 10), .path("m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z")]
        case .mail:
            return [.path("m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"), .rect(2, 4, 20, 16, 2)]
        case .message:
            return [.path("M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719")]
        case .photo:
            return [.rect(3, 3, 18, 18, 2), .circle(9, 9, 2), .path("m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21")]
        case .music:
            return [.path("M21 16V3a1 1 0 0 0-1.28-.96l-10 2.917a1 1 0 0 0-.72.96V19"), .circle(18, 16, 3), .circle(6, 19, 3)]
        case .calendar:
            return [.path("M8 2v3"), .path("M16 2v3"), .rect(3, 3, 18, 18, 2), .path("M3 9h18")]
        case .map:
            return [
                .path("M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"),
                .path("M15 5.764v15"),
                .path("M9 3.236v15"),
            ]
        case .note:
            return [.path("M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"), .path("M15 3v5a1 1 0 0 0 1 1h5")]
        case .terminal:
            return [.path("M12 19h8"), .path("m4 17 6-6-6-6")]
        case .settings:
            return [
                .path("M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"),
                .circle(12, 12, 3),
            ]
        }
    }

    /// viewBox 0 0 24 24 坐标下的整条路径
    var path24: Path {
        var all = Path()
        for el in elements {
            switch el {
            case .path(let d): all.addPath(mdSVGPath(d))
            case .circle(let cx, let cy, let r): all.addEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
            case .rect(let x, let y, let w, let h, let rx):
                all.addRoundedRect(in: CGRect(x: x, y: y, width: w, height: h), cornerSize: CGSize(width: rx, height: rx), style: .circular)
            }
        }
        return all
    }
}

private struct MDGlyphShape: Shape {
    let glyph: MDGlyph
    func path(in rect: CGRect) -> Path {
        let k = min(rect.width, rect.height) / 24
        return glyph.path24.applying(
            CGAffineTransform(translationX: rect.midX - 12 * k, y: rect.midY - 12 * k).scaledBy(x: k, y: k)
        )
    }
}

// MARK: - SVG 路径（只支持 lucide 图标用到的 M L H V C A Z，大小写都支持）

private enum MDTok {
    case cmd(Character)
    case num(Double)
}

private func mdTokens(_ d: String) -> [MDTok] {
    var out: [MDTok] = []
    var buf = ""
    var hasDot = false
    func flush() {
        if !buf.isEmpty, let v = Double(buf) { out.append(.num(v)) }
        buf = ""
        hasDot = false
    }
    for ch in d {
        switch ch {
        case "0"..."9":
            buf.append(ch)
        case ".":
            if hasDot { flush() }
            buf.append(ch)
            hasDot = true
        case "-", "+":
            if !buf.isEmpty && buf.last != "e" && buf.last != "E" { flush() }
            buf.append(ch)
        case "e", "E":
            buf.append(ch)
        case " ", ",", "\n", "\t":
            flush()
        default:
            flush()
            out.append(.cmd(ch))
        }
    }
    flush()
    return out
}

private func mdSVGPath(_ d: String) -> Path {
    let toks = mdTokens(d)
    var p = Path()
    var i = 0
    var cmd: Character = "M"
    var cur = CGPoint.zero
    var start = CGPoint.zero
    func num() -> Double {
        guard i < toks.count, case .num(let v) = toks[i] else { return 0 }
        i += 1
        return v
    }
    while i < toks.count {
        if case .cmd(let c) = toks[i] {
            i += 1
            if c == "Z" || c == "z" {
                p.closeSubpath()
                cur = start
                continue
            }
            cmd = c
        }
        let rel = cmd.isLowercase
        let before = i
        switch cmd.uppercased() {
        case "M":
            let x = num(), y = num()
            cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            p.move(to: cur)
            start = cur
            cmd = rel ? "l" : "L" // M 后面跟着的坐标对按 L 处理
        case "L":
            let x = num(), y = num()
            cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            p.addLine(to: cur)
        case "H":
            let x = num()
            cur.x = rel ? cur.x + x : x
            p.addLine(to: cur)
        case "V":
            let y = num()
            cur.y = rel ? cur.y + y : y
            p.addLine(to: cur)
        case "C":
            let o = rel ? cur : .zero
            let c1 = CGPoint(x: o.x + num(), y: o.y + num())
            let c2 = CGPoint(x: o.x + num(), y: o.y + num())
            let e = CGPoint(x: o.x + num(), y: o.y + num())
            p.addCurve(to: e, control1: c1, control2: c2)
            cur = e
        case "A":
            let rx = num(), ry = num(), rot = num(), large = num(), sweep = num()
            let x = num(), y = num()
            let e = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            mdArc(&p, from: cur, to: e, rx: rx, ry: ry, phi: rot, large: large != 0, sweep: sweep != 0)
            cur = e
        default:
            break
        }
        if i == before { i += 1 } // 不认识的内容跳过，避免死循环
    }
    return p
}

/// SVG 椭圆弧 → 三次贝塞尔（SVG 规范 F.6.5 的端点参数化换算到圆心参数化）
private func mdArc(_ p: inout Path, from p0: CGPoint, to p1: CGPoint, rx rx0: Double, ry ry0: Double, phi: Double, large: Bool, sweep: Bool) {
    if p0 == p1 { return }
    var rx = abs(rx0), ry = abs(ry0)
    if rx == 0 || ry == 0 {
        p.addLine(to: p1)
        return
    }
    let cphi = cos(phi * .pi / 180), sphi = sin(phi * .pi / 180)
    let dx = (Double(p0.x) - Double(p1.x)) / 2, dy = (Double(p0.y) - Double(p1.y)) / 2
    let x1 = cphi * dx + sphi * dy
    let y1 = -sphi * dx + cphi * dy
    let lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if lam > 1 {
        rx *= lam.squareRoot()
        ry *= lam.squareRoot()
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    var coef = den == 0 ? 0 : max(0, num / den).squareRoot()
    if large == sweep { coef = -coef }
    let cxp = coef * rx * y1 / ry
    let cyp = -coef * ry * x1 / rx
    let cx = cphi * cxp - sphi * cyp + (Double(p0.x) + Double(p1.x)) / 2
    let cy = sphi * cxp + cphi * cyp + (Double(p0.y) + Double(p1.y)) / 2
    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double { atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
    let ux = (x1 - cxp) / rx, uy = (y1 - cyp) / ry
    let vx = (-x1 - cxp) / rx, vy = (-y1 - cyp) / ry
    let theta1 = angle(1, 0, ux, uy)
    var dTheta = angle(ux, uy, vx, vy)
    if !sweep && dTheta > 0 { dTheta -= 2 * .pi } else if sweep && dTheta < 0 { dTheta += 2 * .pi }
    let segs = max(1, Int((abs(dTheta) / (.pi / 2)).rounded(.up)))
    let delta = dTheta / Double(segs)
    let t = 4.0 / 3.0 * tan(delta / 4)
    func map(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: cx + rx * cphi * x - ry * sphi * y, y: cy + rx * sphi * x + ry * cphi * y)
    }
    var th = theta1
    for _ in 0..<segs {
        let c1 = cos(th), s1 = sin(th), c2 = cos(th + delta), s2 = sin(th + delta)
        p.addCurve(to: map(c2, s2), control1: map(c1 - t * s1, s1 + t * c1), control2: map(c2 + t * s2, s2 - t * c2))
        th += delta
    }
}

// MARK: - 预览

/// 预览：模拟宿主——程序坞贴在底部，打开的 App 由宿主自己展示（这里只是一行文字），点「返回」把 active 设回 nil
private struct MagnifyDockPreviewHost: View {
    var layout: MagnifyDock.Layout = .auto
    @State private var active: String?
    @State private var title = ""

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            if active != nil {
                VStack(spacing: 12) {
                    Text("已打开「\(title)」").font(.headline)
                    Button("返回") { active = nil }
                }
                Spacer()
            }
            MagnifyDock(
                layout: layout,
                active: $active,
                onOpen: { item, _ in title = item.title },
                onClose: { _ in title = "" }
            )
            .padding(.bottom, 8)
        }
    }
}

#Preview("手机") {
    MagnifyDockPreviewHost()
}

#Preview("iPad", traits: .fixedLayout(width: 820, height: 600)) {
    MagnifyDockPreviewHost()
}

#Preview("桌面宽度（按住滑动放大）", traits: .fixedLayout(width: 1100, height: 400)) {
    MagnifyDockPreviewHost()
}

#Preview("自定义图标") {
    VStack {
        Spacer()
        MagnifyDock(
            items: [
                .init(title: "相机", systemImage: "camera.fill", colors: [Color(hex: "#C9CCD3"), Color(hex: "#5A5F6A")]),
                .init(title: "天气", systemImage: "cloud.sun.fill", colors: [Color(hex: "#7CC8FF"), Color(hex: "#1F6BFF")]),
                .init(title: "钱包", systemImage: "wallet.pass.fill", colors: [Color(hex: "#565A66"), Color(hex: "#16181D")]),
            ],
            layout: .desktop
        )
    }
    .padding(.bottom, 20)
}
