// 下拉刷新（React Native 版）：在内容顶部继续往下拉，越拉越沉的橡皮筋阻尼；指示器跟着画出进度，
// 过了阈值松手就停在 64px 处转圈，刷新结束后打勾，新内容从顶部展开、列表弹回原位。刷新中也能照常滚动。
//
// 原生端只保留可复用的「下拉刷新容器」：网页演示里的假状态栏、「动态」大标题行（副标题、刷新按钮、分隔线）都不画，
// 由宿主的导航栏提供；标题栏刷新按钮的能力换成 refreshTrigger（宿主自己的按钮把它加一即可：先回顶再刷新）。
// 网页 iPad / 桌面的「左列表 + 右详情」两栏是演示内容，不属于组件（宿主自己拼两栏，左栏放这个组件即可）。
// 内容由宿主作为 children 传入，刷新走 onRefresh（返回 Promise 或调用 done 时结束）；不传 children 时显示示例动态。
//
// 动效说明：和网站版一样，列表位置 y 由组件自己驱动（不是 ScrollView），阻尼系数、阈值、刷新中停住的高度都和网页一致——
// 拖动时 iOS 式橡皮筋 (1 - 1 / (x·阻尼 / dim + 1))·dim（dim = max(视口高, 520)），上下两端都有；
// 松手后越界的用弹簧 380 / 38 回到边界，界内的按 motion 的 inertia（power 0.8、timeConstant 325ms，越界换成 400 / 40 弹簧）惯性滑动；
// 刷新中「顶」变成 64，回顶弹簧 380 / 38（从很深处回来用 170 / 26），完成后延迟 0.32s 用 300 / 34 弹回 0。
// 弹簧和惯性都用 defineAnimation 自己逐帧求解析解（和 motion 同一套公式、mass 固定 1），全部跑在 UI 线程，随时能被手指接住。
// 注意：内容整块排版（不是虚拟列表），适合信息流这类几十到几百条的列表。
//
// 依赖：react-native-reanimated（≥ 3）+ react-native-gesture-handler（≥ 2）。网站版的音效没有对应（不引入额外依赖）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View, useColorScheme, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  LayoutAnimationConfig,
  ReduceMotion,
  cancelAnimation,
  defineAnimation,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type AnimationObject,
  type DerivedValue,
  type EntryExitAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

export type PullToRefreshProps = {
  /** 触发阈值（px）：列表被拉下这么多（阻尼后的距离）松手才会刷新（50–140） */
  threshold?: number;
  /** 阻尼系数：橡皮筋的松紧，越小越拉不动。iOS 系统值约 0.55（0.3–1） */
  resistance?: number;
  /** 指示器：下拉时显示的进度样式（圆弧 / 菊花 / 箭头） */
  indicator?: "arc" | "ios" | "arrow";
  /** 指示器和新内容高亮的颜色 */
  color?: string;
  /**
   * 刷新回调。返回 Promise 时等它结束（成功失败都算）；不返回 Promise 但声明了 done 参数时，等你调用 done()；
   * 两者都不是就立刻结束。不传时模拟 1.2 秒。
   */
  onRefresh?: (done: () => void) => Promise<unknown> | void;
  /** 每次变化就像点了网页标题栏上的刷新按钮：先回到顶部，再停住转圈刷新 */
  refreshTrigger?: number;
  /** 要下拉刷新的整块内容（组件负责滚动，不要再包 ScrollView）；不传时显示示例动态 */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** 刷新时列表停在这个高度，给指示器留位置 */
const HOLD = 64;
/** 按下后挪动不超过这么多算点按，交给内容里的按钮 */
const TAP_SLOP = 6;

// 弹簧和网站版 motion 的 { stiffness, damping }（mass 1）一一对应
type Spec = { stiffness: number; damping: number; restDelta?: number };
/** 回弹：接近临界阻尼，像 iOS 列表一样干脆落位，不来回晃 */
const SETTLE: Spec = { stiffness: 380, damping: 38, restDelta: 0.2 };
/** 点刷新时已经滚得很深（y < -200）：慢一点的回顶弹簧 */
const FAR: Spec = { stiffness: 170, damping: 26 };
/** 刷新完成后弹回 0（延迟 0.32s，让新内容先展开） */
const BACK: Spec = { stiffness: 300, damping: 34, restDelta: 0.2 };
/** 惯性滑出边界时的回弹 */
const BOUNCE: Spec = { stiffness: 400, damping: 40, restDelta: 0.5 };
/** 指示器图标的小回弹（armed 放大、箭头翻转、打勾弹出） */
const POP: Spec = { stiffness: 520, damping: 22 };
/** 新动态撑开高度 */
const EXPAND: Spec = { stiffness: 320, damping: 34 };
/** 新动态卡片从 0.96、-8 落位 */
const LAND: Spec = { stiffness: 380, damping: 26 };

const NEVER = ReduceMotion.Never;
/** cubic-bezier(0.33, 0.55, 0.2, 1) */
const SWAP_EASE = Easing.bezier(0.33, 0.55, 0.2, 1);
/** motion 默认的 easeInOut */
const EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1);
/** CSS ease-out */
const EASE_OUT = Easing.bezier(0, 0, 0.58, 1);

const IDLE = 0;
const ARMED = 1;
const REFRESHING = 2;
const DONE = 3;
type Phase = typeof IDLE | typeof ARMED | typeof REFRESHING | typeof DONE;
const LABEL: Record<Phase, string> = { 0: "下拉刷新", 1: "松手刷新", 2: "正在刷新", 3: "已更新" };

type Palette = { card: string; fg: string; muted: string; line: string; track: string };
// 来自 style.css；页面底色 --bg 不铺，背景跟随宿主
const LIGHT: Palette = { card: "#ffffff", fg: "#111111", muted: "#8a8a8e", line: "rgba(0,0,0,0.06)", track: "rgba(0,0,0,0.08)" };
const DARK: Palette = { card: "#1c1c1e", fg: "#f5f5f7", muted: "#8a8a8e", line: "rgba(255,255,255,0.06)", track: "rgba(255,255,255,0.12)" };

function clamp(v: number, lo: number, hi: number) {
  "worklet";
  return Math.min(hi, Math.max(lo, v));
}

/** #RRGGBB → rgba(r,g,b,a) */
function rgba(hex: string, a: number) {
  let s = hex.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const v = parseInt(s.slice(0, 6), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/* ---------- 和 motion 一致的弹簧 / 惯性 ---------- */

/** 弹簧解析解（mass 1）：t 秒时的 [位置, 速度（单位/秒）] */
function solve(s: Spec, from: number, to: number, v0: number, t: number): [number, number] {
  "worklet";
  const k = s.stiffness;
  const w0 = Math.sqrt(k);
  const zeta = s.damping / (2 * Math.sqrt(k));
  // e：离终点还差多少；e(0) = to - from，e'(0) = -v0
  const d = to - from;
  let e: number;
  let de: number;
  if (Math.abs(zeta - 1) < 1e-6) {
    const C = w0 * d - v0;
    const ex = Math.exp(-w0 * t);
    e = ex * (d + C * t);
    de = ex * (C - w0 * (d + C * t));
  } else if (zeta < 1) {
    const a = zeta * w0;
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const B = (a * d - v0) / wd;
    const ex = Math.exp(-a * t);
    const cs = Math.cos(wd * t);
    const sn = Math.sin(wd * t);
    e = ex * (d * cs + B * sn);
    de = ex * (-a * (d * cs + B * sn) + wd * (B * cs - d * sn));
  } else {
    const wd = w0 * Math.sqrt(zeta * zeta - 1);
    const slow = zeta * w0 - wd;
    const fast = zeta * w0 + wd;
    const C1 = (fast * d - v0) / (fast - slow);
    const C2 = d - C1;
    e = C1 * Math.exp(-slow * t) + C2 * Math.exp(-fast * t);
    de = -slow * C1 * Math.exp(-slow * t) - fast * C2 * Math.exp(-fast * t);
  }
  return [to - e, -de];
}

interface SpringAnim extends AnimationObject<number> {
  from: number;
  target: number;
  v0: number;
  velocity: number;
  begin: number;
  rd: number;
  rs: number;
}

/**
 * 和 motion 的 animate(value, to, { type: "spring", stiffness, damping, mass: 1, velocity, delay, restDelta }) 一样：
 * velocity 为 null 时继承被打断动画的速度；delay 期间停在起点。
 */
function springTo(to: number, spec: Spec, velocity: number | null = null, delayMs = 0): number {
  "worklet";
  return defineAnimation<SpringAnim>(to, () => {
    "worklet";
    const onStart = (a: SpringAnim, value: number, now: number, prev: { velocity?: unknown } | null | undefined) => {
      a.from = value;
      a.target = to;
      a.current = value;
      a.begin = now + delayMs;
      const inherited = prev && typeof prev.velocity === "number" ? prev.velocity : 0;
      a.v0 = velocity === null ? inherited : velocity;
      a.velocity = delayMs > 0 ? 0 : a.v0;
      // motion 的默认收尾阈值：变化量很小（< 5，比如进度、缩放）时用更细的阈值
      const granular = Math.abs(to - value) < 5;
      a.rd = spec.restDelta ?? (granular ? 0.005 : 0.5);
      a.rs = granular ? 0.01 : 2;
    };
    const onFrame = (a: SpringAnim, now: number): boolean => {
      const t = (now - a.begin) / 1000;
      if (t <= 0) {
        a.current = a.from;
        return false;
      }
      const [x, v] = solve(spec, a.from, a.target, a.v0, t);
      const done = Math.abs(a.target - x) <= a.rd && Math.abs(v) <= a.rs;
      a.current = done ? a.target : x;
      a.velocity = done ? 0 : v;
      return done;
    };
    return {
      onStart,
      onFrame,
      toValue: to,
      current: to,
      from: to,
      target: to,
      v0: 0,
      velocity: 0,
      begin: 0,
      rd: 0.5,
      rs: 2,
      // 组件自己决定动效，不让 Reanimated 在「减弱动态效果」时直接跳到终点（网页版也没有区分）
      reduceMotion: false,
    } as unknown as SpringAnim;
  }) as unknown as number;
}

interface InertiaAnim extends AnimationObject<number> {
  amp: number;
  target: number;
  begin: number;
  velocity: number;
  bouncing: boolean;
  bFrom: number;
  bTo: number;
  bV0: number;
  bBegin: number;
}

/** motion 的 inertia：amplitude = 0.8·v，x(t) = target - amplitude·e^(-t/325ms)；越界后换成 400 / 40 的弹簧拉回边界 */
function inertia(velocity: number, lo: number, hi: number): number {
  "worklet";
  return defineAnimation<InertiaAnim>(0, () => {
    "worklet";
    const onStart = (a: InertiaAnim, value: number, now: number) => {
      a.amp = 0.8 * velocity;
      a.target = value + a.amp;
      a.begin = now;
      a.current = value;
      a.velocity = velocity;
      a.bouncing = false;
      if (value < lo || value > hi) {
        a.bouncing = true;
        a.bFrom = value;
        a.bTo = value < lo ? lo : hi;
        a.bV0 = velocity;
        a.bBegin = now;
      }
    };
    const onFrame = (a: InertiaAnim, now: number): boolean => {
      if (a.bouncing) {
        const [x, v] = solve(BOUNCE, a.bFrom, a.bTo, a.bV0, (now - a.bBegin) / 1000);
        const rs = Math.abs(a.bTo - a.bFrom) < 5 ? 0.01 : 2;
        const done = Math.abs(a.bTo - x) <= 0.5 && Math.abs(v) <= rs;
        a.current = done ? a.bTo : x;
        a.velocity = done ? 0 : v;
        return done;
      }
      const decay = Math.exp(-(now - a.begin) / 325);
      const delta = -a.amp * decay;
      const done = Math.abs(delta) <= 0.5;
      const x = done ? a.target : a.target + delta;
      const v = (a.amp / 325) * decay * 1000;
      a.current = x;
      a.velocity = done ? 0 : v;
      if (x < lo || x > hi) {
        a.bouncing = true;
        a.bFrom = x;
        a.bTo = Math.abs(lo - x) < Math.abs(hi - x) ? lo : hi;
        a.bV0 = v;
        a.bBegin = now;
        return false;
      }
      return done;
    };
    return {
      onStart,
      onFrame,
      toValue: 0,
      current: 0,
      amp: 0,
      target: 0,
      begin: 0,
      velocity: 0,
      bouncing: false,
      bFrom: 0,
      bTo: 0,
      bV0: 0,
      bBegin: 0,
      reduceMotion: false,
    } as unknown as InertiaAnim;
  }) as unknown as number;
}

/* ---------- 组件 ---------- */

export function PullToRefresh({
  threshold = 80,
  resistance = 0.55,
  indicator = "arc",
  color = "#0A84FF",
  onRefresh,
  refreshTrigger,
  children,
  style,
}: PullToRefreshProps) {
  const pal = useColorScheme() === "dark" ? DARK : LIGHT;
  const sampleMode = children === undefined || children === null;
  const [phase, setPhase] = useState<Phase>(IDLE);
  // 示例动态（只在没传 children 时用）
  const [posts, setPosts] = useState<Post[]>(SEED);
  const [freshId, setFreshId] = useState(0);

  // 列表的位移：> 0 是被拉下来，< 0 是往上滚进内容
  const y = useSharedValue(0);
  const phaseSV = useSharedValue<number>(IDLE);
  const thr = useSharedValue(Math.max(1, threshold));
  const res = useSharedValue(clamp(resistance, 0.05, 1));
  const vpH = useSharedValue(0);
  const contentH = useSharedValue(0);
  // 拖动状态：startRaw 是按下时手指对应的「原始」位置（去掉橡皮筋），t0 是手势认出时的位移（扣掉点按容差，列表不跳）
  const dragging = useSharedValue(false);
  const startRaw = useSharedValue(0);
  const t0 = useSharedValue(0);
  const lastT = useSharedValue(0);
  const dMax = useSharedValue(0);
  const dDim = useSharedValue(600);

  useEffect(() => {
    thr.value = Math.max(1, threshold);
    res.value = clamp(resistance, 0.05, 1);
  }, [threshold, resistance, thr, res]);

  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const sampleRef = useRef(sampleMode);
  sampleRef.current = sampleMode;
  const mounted = useRef(true);
  const token = useRef(0);
  const nextId = useRef(100);
  const timers = useRef<{ idle?: ReturnType<typeof setTimeout>; fake?: ReturnType<typeof setTimeout> }>({});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timers.current.idle);
      clearTimeout(timers.current.fake);
    };
  }, []);

  // ---------- UI 线程上的逻辑 ----------

  // iOS 式橡皮筋：越拉越沉，永远拉不到 dim
  const rubber = (over: number, dim: number) => {
    "worklet";
    return (1 - 1 / ((over * res.value) / dim + 1)) * dim;
  };
  const unrubber = (d: number, dim: number) => {
    "worklet";
    return (dim / res.value) * (1 / (1 - Math.min(d, dim - 1) / dim) - 1);
  };
  /** 橡皮筋的斜率：把手指速度换算成列表速度 */
  const slope = (over: number, dim: number) => {
    "worklet";
    const q = (over * res.value) / dim + 1;
    return res.value / (q * q);
  };
  /** 刷新中列表的「顶」是 HOLD，平时是 0 */
  const top = () => {
    "worklet";
    return phaseSV.value === REFRESHING ? HOLD : 0;
  };
  const maxScroll = () => {
    "worklet";
    return Math.max(0, contentH.value - vpH.value);
  };
  const setPhaseUI = (p: Phase) => {
    "worklet";
    phaseSV.value = p;
    runOnJS(setPhase)(p);
  };

  const settle = (vel: number) => {
    "worklet";
    const cur = y.value;
    const t = top();
    const mx = maxScroll();
    if (cur > t) y.value = springTo(t, SETTLE, vel);
    else if (cur < -mx) y.value = springTo(-mx, SETTLE, vel);
    else y.value = inertia(vel, -mx, t);
  };

  const refreshUI = (vel: number | null) => {
    "worklet";
    if (phaseSV.value === REFRESHING) return;
    setPhaseUI(REFRESHING);
    // 就算已经滚进内容里，也先回到顶部再刷新
    if (!dragging.value) y.value = springTo(HOLD, y.value < -200 ? FAR : SETTLE, vel);
    runOnJS(startRefresh)();
  };

  const finishUI = () => {
    "worklet";
    setPhaseUI(DONE);
    if (dragging.value) {
      // 手指还按着：「顶」从 HOLD 变回 0，换算一下起点，列表不跳
      const cur = y.value;
      const raw = cur > 0 ? unrubber(cur, dDim.value) : cur;
      startRaw.value = raw - (lastT.value - t0.value);
    } else if (y.value > 0) {
      y.value = springTo(0, BACK, null, 320);
    }
  };

  const idleUI = () => {
    "worklet";
    if (phaseSV.value === DONE) setPhaseUI(IDLE);
  };

  // ---------- JS 线程：调宿主的 onRefresh ----------

  function insertSample() {
    const src = INCOMING[nextId.current % INCOMING.length];
    const id = nextId.current++;
    setPosts((list) => [{ ...src, id, time: "刚刚" }, ...list]);
    setFreshId(id);
  }

  function startRefresh() {
    const my = ++token.current;
    let finished = false;
    clearTimeout(timers.current.idle);
    const done = () => {
      if (finished || my !== token.current || !mounted.current) return;
      finished = true;
      // 示例内容：新动态和打勾在同一帧出现
      if (sampleRef.current) insertSample();
      runOnUI(finishUI)();
      clearTimeout(timers.current.idle);
      timers.current.idle = setTimeout(() => runOnUI(idleUI)(), 1300);
    };
    const fn = onRefreshRef.current;
    if (!fn) {
      timers.current.fake = setTimeout(done, 1200);
      return;
    }
    try {
      const r = fn(done);
      if (r && typeof (r as PromiseLike<unknown>).then === "function") (r as PromiseLike<unknown>).then(done, done);
      else if (fn.length === 0) done();
    } catch {
      done();
    }
  }

  // 宿主的刷新按钮：refreshTrigger 每变一次刷新一次（首次挂载不算）
  const lastTrigger = useRef(refreshTrigger);
  useEffect(() => {
    if (refreshTrigger === lastTrigger.current) return;
    lastTrigger.current = refreshTrigger;
    runOnUI(refreshUI)(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  // 视口变高 / 内容变矮：已经滚过新的底部就弹回底部，不留空白
  useAnimatedReaction(
    () => Math.max(0, contentH.value - vpH.value),
    (mx, prev) => {
      if (prev === null || dragging.value) return;
      if (y.value < -mx - 1) y.value = springTo(-mx, SETTLE);
    },
  );

  // ---------- 手势：整个容器只挂一个 Pan ----------

  const pan = Gesture.Pan()
    // 竖向挪过 6px 才算拖动；之前的点按交给内容里的按钮，横向拖动留给内容里的横滑列表
    .activeOffsetY([-TAP_SLOP, TAP_SLOP])
    .onBegin(() => {
      // 按下就停住正在惯性滑动 / 回弹的列表（和网页 pointerdown 一样），松手再落位
      if (!dragging.value) cancelAnimation(y);
    })
    .onStart((e) => {
      const cur = y.value;
      const t = top();
      const mx = maxScroll();
      const dm = Math.max(vpH.value, 520);
      let raw = cur;
      if (cur > t) raw = t + unrubber(cur - t, dm);
      else if (cur < -mx) raw = -mx - unrubber(-mx - cur, dm);
      startRaw.value = raw;
      t0.value = e.translationY;
      lastT.value = e.translationY;
      dMax.value = mx;
      dDim.value = dm;
      dragging.value = true;
    })
    .onUpdate((e) => {
      if (!dragging.value) return;
      lastT.value = e.translationY;
      const raw = startRaw.value + (e.translationY - t0.value);
      const t = top();
      const mx = dMax.value;
      const dm = dDim.value;
      let v = raw;
      if (raw > t) v = t + rubber(raw - t, dm);
      else if (raw < -mx) v = -mx - rubber(-mx - raw, dm);
      y.value = v;
      const p = phaseSV.value;
      if (p === REFRESHING) return;
      const armed = v >= thr.value;
      if (armed && p !== ARMED) setPhaseUI(ARMED);
      else if (!armed && p === ARMED) setPhaseUI(IDLE);
    })
    .onFinalize((e) => {
      if (!dragging.value) {
        // 只是按了一下：被停住的列表接着落位
        settle(0);
        return;
      }
      dragging.value = false;
      // 橡皮筋区域里列表比手指慢，按斜率换算离手速度
      const raw = startRaw.value + (lastT.value - t0.value);
      const t = top();
      const mx = dMax.value;
      const dm = dDim.value;
      let vel = e.velocityY;
      if (raw > t) vel *= slope(raw - t, dm);
      else if (raw < -mx) vel *= slope(-mx - raw, dm);
      if (phaseSV.value === ARMED) refreshUI(vel);
      else settle(vel);
    });

  // ---------- 样式 ----------

  const progress = useDerivedValue(() => clamp(y.value / thr.value, 0, 1));
  // 指示器垫在内容下面，只在内容被拉开的那一截里露出来（网页是列表自带底色盖住它）
  const revealStyle = useAnimatedStyle(() => ({ height: Math.max(0, y.value) }));
  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: clamp((y.value - 6) / 30, 0, 1),
    // 指示器始终在拉开的那一截正中间
    transform: [{ translateY: Math.max(0, y.value) / 2 - HOLD / 2 }],
  }));
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: 0.6 + 0.4 * progress.value }] }));
  const listStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  const label = phase === DONE && sampleMode ? "已更新 1 条" : LABEL[phase];
  const icon =
    phase === DONE ? (
      <DoneCheck color={color} />
    ) : indicator === "ios" ? (
      <IosSpinner spinning={phase === REFRESHING} progress={progress} color={color} />
    ) : phase === REFRESHING ? (
      <SpinningArc color={color} track={pal.track} />
    ) : indicator === "arrow" ? (
      <ArrowIcon armed={phase === ARMED} progress={progress} color={color} />
    ) : (
      <ProgressArc armed={phase === ARMED} progress={progress} color={color} track={pal.track} />
    );

  return (
    <GestureHandlerRootView style={[styles.root, style]}>
      <GestureDetector gesture={pan}>
        <View
          style={styles.viewport} // 不铺底色：背景跟随宿主 App
          onLayout={(e: LayoutChangeEvent) => {
            vpH.value = e.nativeEvent.layout.height;
          }}
          accessibilityActions={[{ name: "refresh", label: "刷新" }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "refresh") runOnUI(refreshUI)(null);
          }}
        >
          <Animated.View pointerEvents="none" style={[styles.reveal, revealStyle]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <Animated.View style={[styles.indicator, indicatorStyle]}>
              <Animated.View style={[styles.box, iconStyle]}>{icon}</Animated.View>
              <PhaseLabel text={label} color={pal.muted} />
            </Animated.View>
          </Animated.View>
          <Animated.View
            style={[styles.list, listStyle]}
            onLayout={(e: LayoutChangeEvent) => {
              contentH.value = e.nativeEvent.layout.height;
            }}
          >
            {sampleMode ? <SampleFeed posts={posts} freshId={freshId} color={color} pal={pal} /> : children}
          </Animated.View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

/* ---------- 状态文字：旧的往上淡出、新的从下面淡入（0.2s） ---------- */

const labelIn: EntryExitAnimationFunction = () => {
  "worklet";
  const cfg = { duration: 200, easing: SWAP_EASE, reduceMotion: NEVER };
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 8 }] },
    animations: { opacity: withTiming(1, cfg), transform: [{ translateY: withTiming(0, cfg) }] },
  };
};

const labelOut: EntryExitAnimationFunction = () => {
  "worklet";
  const cfg = { duration: 200, easing: SWAP_EASE, reduceMotion: NEVER };
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: { opacity: withTiming(0, cfg), transform: [{ translateY: withTiming(-8, cfg) }] },
  };
};

function PhaseLabel({ text, color }: { text: string; color: string }) {
  return (
    <View style={styles.label}>
      <LayoutAnimationConfig skipEntering>
        <Animated.Text key={text} entering={labelIn} exiting={labelOut} numberOfLines={1} style={[styles.labelText, { color }]}>
          {text}
        </Animated.Text>
      </LayoutAnimationConfig>
    </View>
  );
}

/* ---------- 指示器（网页是 28 × 28 的 SVG，这里用 View 拼） ---------- */

type Progress = DerivedValue<number> | SharedValue<number>;

/**
 * 圆环上的彩色弧（r = 10、线宽 3、圆头），从 12 点顺时针画 frac 圈。
 * 做法：左右各一个只露半边的裁切框，里面放「上 + 右两条边着色」的圆环（转 45° 正好是右半圆），按弧长转到位；两端补圆点当圆头。
 */
function ArcStroke({ frac, color }: { frac: Progress; color: string }) {
  const right = useAnimatedStyle(() => ({ transform: [{ rotate: `${45 + Math.min(frac.value * 360, 180) - 180}deg` }] }));
  const left = useAnimatedStyle(() => {
    const a = frac.value * 360;
    return { opacity: a > 180 ? 1 : 0, transform: [{ rotate: `${45 + Math.max(a, 180) - 180}deg` }] };
  });
  const end = useAnimatedStyle(() => {
    const a = frac.value * 2 * Math.PI;
    return { transform: [{ translateX: 10 * Math.sin(a) }, { translateY: 10 - 10 * Math.cos(a) }] };
  });
  const half = { borderTopColor: color, borderRightColor: color, borderBottomColor: "transparent", borderLeftColor: "transparent" };
  return (
    <View style={StyleSheet.absoluteFill}>
      <View style={[styles.clip, { left: 14 }]}>
        <Animated.View style={[styles.ring, half, { left: 2.5 - 14 }, right]} />
      </View>
      <View style={[styles.clip, { left: 0 }]}>
        <Animated.View style={[styles.ring, half, { left: 2.5 }, left]} />
      </View>
      <View style={[styles.cap, { backgroundColor: color }]} />
      <Animated.View style={[styles.cap, { backgroundColor: color }, end]} />
    </View>
  );
}

/** 圆弧：长度 0.03 → 0.8 圈，同时从 -180° 转回 0°；过阈值放大到 1.12 */
function ProgressArc({ armed, progress, color, track }: { armed: boolean; progress: Progress; color: string; track: string }) {
  const frac = useDerivedValue(() => 0.03 + 0.77 * progress.value);
  const pop = useSharedValue(armed ? 1.12 : 1);
  useEffect(() => {
    pop.value = springTo(armed ? 1.12 : 1, POP);
  }, [armed, pop]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${-180 + 180 * progress.value}deg` }, { scale: pop.value }] }));
  return (
    <Animated.View style={[styles.box, style]}>
      <View style={[styles.ring, styles.track, { left: 2.5, borderColor: track }]} />
      <ArcStroke frac={frac} color={color} />
    </Animated.View>
  );
}

/** 刷新中：0.7 圈的弧匀速转（0.7s 一圈），出现时从 1.12 弹回 1 */
function SpinningArc({ color, track }: { color: string; track: string }) {
  const frac = useSharedValue(0.7);
  const spin = useSharedValue(0);
  const pop = useSharedValue(1.12);
  useEffect(() => {
    spin.value = withRepeat(withTiming(360, { duration: 700, easing: Easing.linear, reduceMotion: NEVER }), -1, false, undefined, NEVER);
    pop.value = springTo(1, POP);
    return () => cancelAnimation(spin);
  }, [spin, pop]);
  // 网页的转圈弧没有 rotate(-90)，从 3 点钟开始
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${90 + spin.value}deg` }, { scale: pop.value }] }));
  return (
    <Animated.View style={[styles.box, style]}>
      <View style={[styles.ring, styles.track, { left: 2.5, borderColor: track }]} />
      <ArcStroke frac={frac} color={color} />
    </Animated.View>
  );
}

/** 菊花：8 根短线随进度依次亮起；刷新中按 8 格跳着转（0.8s 一圈，CSS steps(8)） */
function IosSpinner({ spinning, progress, color }: { spinning: boolean; progress: Progress; color: string }) {
  const step = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(step);
    step.value = 0;
    if (spinning) step.value = withRepeat(withTiming(8, { duration: 800, easing: Easing.linear, reduceMotion: NEVER }), -1, false, undefined, NEVER);
    return () => cancelAnimation(step);
  }, [spinning, step]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${Math.floor(step.value) * 45}deg` }] }));
  return (
    <Animated.View style={[styles.box, style]}>
      {TICKS.map((i) => (
        <Tick key={i} i={i} spinning={spinning} progress={progress} color={color} />
      ))}
    </Animated.View>
  );
}

const TICKS = [0, 1, 2, 3, 4, 5, 6, 7];

function Tick({ i, spinning, progress, color }: { i: number; spinning: boolean; progress: Progress; color: string }) {
  const style = useAnimatedStyle(() => ({ opacity: spinning ? 1 - i * 0.11 : clamp((progress.value - i / 8) * 8, 0, 1) }), [spinning, i]);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${i * 45}deg` }] }, style]}>
      {/* 线段 (14, 3.5) → (14, 8.5)，线宽 2.6、圆头 */}
      <View style={[styles.stroke, { left: 12.7, top: 2.2, width: 2.6, height: 7.6, backgroundColor: color }]} />
    </Animated.View>
  );
}

/** 箭头：随进度从 -6 落到 0，过阈值翻转 180°（M14 6v15 M8 15l6 6 6-6） */
function ArrowIcon({ armed, progress, color }: { armed: boolean; progress: Progress; color: string }) {
  const turn = useSharedValue(armed ? 180 : 0);
  useEffect(() => {
    turn.value = springTo(armed ? 180 : 0, POP);
  }, [armed, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -6 + 6 * progress.value }, { rotate: `${turn.value}deg` }] }));
  const L = Math.hypot(6, 6) + 2.6;
  return (
    <Animated.View style={[styles.box, style]}>
      <View style={[styles.stroke, { left: 12.7, top: 4.7, width: 2.6, height: 17.6, backgroundColor: color }]} />
      <View style={[styles.stroke, { left: 11 - L / 2, top: 16.7, width: L, height: 2.6, backgroundColor: color, transform: [{ rotate: "45deg" }] }]} />
      <View style={[styles.stroke, { left: 17 - L / 2, top: 16.7, width: L, height: 2.6, backgroundColor: color, transform: [{ rotate: "-45deg" }] }]} />
    </Animated.View>
  );
}

// 对勾 M9 14.5l3.2 3.2L19 11：两段的长度、角度
const CHECK_L1 = Math.hypot(3.2, 3.2);
const CHECK_L2 = Math.hypot(6.8, 6.7);
const CHECK_TOTAL = CHECK_L1 + CHECK_L2;
const CHECK_A2 = (Math.atan2(-6.7, 6.8) * 180) / Math.PI;

/** 完成：实心圆从 0.4 弹到 1，白色对勾 0.28s 画出来 */
function DoneCheck({ color }: { color: string }) {
  const pop = useSharedValue(0.4);
  const draw = useSharedValue(0);
  useEffect(() => {
    pop.value = springTo(1, POP);
    draw.value = withDelay(60, withTiming(1, { duration: 280, easing: SWAP_EASE, reduceMotion: NEVER }), NEVER);
  }, [pop, draw]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  return (
    <Animated.View style={[styles.box, style]}>
      <View style={[styles.doneDot, { backgroundColor: color }]} />
      <CheckSegment x={9} y={14.5} angle={45} len={CHECK_L1} from={0} draw={draw} />
      <CheckSegment x={12.2} y={17.7} angle={CHECK_A2} len={CHECK_L2} from={CHECK_L1} draw={draw} />
    </Animated.View>
  );
}

/** 对勾的一段：外框以起点为中心旋转，里面的线从起点往外长（按 pathLength 的进度） */
function CheckSegment({ x, y, angle, len, from, draw }: { x: number; y: number; angle: number; len: number; from: number; draw: SharedValue<number> }) {
  const W = 2 * (len + 1.3);
  const bar = useAnimatedStyle(() => {
    const vis = clamp(draw.value * CHECK_TOTAL - from, 0, len);
    return { width: vis + 2.6, opacity: vis > 0 ? 1 : 0 };
  }, [len, from]);
  return (
    <View style={{ position: "absolute", left: x - W / 2, top: y - 1.3, width: W, height: 2.6, transform: [{ rotate: `${angle}deg` }] }}>
      <Animated.View style={[styles.stroke, { left: W / 2 - 1.3, top: 0, height: 2.6, backgroundColor: "#ffffff" }, bar]} />
    </View>
  );
}

/* ---------- 示例内容（网页演示的动态列表；宿主传了 children 时不用） ---------- */

type MediaKind = "sunset" | "snow" | "film" | "vinyl" | "tiles";
type Post = { id: number; name: string; avatar: string; hue: [string, string]; time: string; text: string; media?: MediaKind };

const SEED: Post[] = [
  { id: 1, name: "林小满", avatar: "🌿", hue: ["#BBF7D0", "#34D399"], time: "3 分钟前", text: "今天的晚霞像被谁打翻了一整瓶橘子汽水。", media: "sunset" },
  { id: 2, name: "阿哲", avatar: "🎧", hue: ["#C7D2FE", "#818CF8"], time: "12 分钟前", text: "新歌单整理好了，适合写代码的深夜，一共 42 首。" },
  { id: 3, name: "Momo", avatar: "🐱", hue: ["#FDE68A", "#F59E0B"], time: "半小时前", text: "猫主子第一次见到雪，整只猫当场僵住。", media: "snow" },
  { id: 4, name: "周末去哪儿", avatar: "⛰️", hue: ["#A5F3FC", "#06B6D4"], time: "1 小时前", text: "推荐三条适合新手的城郊徒步路线，全程不超过 8 公里。" },
  { id: 5, name: "设计日报", avatar: "✏️", hue: ["#FBCFE8", "#EC4899"], time: "2 小时前", text: "弹簧动画的刚度和阻尼到底怎么调？一张图讲清楚。" },
  { id: 6, name: "陈一一", avatar: "☕️", hue: ["#FED7AA", "#EA580C"], time: "3 小时前", text: "换了新的手冲壶，这杯耶加雪菲有明显的柑橘味。" },
  { id: 7, name: "小森", avatar: "📷", hue: ["#DDD6FE", "#8B5CF6"], time: "昨天", text: "胶片冲出来了，最喜欢这张逆光。", media: "film" },
];

const INCOMING: Omit<Post, "id" | "time">[] = [
  { name: "今日天气", avatar: "🌤️", hue: ["#BAE6FD", "#38BDF8"], text: "午后转晴，最高 24°，适合出门走走。" },
  { name: "阿哲", avatar: "🎧", hue: ["#C7D2FE", "#818CF8"], text: "刚刚收藏了你的歌单，品味可以。", media: "vinyl" },
  { name: "林小满", avatar: "🌿", hue: ["#BBF7D0", "#34D399"], text: "楼下的桂花开了，整条街都是甜的。" },
  { name: "设计日报", avatar: "✏️", hue: ["#FBCFE8", "#EC4899"], text: "本周最佳微交互合集已上线，第 3 个绝了。", media: "tiles" },
];

function SampleFeed({ posts, freshId, color, pal }: { posts: Post[]; freshId: number; color: string; pal: Palette }) {
  return (
    <View style={styles.feed}>
      {posts.map((p) => (
        <PostRow key={p.id} post={p} fresh={p.id === freshId} color={color} pal={pal} />
      ))}
      <Text style={[styles.end, { color: pal.muted }]}>没有更多了</Text>
    </View>
  );
}

/** 一行动态：新插入的先撑开高度（320 / 34）、0.12s 后淡入；卡片从 0.96、-8 弹到位（380 / 26，延迟 0.08s） */
function PostRow({ post, fresh, color, pal }: { post: Post; fresh: boolean; color: string; pal: Palette }) {
  const isNew = post.id >= 100;
  const open = useSharedValue(isNew ? 0 : 1);
  const shown = useSharedValue(isNew ? 0 : 1);
  const land = useSharedValue(isNew ? 0 : 1);
  const h = useSharedValue(0);
  // 新动态的高亮：前 35% 保持，之后 ease-out 褪掉（共 2.4s）
  const glow = useSharedValue(fresh ? 1 : 0);

  useEffect(() => {
    if (!isNew) return;
    open.value = springTo(1, EXPAND);
    shown.value = withDelay(120, withTiming(1, { duration: 300, easing: EASE_IN_OUT, reduceMotion: NEVER }), NEVER);
    land.value = springTo(1, LAND, null, 80);
  }, [isNew, open, shown, land]);

  useEffect(() => {
    cancelAnimation(glow);
    if (fresh) {
      glow.value = 1;
      glow.value = withDelay(840, withTiming(0, { duration: 1560, easing: EASE_OUT, reduceMotion: NEVER }), NEVER);
    } else {
      glow.value = 0;
    }
  }, [fresh, glow]);

  // 高度按进度展开，内容高度随量随用（量到的是卡片自己的高度，不受外层限高影响）
  const rowStyle = useAnimatedStyle(() => (isNew ? { height: h.value * open.value, opacity: shown.value } : {}), [isNew]);
  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -8 * (1 - land.value) }, { scale: 0.96 + 0.04 * land.value }] }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  return (
    <Animated.View style={[styles.row, rowStyle]}>
      <View
        onLayout={(e: LayoutChangeEvent) => {
          h.value = e.nativeEvent.layout.height;
        }}
      >
        <Animated.View style={[styles.post, { backgroundColor: pal.card, boxShadow: `0px 1px 0px ${pal.line}` }, cardStyle]}>
          <Animated.View pointerEvents="none" style={[styles.glow, { backgroundColor: rgba(color, 0.09), borderColor: rgba(color, 0.55) }, glowStyle]} />
          <View style={[styles.avatar, { backgroundImage: `linear-gradient(135deg, ${post.hue[0]}, ${post.hue[1]})` }]}>
            <Text style={styles.avatarText}>{post.avatar}</Text>
          </View>
          <View style={styles.body}>
            <View style={styles.meta}>
              <Text numberOfLines={1} style={[styles.name, { color: pal.fg }]}>
                {post.name}
              </Text>
              <Text numberOfLines={1} style={[styles.time, { color: pal.muted }]}>
                {post.time}
              </Text>
            </View>
            <Text style={[styles.text, { color: pal.fg }]}>{post.text}</Text>
            {post.media && <Media kind={post.media} />}
          </View>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

// 唱片的纹路：每 4px 一圈淡白线（repeating-radial-gradient）
const GROOVES = Array.from({ length: 65 }, (_, i) => 4 * (i + 1));

/** 配图：网页是 CSS 渐变画的（晚霞、雪地、逆光、唱片、拼贴），这里用 backgroundImage 渐变 + View 拼 */
function Media({ kind }: { kind: MediaKind }) {
  switch (kind) {
    case "sunset":
      return (
        <View
          style={[
            styles.media,
            {
              backgroundImage:
                "linear-gradient(to top, rgba(91,33,182,0.55) 0%, rgba(91,33,182,0.55) 24%, rgba(91,33,182,0) 24.5%), " +
                "radial-gradient(circle at 66% 76%, #fff3c4 0%, #fff3c4 11%, rgba(255,243,196,0.5) 12%, rgba(255,243,196,0) 30%), " +
                "linear-gradient(180deg, #fb923c, #f472b6 70%, #c084fc)",
            },
          ]}
        />
      );
    case "snow":
      return (
        <View style={[styles.media, { backgroundImage: "linear-gradient(170deg, #93c5fd, #c7d2fe)" }]}>
          <SnowDots size="17px 19px" pos="7px 21px" r={1} a={0.6} />
          <SnowDots size="23px 31px" pos="19px 13px" r={1.4} a={0.85} />
          <SnowDots size="37px 29px" pos="3px 5px" r={2} a={1} />
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundImage:
                  "radial-gradient(ellipse 70% 40% at 25% 105%, #ffffff 0%, #ffffff 98%, rgba(255,255,255,0) 100%), " +
                  "radial-gradient(ellipse 60% 34% at 85% 110%, #f1f5ff 0%, #f1f5ff 98%, rgba(241,245,255,0) 100%)",
              },
            ]}
          />
        </View>
      );
    case "film":
      return (
        <View
          style={[
            styles.media,
            {
              backgroundImage:
                "radial-gradient(circle at 80% 20%, #fffbe6 0%, #fffbe6 5%, rgba(253,224,71,0.75) 12%, rgba(253,224,71,0) 46%), " +
                "linear-gradient(to top, rgba(30,27,75,0.65) 0%, rgba(30,27,75,0) 45%), " +
                "linear-gradient(200deg, #f59e0b, #db2777 55%, #6d28d9)",
            },
          ]}
        />
      );
    case "vinyl":
      return (
        <View style={[styles.media, { backgroundImage: "linear-gradient(120deg, #a78bfa, #22d3ee)" }]}>
          {GROOVES.map((r) => (
            <View key={r} style={[styles.groove, { width: r * 2, height: r * 2, borderRadius: r, marginLeft: -r, marginTop: -r }]} />
          ))}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundImage:
                  "radial-gradient(circle at 30% 50%, #f5f3ff 0%, #f5f3ff 4%, #111111 4.5%, #111111 9%, #1f1f23 9.5%, #1f1f23 30%, rgba(31,31,35,0) 30.5%)",
              },
            ]}
          />
        </View>
      );
    case "tiles":
      return (
        <View style={[styles.media, { backgroundImage: "linear-gradient(135deg, #f9a8d4, #fde68a)" }]}>
          <View style={[styles.tile, { left: 14, top: 14, width: "30%", height: "44%", backgroundColor: "rgba(255,255,255,0.6)" }]} />
          <View style={[styles.tile, { left: "30%", marginLeft: 24, top: 14, width: "30%", height: "44%", backgroundColor: "rgba(255,255,255,0.4)" }]} />
          <View style={[styles.tile, { left: 14, right: "40%", marginRight: -24, top: "44%", marginTop: 24, height: "28%", backgroundColor: "rgba(255,255,255,0.267)" }]} />
        </View>
      );
  }
}

/** 平铺的雪点（CSS 的 background-size / position / repeat） */
function SnowDots({ size, pos, r, a }: { size: string; pos: string; r: number; a: number }) {
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundImage: `radial-gradient(circle, rgba(255,255,255,${a}) 0px, rgba(255,255,255,${a}) ${r}px, rgba(255,255,255,0) ${r + 0.4}px)`,
          backgroundSize: size,
          backgroundPosition: pos,
          backgroundRepeat: "repeat",
        },
      ]}
    />
  );
}

/* ---------- 样式（来自 style.css） ---------- */

const styles = StyleSheet.create({
  root: { flex: 1 },
  viewport: { flex: 1, overflow: "hidden" },
  reveal: { position: "absolute", left: 0, right: 0, top: 0, overflow: "hidden" },
  indicator: { position: "absolute", left: 0, right: 0, top: 0, height: HOLD, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  // 内容按自己的高度排版（不受视口限高），超出的部分靠 y 移进来
  list: { position: "absolute", left: 0, right: 0, top: 0 },

  box: { width: 28, height: 28 },
  label: { minWidth: 78 },
  labelText: { fontSize: 13, fontWeight: "600" },
  clip: { position: "absolute", top: 0, width: 14, height: 28, overflow: "hidden" },
  ring: { position: "absolute", top: 2.5, width: 23, height: 23, borderRadius: 11.5, borderWidth: 3 },
  track: { borderStyle: "solid" },
  cap: { position: "absolute", left: 12.5, top: 2.5, width: 3, height: 3, borderRadius: 1.5 },
  stroke: { position: "absolute", borderRadius: 1.3 },
  doneDot: { position: "absolute", left: 3, top: 3, width: 22, height: 22, borderRadius: 11 },

  feed: { width: "100%", maxWidth: 430, alignSelf: "center", paddingTop: 4, paddingHorizontal: 12, paddingBottom: 24 },
  row: { overflow: "hidden" },
  post: { flexDirection: "row", gap: 12, marginBottom: 8, padding: 14, borderRadius: 18 },
  glow: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: 18, borderWidth: 1.5 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 20 },
  body: { flex: 1, minWidth: 0 },
  meta: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  name: { flexShrink: 1, fontSize: 15, fontWeight: "600" },
  time: { fontSize: 12 },
  text: { marginTop: 4, fontSize: 14.5, lineHeight: 21.75 },
  media: { height: 132, marginTop: 10, borderRadius: 12, overflow: "hidden" },
  groove: { position: "absolute", left: "30%", top: "50%", borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  tile: { position: "absolute" },
  end: { paddingTop: 14, paddingBottom: 8, textAlign: "center", fontSize: 12 },
});
