// 灵动岛（Dynamic Island）：黑色胶囊在空闲、播放音乐、来电、计时、通话之间弹性变形，宽高、圆角和里面的内容一起过渡；
// 轻点切到下一个状态，长按展开成完整播放器，来电可以接听或挂断。自动轮播会给手动操作让路（手动操作后先停 6 秒）。
//
// 原生端说明：
// - App 画不到系统真正的灵动岛上，这里是一个普通视图：宽度占满宿主给的宽度、岛居中，高度跟着岛变；
//   宿主放在哪儿就在哪儿，通常是 .overlay(alignment: .top) { DynamicIsland(...) }，展开时盖在内容上面。
// - 网页演示里的锁屏（壁纸、时间日期、手电筒 / 相机、状态栏、Home 条）不画。
// - 状态由宿主用 mode 绑定驱动（不传就组件自己管）；autoCycle 打开时组件按网页的节奏自动轮播，也会写回绑定。
//
// 动画说明：变形用网页同一条 motion 弹簧 { duration, bounce }（按 motion 的 findSpring 换算成 stiffness / damping）。
// 岛的宽高圆角用 Animatable 修饰器逐帧插值，里面的内容每帧都按岛的当前尺寸居中、顶对齐（和网页 left: calc(50% - w/2) 一样）。
import SwiftUI
import UIKit

public struct DynamicIsland: View {
    /// 岛的状态：空闲、音乐、来电、计时、通话中、展开的播放器
    public enum Mode: String, CaseIterable, Sendable {
        case idle, music, call, timer, oncall, expanded

        /// 轻点 / 自动轮播的下一个状态（和网页 NEXT 一致）
        public var next: Mode {
            switch self {
            case .idle: return .music
            case .music: return .call
            case .call: return .timer
            case .timer: return .idle
            case .oncall: return .idle
            case .expanded: return .music
            }
        }
    }

    /// 岛里显示的文案和数据（默认是网页演示的示例数据）
    public struct Content: Sendable {
        public var title: String
        public var artist: String
        public var callerName: String
        public var callerLabel: String
        public var callerAvatar: String
        /// 计时器起始秒数（倒数）
        public var timerSeconds: Int
        /// 播放器进度条两侧的时间
        public var elapsed: String
        public var remaining: String

        public init(
            title: String = "晚风与海",
            artist: String = "Zmotion Radio",
            callerName: String = "妈妈",
            callerLabel: String = "手机来电",
            callerAvatar: String = "👩🏻",
            timerSeconds: Int = 299,
            elapsed: String = "1:24",
            remaining: String = "-2:21"
        ) {
            self.title = title
            self.artist = artist
            self.callerName = callerName
            self.callerLabel = callerLabel
            self.callerAvatar = callerAvatar
            self.timerSeconds = timerSeconds
            self.elapsed = elapsed
            self.remaining = remaining
        }
    }

    private let mode: Binding<Mode>?
    private let bounce: Double
    private let duration: Double
    private let autoCycle: Bool
    private let accent: Color
    private let content: Content
    private let haptics: Bool
    private let onAccept: (() -> Void)?
    private let onDecline: (() -> Void)?
    private let onPlayingChange: ((Bool) -> Void)?
    private let onPrevious: (() -> Void)?
    private let onNext: (() -> Void)?

    @State private var internalMode: Mode = .idle
    @State private var pressing = false
    @State private var playing = true
    @State private var waveClock = DIWaveClock()
    @State private var availableWidth: CGFloat = 390
    @State private var box = DIBox()
    @GestureState private var touching = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - mode: 外部绑定的状态；不传则组件内部自己管理
    ///   - bounce: 变形时的回弹程度，0 为不回弹（0–0.6）
    ///   - duration: 一次变形大约用多久（秒，0.25–1.2），越小越干脆
    ///   - autoCycle: 不操作时每隔几秒自动切到下一个状态；手动点过之后会先停 6 秒
    ///   - accent: 声波、计时数字和进度条的颜色
    ///   - content: 歌名、来电人、计时起点等示例数据
    ///   - haptics: 切换 / 接听时的触感反馈（网页版的音效）
    ///   - onAccept: 来电点了接听（岛随后切到通话中）
    ///   - onDecline: 来电点了挂断（岛随后回到空闲）
    ///   - onPlayingChange: 播放器里点了播放 / 暂停
    ///   - onPrevious: 播放器里点了上一首
    ///   - onNext: 播放器里点了下一首
    public init(
        mode: Binding<Mode>? = nil,
        bounce: Double = 0.3,
        duration: Double = 0.55,
        autoCycle: Bool = true,
        accent: Color = Color(hex: "#FF9F0A"),
        content: Content = Content(),
        haptics: Bool = true,
        onAccept: (() -> Void)? = nil,
        onDecline: (() -> Void)? = nil,
        onPlayingChange: ((Bool) -> Void)? = nil,
        onPrevious: (() -> Void)? = nil,
        onNext: (() -> Void)? = nil
    ) {
        self.mode = mode
        self.bounce = bounce
        self.duration = duration
        self.autoCycle = autoCycle
        self.accent = accent
        self.content = content
        self.haptics = haptics
        self.onAccept = onAccept
        self.onDecline = onDecline
        self.onPlayingChange = onPlayingChange
        self.onPrevious = onPrevious
        self.onNext = onNext
    }

    private var current: Mode { mode?.wrappedValue ?? internalMode }

    public var body: some View {
        let m = current
        let s = DISize.of(m)
        // 和网页一样：岛最宽不超过可用宽度 - 20
        let w = Swift.max(0, Swift.min(s.w, Double(availableWidth) - 20))
        let spring = DISpring.find(duration: duration, bounce: reduceMotion ? 0 : bounce)
        let morph = Animation.motionSpring(stiffness: spring.stiffness, damping: spring.damping)
        let press: Animation = pressing ? .motionSpring(stiffness: 120, damping: 20) : .motionSpring(stiffness: 500, damping: 22)
        let ring = colorScheme == .dark ? Color.white.opacity(0.08) : Color.clear

        // 内容按目标尺寸排好（不做布局动画），由岛的外形逐帧裁切
        ZStack(alignment: .top) {
            modeContent(m)
                .frame(width: w, height: s.h)
                .id(m)
                .transition(contentTransition)
        }
        .frame(width: w, height: s.h, alignment: .top)
        .animation(morph) { $0.modifier(DIIslandShape(width: w, height: s.h, radius: s.r, ring: ring)) }
        .animation(press) { $0.scaleEffect(pressing ? 1.06 : 1) }
        .gesture(islandGesture(w: w, h: s.h))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(DISize.label(m, content))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { go(m.next) }
        .accessibilityAction(named: "展开") { go(.expanded) }
        .accessibilityAction(named: "收起") { go(.idle) }
        .frame(maxWidth: .infinity, alignment: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { availableWidth = $0 }
        .task(id: DICycleKey(auto: autoCycle, mode: m, pressing: pressing)) { await cycle(from: m) }
        .onChange(of: touching) { _, isTouching in
            // 手势被系统打断时 onEnded 不会触发，这里兜底（相当于 pointercancel）
            guard !isTouching, box.down else { return }
            box.down = false
            endPress()
        }
        .onChange(of: playing) { _, p in waveClock.set(playing: p) }
    }

    /* ---------- 内容切换：新内容淡入 + 放大 + 去模糊，旧内容很快淡出 ---------- */

    private var contentTransition: AnyTransition {
        let d = duration
        let insert = AnyTransition.modifier(
            active: DIFx(opacity: 0, scale: 0.86, blur: 8),
            identity: DIFx(opacity: 1, scale: 1, blur: 0)
        ).animation(.timingCurve(0.2, 0.8, 0.3, 1, duration: d * 0.6).delay(d * 0.18))
        let remove = AnyTransition.modifier(
            active: DIFx(opacity: 0, scale: 0.9, blur: 6),
            identity: DIFx(opacity: 1, scale: 1, blur: 0)
        ).animation(.easeOut(duration: Swift.min(0.16, d * 0.4)))
        return .asymmetric(insertion: insert, removal: remove)
    }

    @ViewBuilder
    private func modeContent(_ m: Mode) -> some View {
        switch m {
        case .idle:
            Color.clear
        case .music:
            HStack(spacing: 0) {
                DIArt(size: 25, radius: 7)
                Spacer(minLength: 0)
                DIWave(playing: playing, clock: waveClock, accent: accent)
            }
            .padding(.leading, 7)
            .padding(.trailing, 12)
        case .timer:
            DIClock(phone: false, from: content.timerSeconds, dir: -1, accent: accent)
        case .oncall:
            DIClock(phone: true, from: 0, dir: 1, accent: accent)
        case .call:
            callRow
        case .expanded:
            player
        }
    }

    private var callRow: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(LinearGradient(colors: [Color(hex: "#FFD1DC"), Color(hex: "#FF8FAB")], startPoint: .topLeading, endPoint: .bottomTrailing))
                Text(content.callerAvatar).font(.system(size: 26))
            }
            .frame(width: 46, height: 46)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(content.callerLabel)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.white.opacity(0.55))
                Text(content.callerName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            DIPressable(label: "挂断", pressedScale: 0.85, poke: poke) {
                onDecline?()
                go(.idle)
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(Circle().fill(Color(hex: "#FF3B30")))
            }
            DIPressable(label: "接听", pressedScale: 0.85, poke: poke) {
                Haptics.success(haptics)
                onAccept?()
                go(.oncall, feedback: false)
            } label: {
                Image(systemName: "phone.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(Circle().fill(Color(hex: "#30D158")))
            }
        }
        .padding(.horizontal, 15)
    }

    private var player: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                DIArt(size: 58, radius: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(content.title)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                    Text(content.artist)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.white.opacity(0.55))
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                DIWave(playing: playing, clock: waveClock, accent: accent)
            }
            Spacer(minLength: 0)
            HStack(spacing: 10) {
                Text(content.elapsed)
                DIProgress(playing: playing)
                Text(content.remaining)
            }
            .font(.system(size: 11).monospacedDigit())
            .foregroundStyle(Color.white.opacity(0.5))
            Spacer(minLength: 0)
            HStack(spacing: 34) {
                DIPressable(label: "上一首", pressedScale: 0.82, poke: poke) {
                    onPrevious?()
                } label: {
                    Image(systemName: "backward.end.fill").font(.system(size: 21)).frame(width: 40, height: 40)
                }
                DIPressable(label: playing ? "暂停" : "播放", pressedScale: 0.82, poke: poke) {
                    Haptics.tap(haptics)
                    playing.toggle()
                    onPlayingChange?(playing)
                } label: {
                    ZStack {
                        // 播放 / 暂停图标互换：旧的缩小淡出、新的放大淡入（spring 600 / 26）
                        Image(systemName: playing ? "pause.fill" : "play.fill")
                            .font(.system(size: 27))
                            .id(playing)
                            .transition(.scale(scale: 0.4).combined(with: .opacity))
                    }
                    .frame(width: 40, height: 40)
                    .animation(.motionSpring(stiffness: 600, damping: 26), value: playing)
                }
                DIPressable(label: "下一首", pressedScale: 0.82, poke: poke) {
                    onNext?()
                } label: {
                    Image(systemName: "forward.end.fill").font(.system(size: 21)).frame(width: 40, height: 40)
                }
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
        }
        .padding(.top, 20)
        .padding(.horizontal, 22)
        .padding(.bottom, 16)
    }

    /* ---------- 状态切换 ---------- */

    /// user = false 是自动轮播：不给触感，也不算「刚被人操作过」
    private func go(_ next: Mode, user: Bool = true, feedback: Bool = true) {
        if user { box.userAt = Date() }
        if let mode { mode.wrappedValue = next } else { internalMode = next }
        guard user, feedback else { return }
        switch next {
        case .call, .expanded: Haptics.pop(haptics)
        default: Haptics.tap(haptics)
        }
    }

    private func poke() { box.userAt = Date() }

    /// 自动轮播：在当前状态停 AUTO_DELAY 后切到下一个；刚被人操作过就顺延到满 6 秒
    private func cycle(from m: Mode) async {
        guard autoCycle, !pressing else { return }
        var wait = DISize.autoDelay(m)
        while true {
            try? await Task.sleep(for: .milliseconds(Int(wait)))
            if Task.isCancelled { return }
            let quiet = Date().timeIntervalSince(box.userAt) * 1000
            if quiet < DISize.userHold {
                wait = Swift.max(500, DISize.userHold - quiet)
                continue
            }
            go(m.next, user: false)
            return
        }
    }

    /* ---------- 轻点 / 长按 ---------- */

    private func islandGesture(w: Double, h: Double) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($touching) { _, state, _ in state = true }
            .onChanged { value in
                if !box.down {
                    box.down = true
                    box.left = false
                    pointerDown()
                } else if !box.left && !inside(value.location, w, h) {
                    // 手指滑出岛 = pointerleave：结束按压，不再算轻点
                    box.left = true
                    endPress()
                }
            }
            .onEnded { value in
                guard box.down else { return }
                box.down = false
                endPress()
                if box.longPressed {
                    box.longPressed = false
                    return
                }
                if !box.left && inside(value.location, w, h) { go(current.next) }
            }
    }

    private func inside(_ p: CGPoint, _ w: Double, _ h: Double) -> Bool {
        p.x >= -8 && p.y >= -8 && p.x <= w + 8 && p.y <= h + 8
    }

    private func pointerDown() {
        box.userAt = Date()
        box.longPressed = false
        pressing = true
        box.pressGen += 1
        let gen = box.pressGen
        // 按住 450ms 算长按：展开播放器（已展开则收回音乐）
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            guard box.pressGen == gen, box.down, !box.left else { return }
            box.longPressed = true
            pressing = false
            go(current == .expanded ? .music : .expanded)
        }
    }

    private func endPress() {
        box.pressGen += 1
        pressing = false
    }
}

/* ---------- 尺寸 / 节奏 / 无障碍文案（与网页一致） ---------- */

private enum DISize {
    static func of(_ m: DynamicIsland.Mode) -> (w: Double, h: Double, r: Double) {
        switch m {
        case .idle: return (126, 37, 19)
        case .music, .timer: return (210, 37, 19)
        case .oncall: return (196, 37, 19)
        case .call: return (360, 74, 37)
        case .expanded: return (360, 186, 46)
        }
    }

    static func autoDelay(_ m: DynamicIsland.Mode) -> Double {
        switch m {
        case .idle: return 1600
        case .music: return 2600
        case .call: return 3200
        case .timer, .oncall: return 3000
        case .expanded: return 4200
        }
    }

    /// 手动操作后，自动轮播至少歇这么久，不和人抢
    static let userHold: Double = 6000

    static func label(_ m: DynamicIsland.Mode, _ c: DynamicIsland.Content) -> String {
        switch m {
        case .idle: return "灵动岛，轻点切换状态，长按展开"
        case .music: return "正在播放：\(c.title)"
        case .call: return "来电：\(c.callerName)"
        case .timer: return "计时器"
        case .oncall: return "通话中"
        case .expanded: return "播放器"
        }
    }
}

private struct DICycleKey: Hashable {
    let auto: Bool
    let mode: DynamicIsland.Mode
    let pressing: Bool
}

/// 不参与渲染的手势状态（改它不触发重绘）
@MainActor
private final class DIBox {
    var userAt = Date.distantPast
    var longPressed = false
    var down = false
    var left = false
    var pressGen = 0
}

/* ---------- 岛的外形：宽高圆角逐帧插值，内容每帧重新居中 ---------- */

private struct DIIslandShape: ViewModifier, Animatable {
    var width: Double
    var height: Double
    var radius: Double
    let ring: Color

    nonisolated var animatableData: AnimatablePair<Double, AnimatablePair<Double, Double>> {
        get { AnimatablePair(width, AnimatablePair(height, radius)) }
        set {
            width = newValue.first
            height = newValue.second.first
            radius = newValue.second.second
        }
    }

    func body(content: Content) -> some View {
        let w = Swift.max(0, width), h = Swift.max(0, height)
        let r = Swift.min(Swift.max(0, radius), Swift.min(w, h) / 2)
        let shape = RoundedRectangle(cornerRadius: r, style: .circular)
        content
            .frame(width: w, height: h, alignment: .top)
            .background(Color.black)
            .clipShape(shape)
            // box-shadow: 0 0 0 1px var(--ring)（深色模式下一圈很淡的白边）
            .background(RoundedRectangle(cornerRadius: r + 1, style: .circular).fill(ring).padding(-1))
            .contentShape(shape)
    }
}

/// 内容进出场：透明度 + 缩放 + 模糊
private struct DIFx: ViewModifier {
    let opacity: Double
    let scale: Double
    let blur: Double
    func body(content: Content) -> some View {
        content.opacity(opacity).scaleEffect(scale).blur(radius: blur)
    }
}

/* ---------- 封面：conic-gradient(from 210deg, …) ---------- */

private struct DIArt: View {
    let size: Double
    let radius: Double
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .circular)
        // CSS 的 conic 从 12 点钟方向起算，SwiftUI 的 AngularGradient 从 3 点钟起算，差 90°
        shape
            .fill(AngularGradient(
                colors: ["#FF9A62", "#FF3D7F", "#7B5CFF", "#3EC5FF", "#FF9A62"].map { Color(hex: $0) },
                center: .center,
                startAngle: .degrees(120),
                endAngle: .degrees(480)
            ))
            .overlay(shape.strokeBorder(Color.white.opacity(0.2), lineWidth: 0.5))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/* ---------- 声波：5 根竖条 scaleY 0.25 ↔ 1，0.9s ease-in-out 往返，依次错开 0.17s；暂停时停在原处 ---------- */

/// 可暂停的时钟（相当于 animation-play-state: paused）
private struct DIWaveClock {
    var accumulated: Double = 0
    var anchor: Date? = Date()

    func time(at date: Date) -> Double {
        accumulated + (anchor.map { date.timeIntervalSince($0) } ?? 0)
    }

    mutating func set(playing: Bool) {
        let now = Date()
        if playing {
            if anchor == nil { anchor = now }
        } else if let a = anchor {
            accumulated += now.timeIntervalSince(a)
            anchor = nil
        }
    }
}

private struct DIWave: View {
    let playing: Bool
    let clock: DIWaveClock
    let accent: Color
    private static let heights: [Double] = [0.5, 0.9, 0.65, 1, 0.55]

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: !playing)) { ctx in
            let t = clock.time(at: ctx.date)
            HStack(spacing: 2.5) {
                ForEach(0..<5, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(accent)
                        .frame(width: 3, height: 16 * Self.heights[i])
                        .scaleEffect(x: 1, y: Self.scale(t + Double(i) * 0.17), anchor: .center)
                }
            }
            .frame(height: 16)
        }
        .accessibilityHidden(true)
    }

    private static func scale(_ t: Double) -> Double {
        let period = 0.9
        let cycle = floor(t / period)
        var p = t / period - cycle
        // alternate：奇数轮倒着播，缓动也跟着倒过来
        if Int(cycle) % 2 != 0 { p = 1 - p }
        return 0.25 + 0.75 * diCubicBezier(0.42, 0, 0.58, 1, p)
    }
}

/* ---------- 计时 / 通话：每秒一跳，数字上下滚动换位 ---------- */

private struct DIClock: View {
    let phone: Bool
    let from: Int
    let dir: Int
    let accent: Color
    @State private var t: Int

    init(phone: Bool, from: Int, dir: Int, accent: Color) {
        self.phone = phone
        self.from = from
        self.dir = dir
        self.accent = accent
        _t = State(initialValue: from)
    }

    var body: some View {
        let green = Color(hex: "#30D158")
        let tint = phone ? green : accent
        let text = "\(t / 60):" + String(format: "%02d", t % 60)
        let up: CGFloat = dir < 0 ? -10 : 10
        HStack(spacing: 0) {
            Image(systemName: phone ? "phone.fill" : "timer")
                .font(.system(size: phone ? 11 : 13, weight: .bold))
                .foregroundStyle(tint)
                .frame(width: 24, height: 24)
                .background(Circle().fill(tint.opacity(phone ? 0.22 : 0.25)))
            Spacer(minLength: 0)
            ZStack(alignment: .trailing) {
                Text(text)
                    .id(text)
                    .transition(.asymmetric(
                        insertion: .modifier(active: DIRoll(y: up, opacity: 0, blur: 2), identity: DIRoll(y: 0, opacity: 1, blur: 0)),
                        removal: .modifier(active: DIRoll(y: -up, opacity: 0, blur: 2), identity: DIRoll(y: 0, opacity: 1, blur: 0))
                    ))
            }
            .font(.system(size: 17, weight: .semibold).monospacedDigit())
            .foregroundStyle(tint)
            .frame(minWidth: 54, alignment: .trailing)
            .animation(.motionSpring(stiffness: 500, damping: 34), value: text)
        }
        .padding(.leading, 12)
        .padding(.trailing, 16)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
                t = Swift.max(0, t + dir)
            }
        }
    }
}

private struct DIRoll: ViewModifier {
    let y: CGFloat
    let opacity: Double
    let blur: CGFloat
    func body(content: Content) -> some View {
        content.offset(y: y).opacity(opacity).blur(radius: blur)
    }
}

/* ---------- 播放器进度条：播放时 12s 线性走到 42%，暂停时 0.3s 回到 30%（与网页一致） ---------- */

private struct DIProgress: View {
    let playing: Bool
    @State private var fill = 0.3

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.18))
                Capsule().fill(Color.white).frame(width: geo.size.width * fill)
            }
        }
        .frame(height: 5)
        .clipShape(Capsule())
        .onAppear { run(playing) }
        .onChange(of: playing) { _, p in run(p) }
    }

    private func run(_ p: Bool) {
        withAnimation(.linear(duration: p ? 12 : 0.3)) { fill = p ? 0.42 : 0.3 }
    }
}

/* ---------- 岛里的小按钮：按下缩小（whileTap），自己吃掉手势，不会再触发岛的轻点 ---------- */

private struct DIPressable<Label: View>: View {
    let label: String
    let pressedScale: Double
    let poke: () -> Void
    let action: () -> Void
    let content: Label
    @State private var down = false
    @GestureState private var touching = false

    init(label: String, pressedScale: Double, poke: @escaping () -> Void, action: @escaping () -> Void, @ViewBuilder label content: () -> Label) {
        self.label = label
        self.pressedScale = pressedScale
        self.poke = poke
        self.action = action
        self.content = content()
    }

    var body: some View {
        content
            .contentShape(Rectangle())
            // motion 的 whileTap 默认弹簧：stiffness 500 / damping 25
            .scaleEffect(down ? pressedScale : 1)
            .animation(.motionSpring(stiffness: 500, damping: 25), value: down)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .updating($touching) { _, s, _ in s = true }
                    .onChanged { _ in
                        if !down {
                            down = true
                            poke()
                        }
                    }
                    .onEnded { v in
                        down = false
                        poke()
                        if abs(v.translation.width) < 30 && abs(v.translation.height) < 30 { action() }
                    }
            )
            .onChange(of: touching) { _, t in if !t { down = false } }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { poke(); action() }
    }
}

/* ---------- 工具：CSS cubic-bezier、motion 的 findSpring ---------- */

/// CSS cubic-bezier(x1, y1, x2, y2) 在进度 x 处的值（二分求 t）
private func diCubicBezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double) -> Double {
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

/// motion 的 { type: "spring", duration, bounce }：duration 是「停稳时间」，按 motion-dom 的 findSpring 换算成物理参数
private enum DISpring {
    static func find(duration durationSec: Double, bounce: Double) -> (stiffness: Double, damping: Double) {
        let safeMin = 0.001
        let ratio = Swift.max(1 - bounce, 0.05)
        let duration = Swift.min(10, Swift.max(0.01, durationSec))
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
        return (stiffness, damping)
    }
}

/* ---------- 预览 ---------- */

private struct DynamicIslandPreviewHost: View {
    @State private var mode: DynamicIsland.Mode = .idle
    var body: some View {
        ZStack(alignment: .top) {
            LinearGradient(colors: [Color(hex: "#FFD6C9"), Color(hex: "#E5D4FF"), Color(hex: "#C7E3FF")], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 12) {
                Spacer()
                Text("当前：\(mode.rawValue)").font(.footnote.monospaced())
                HStack {
                    ForEach(DynamicIsland.Mode.allCases, id: \.self) { m in
                        Button(m.rawValue) { mode = m }.font(.caption)
                    }
                }
            }
            .padding(.bottom, 40)
        }
        .overlay(alignment: .top) {
            DynamicIsland(mode: $mode)
                .padding(.top, 11)
        }
    }
}

#Preview("手机") {
    DynamicIslandPreviewHost()
}

#Preview("深色 / 果冻") {
    ZStack(alignment: .top) {
        Color(hex: "#0D0B1A").ignoresSafeArea()
        DynamicIsland(bounce: 0.55, duration: 0.8, accent: Color(hex: "#FF375F"))
            .padding(.top, 11)
    }
    .preferredColorScheme(.dark)
}

#Preview("iPad", traits: .fixedLayout(width: 820, height: 600)) {
    DynamicIslandPreviewHost()
}
