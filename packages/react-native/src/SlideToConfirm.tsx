// 滑动确认（React Native 版）：按住滑块往右拖，提示文字渐隐（可带一道扫过的流光）、底色跟着滑块铺开，拉过头有橡皮筋阻力；
// 没到终点松手就带着离手速度弹回；拉到头或用力一甩，轨道收成圆形转圈，再画出对勾，外面扩散一圈。
// 对应网站 src/cases/slide-to-confirm（React + motion）。
// 网页演示里的订单页、手机状态栏、导航栏、支付弹层（下拉把手、标题、金额、明细、页脚）原生端都不画——
// 宿主 App 用自己的 Modal / BottomSheet 承载这条滑轨；确认动作走 onConfirm 交给宿主，复位用 resetKey 或 resetAfter。
//
// 依赖：react-native-reanimated + react-native-gesture-handler。拖动、弹回、收拢全在 UI 线程。
// 滑块位置 x 用和 motion 一致的弹簧（自己解析求解，继承 / 指定速度、motion 的收尾阈值），其余出现 / 消失用 withSpring / withTiming。
// 不引入 svg：箭头、锁、对勾是圆头细条拼的（lucide 同一组坐标），转圈是两个半圆环拼出 65% 的弧再加两个圆头；
// 文字流光没有 background-clip:text，用几层「只露出一条窗口的高亮文字」叠出由中间向两边线性变淡的高光。
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, useColorScheme, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  defineAnimation,
  interpolateColor,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type AnimationObject,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

export type SlideToConfirmProps = {
  /** 滑块、铺开的底色和成功状态的颜色 */
  color?: string;
  /** 拖过轨道的多少比例松手才算确认；甩得快时按落点判断（0.6–1） */
  ratio?: number;
  /** 提示文字上是否有一道扫过的高光 */
  shimmer?: boolean;
  /** 没拉到头松手时弹回的速度，越大回得越快（120–900） */
  stiffness?: number;
  /** 轨道上的提示文字，同时作为读屏标签 */
  label?: string;
  /** 成功后的读屏标签（网页版弹层标题的「支付成功」） */
  successLabel?: string;
  /** 成功后几秒自动复位（网页版 2.1s）；null 表示停在成功态，由宿主用 resetKey 复位或直接关掉弹层 */
  resetAfter?: number | null;
  /** 每次改变这个值，组件就回到待滑动（比如失败重试、再次打开弹层） */
  resetKey?: string | number;
  /**
   * 滑到头后调用，转圈期间等待它的结果：返回 / resolve 成 false（或 reject）→ 弹回待滑动；其他 → 对勾。
   * 不传则按网页演示的节奏直接成功。转圈至少持续到网页版的 1.5s 节点，再快的结果也等到那时才变对勾
   */
  onConfirm?: () => void | boolean | Promise<void | boolean>;
  /** 阶段变化回调（宿主可借此切换弹层标题，比如「确认支付」→「支付成功」） */
  onStateChange?: (state: "idle" | "loading" | "success") => void;
};

type Phase = "idle" | "loading" | "success";

const H = 60;
const KNOB = 52;
const PAD = (H - KNOB) / 2;
/** 转圈和对勾是 24 的 viewBox 画在 28 的框里 */
const ICON = 28 / 24;

// 系统「减弱动态效果」由组件自己处理（只关掉流光、箭头招手、进场试探和成功扩散圈），这里不让 Reanimated 直接跳到终点
const NEVER = ReduceMotion.Never;
const EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1);
/** motion 默认的透明度过渡：0.3s，cubic-bezier(0.25, 0.1, 0.35, 1) */
const FADE = { duration: 300, easing: Easing.bezier(0.25, 0.1, 0.35, 1), reduceMotion: NEVER };
/** 滑块出现 / 松手弹回 */
const KNOB_SPRING = { stiffness: 520, damping: 26, mass: 1, reduceMotion: NEVER };
/** 到达确认线时的锁 */
const LOCK_SPRING = { stiffness: 600, damping: 20, mass: 1, reduceMotion: NEVER };
/** motion 默认的 scale 弹簧（目标不为 0 时） */
const SCALE_SPRING = { stiffness: 550, damping: 30, mass: 1, reduceMotion: NEVER };
/** 对勾 */
const CHECK_SPRING = { stiffness: 500, damping: 15, mass: 1, reduceMotion: NEVER };

const LIGHT = { track: "#eef0f3", hint: "#9a9aa0", hintHi: "#1a1a1a" };
const DARK = { track: "#26262b", hint: "#6e6e74", hintHi: "#ffffff" };

/** 十六进制颜色 + 透明度 → rgba()（对应 color-mix(in srgb, c x%, transparent)） */
function alpha(hex: string, a: number) {
  let s = hex.trim().replace(/^#/, "");
  if (s.length === 3) s = s.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return hex;
  const n = parseInt(s.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function clamp(v: number, lo: number, hi: number) {
  "worklet";
  return Math.min(hi, Math.max(lo, v));
}

/** 拉过两端时的橡皮筋：越拉越拉不动，最多再多出十来像素 */
function band(over: number) {
  "worklet";
  return (1 - 1 / ((over * 0.55) / 40 + 1)) * 40;
}

/** 手指给的原始位置 → 画面上的滑块位置（两端过头部分按橡皮筋换算） */
function knobOffset(v: number, m: number) {
  "worklet";
  if (v < 0) return -band(-v) * 0.5;
  if (v > m) return m + band(v - m) * 0.5;
  return v;
}

/* ---------- 和 motion 一致的弹簧（x 专用：要继承 / 指定速度、要 motion 的 restDelta） ---------- */

type Sp = { stiffness: number; damping: number; velocity?: number; restDelta?: number };

/** 弹簧解析解（mass = 1）：返回 t 秒时的位置与速度（单位/秒） */
function solveSpring(k: number, c: number, from: number, to: number, v0: number, t: number) {
  "worklet";
  const zeta = c / (2 * Math.sqrt(k));
  const w0 = Math.sqrt(k);
  const delta = to - from;
  let e: number;
  let de: number;
  if (zeta < 1) {
    const a = zeta * w0;
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const A = (-v0 + a * delta) / wd;
    const env = Math.exp(-a * t);
    const sin = Math.sin(wd * t);
    const cos = Math.cos(wd * t);
    e = env * (delta * cos + A * sin);
    de = env * ((-a * delta + A * wd) * cos + (-a * A - delta * wd) * sin);
  } else if (zeta === 1) {
    const B = -v0 + w0 * delta;
    const env = Math.exp(-w0 * t);
    e = env * (delta + B * t);
    de = env * (B - w0 * (delta + B * t));
  } else {
    const wd = w0 * Math.sqrt(zeta * zeta - 1);
    const slow = zeta * w0 - wd;
    const fast = zeta * w0 + wd;
    const C1 = (fast * delta - v0) / (fast - slow);
    const C2 = delta - C1;
    e = C1 * Math.exp(-slow * t) + C2 * Math.exp(-fast * t);
    de = -slow * C1 * Math.exp(-slow * t) - fast * C2 * Math.exp(-fast * t);
  }
  return { x: to - e, v: -de };
}

interface MotionSpringAnimation extends AnimationObject<number> {
  from: number;
  target: number;
  v0: number;
  velocity: number;
  begin: number;
}

/**
 * 像 motion 的 animate(x, target, { type: "spring", stiffness, damping, velocity, restDelta }) 一样驱动 x：
 * 指定了 velocity 就用它（松手速度），否则继承被打断动画的当前速度（是「接着」而不是叠加）；
 * 收尾阈值与 motion 相同；callback(finished) 只有自然停稳时 finished 才为 true
 */
function motionSpring(toValue: number, sp: Sp, callback?: (finished?: boolean) => void): number {
  "worklet";
  return defineAnimation<MotionSpringAnimation>(toValue, () => {
    "worklet";
    const onStart = (a: MotionSpringAnimation, value: number, now: number, prev: { velocity?: unknown } | null | undefined) => {
      a.from = value;
      a.target = toValue;
      a.current = value;
      a.begin = now;
      const inherited = prev && typeof prev.velocity === "number" ? prev.velocity : 0;
      a.v0 = typeof sp.velocity === "number" ? sp.velocity : inherited;
      a.velocity = a.v0;
    };
    const onFrame = (a: MotionSpringAnimation, now: number): boolean => {
      const t = Math.max(0, (now - a.begin) / 1000);
      const { x, v } = solveSpring(sp.stiffness, sp.damping, a.from, a.target, a.v0, t);
      const granular = Math.abs(a.target - a.from) < 5;
      const restDelta = typeof sp.restDelta === "number" ? sp.restDelta : granular ? 0.005 : 0.5;
      const done = Math.abs(v) <= (granular ? 0.01 : 2) && Math.abs(a.target - x) <= restDelta;
      a.current = done ? a.target : x;
      a.velocity = done ? 0 : v;
      return done;
    };
    return {
      onStart,
      onFrame,
      toValue,
      current: toValue,
      from: toValue,
      target: toValue,
      v0: 0,
      velocity: 0,
      begin: 0,
      callback,
      reduceMotion: false,
    } as MotionSpringAnimation;
  }) as unknown as number;
}

/* ---------- 组件 ---------- */

export function SlideToConfirm({
  color = "#16A34A",
  ratio = 0.9,
  shimmer = true,
  stiffness = 420,
  label = "滑动确认支付",
  successLabel = "支付成功",
  resetAfter = 2.1,
  resetKey,
  onConfirm,
  onStateChange,
}: SlideToConfirmProps) {
  const pal = useColorScheme() === "dark" ? DARK : LIGHT;
  const reduce = useReducedMotion();
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [full, setFull] = useState(0);
  const idle = phase === "idle";

  const live = useRef({ resetAfter, onConfirm, onStateChange, reduce });
  live.current = { resetAfter, onConfirm, onStateChange, reduce };
  const phaseRef = useRef<Phase>("idle");
  const busyRef = useRef(false);
  const gen = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // x 是手指给的「原始」位置，可以超出 [0, max]；画面上用橡皮筋换算后的 knobOffset
  const x = useSharedValue(0);
  const maxX = useSharedValue(240);
  const fullW = useSharedValue(0);
  /** 逻辑上已经确认（网页版 live.state !== "idle"，比画面早 140ms） */
  const busy = useSharedValue(false);
  const dragging = useSharedValue(false);
  const moved = useSharedValue(false);
  const from = useSharedValue(0);
  const touched = useSharedValue(false);
  const armed = useSharedValue(false);
  const lock = useSharedValue(0);
  const press = useSharedValue(1);
  /** 滑块在场程度：1 在场，0 = 缩到 0.4 并透明 */
  const knobIn = useSharedValue(1);
  /** 提示文字 + 铺开底色在场程度（离场淡出，回来直接出现） */
  const textIn = useSharedValue(1);
  /** 轨道展开量：1 铺满，0 收成圆 */
  const open = useSharedValue(1);
  /** 轨道底色：0 浅灰，1 主色 */
  const tint = useSharedValue(0);
  const spinOp = useSharedValue(0);
  const spinScale = useSharedValue(0.6);
  const spinRot = useSharedValue(0);
  const checkOp = useSharedValue(0);
  const checkScale = useSharedValue(0.5);
  const draw = useSharedValue(0);
  /** 成功扩散圈的进度；停在 1（看不见） */
  const ring = useSharedValue(1);
  const sweep = useSharedValue(0);
  const beckon = useSharedValue(0);

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
    live.current.onStateChange?.(p);
  };

  const later = (fn: () => void, ms: number) => {
    const g = gen.current;
    timers.current.push(
      setTimeout(() => {
        if (gen.current === g) fn();
      }, ms),
    );
  };

  useEffect(
    () => () => {
      gen.current++;
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  // 到达确认线时锁弹出来
  useAnimatedReaction(
    () => x.value,
    (v) => {
      if (busy.value) return;
      const next = v >= maxX.value * ratio - 0.5;
      if (next !== armed.value) {
        armed.value = next;
        lock.value = withSpring(next ? 1 : 0, LOCK_SPRING);
      }
    },
    [ratio],
  );

  /* ---------- 弹簧（UI 线程） ---------- */

  /** 弹回起点：ζ≈0.55，撞到左端时被橡皮筋吃掉，不会穿墙 */
  const springBack = (velocity?: number) => {
    "worklet";
    x.value = motionSpring(0, { stiffness, damping: 1.1 * Math.sqrt(stiffness), restDelta: 0.3, velocity });
  };

  const nudge = () => {
    "worklet";
    cancelAnimation(x);
    // 中途被手指打断（finished = false）就不再弹回，交给拖动
    x.value = motionSpring(Math.min(40, maxX.value * 0.2), { stiffness: 520, damping: 20, restDelta: 2 }, (finished) => {
      "worklet";
      if (finished && !busy.value && !dragging.value) springBack();
    });
  };

  /** 确认：velocity 不传时接着当前动画的速度（读屏双击确认时） */
  const completeUI = (velocity?: number) => {
    "worklet";
    if (busy.value) return;
    busy.value = true;
    dragging.value = false;
    x.value = motionSpring(maxX.value, { stiffness: 700, damping: 44, velocity });
    runOnJS(confirmed)();
  };

  // 进场后轻轻探一下，告诉人这里能拖（减弱动态效果时不探）
  const introRef = useRef(() => {});
  introRef.current = () => {
    "worklet";
    if (touched.value || busy.value) return;
    nudge();
  };
  useEffect(() => {
    const t = setTimeout(() => {
      if (!live.current.reduce) runOnUI(introRef.current)();
    }, 1100);
    return () => clearTimeout(t);
  }, []);

  /* ---------- 阶段切换（JS） ---------- */

  function confirmed() {
    busyRef.current = true;
    const started = Date.now();
    draw.value = 0;
    later(enterLoading, 140);
    const g = gen.current;
    let result: Promise<boolean>;
    try {
      result = Promise.resolve(live.current.onConfirm?.()).then(
        (r) => r !== false,
        () => false,
      );
    } catch {
      result = Promise.resolve(false);
    }
    void result.then((ok) => {
      if (gen.current !== g) return;
      // 转圈至少到网页版的 1.5s 节点再出结果
      later(() => (ok ? succeed() : reset()), Math.max(0, started + 1500 - Date.now()));
    });
  }

  function enterLoading() {
    armed.value = false;
    lock.value = withSpring(0, LOCK_SPRING);
    press.value = withSpring(1, KNOB_SPRING);
    // 滑块 0.15s 缩到 0.4 淡出；提示文字和底色 0.3s 淡出
    knobIn.value = withTiming(0, { duration: 150, easing: EASE_IN_OUT, reduceMotion: NEVER });
    textIn.value = withTiming(0, FADE);
    // 轨道收成圆：晚 0.06s 起步，弹簧 340 / 30；底色 0.16s 变成主色
    open.value = withDelay(60, withSpring(0, { stiffness: 340, damping: 30, mass: 1, reduceMotion: NEVER }), NEVER);
    tint.value = withTiming(1, { duration: 160, easing: EASE_IN_OUT, reduceMotion: NEVER });
    // 转圈晚 0.2s 出现
    spinScale.value = withSequence(NEVER, withTiming(0.6, { duration: 0, reduceMotion: NEVER }), withDelay(200, withSpring(1, SCALE_SPRING), NEVER));
    spinOp.value = withDelay(200, withTiming(1, FADE), NEVER);
    spinRot.value = 0;
    spinRot.value = withRepeat(withTiming(1, { duration: 750, easing: Easing.linear, reduceMotion: NEVER }), -1, false, undefined, NEVER);
    setPhase("loading");
  }

  function succeed() {
    spinOp.value = withTiming(0, FADE);
    spinScale.value = withSpring(0.6, SCALE_SPRING);
    // 对勾：从 0.5 弹到 1（不淡入），笔画 0.35s 画出来
    checkOp.value = 1;
    checkScale.value = withSequence(NEVER, withTiming(0.5, { duration: 0, reduceMotion: NEVER }), withSpring(1, CHECK_SPRING));
    draw.value = withSequence(
      NEVER,
      withTiming(0, { duration: 0, reduceMotion: NEVER }),
      withDelay(50, withTiming(1, { duration: 350, easing: Easing.bezier(0.3, 0, 0.2, 1), reduceMotion: NEVER }), NEVER),
    );
    if (!live.current.reduce) {
      ring.value = withSequence(
        NEVER,
        withTiming(0, { duration: 0, reduceMotion: NEVER }),
        withTiming(1, { duration: 700, easing: Easing.bezier(0.2, 0.7, 0.3, 1), reduceMotion: NEVER }),
      );
    }
    setPhase("success");
    const r = live.current.resetAfter;
    if (typeof r === "number") later(reset, Math.max(0, r) * 1000);
  }

  /** 回到待滑动：滑块瞬间回到起点，轨道弹回铺满，滑块从 0.4 弹出来 */
  function reset() {
    gen.current++;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busyRef.current = false;
    runOnUI(() => {
      "worklet";
      cancelAnimation(x);
      dragging.value = false;
      armed.value = false;
      lock.value = 0;
      press.value = 1;
      x.value = 0;
      busy.value = false;
    })();
    if (phaseRef.current === "idle") return;
    knobIn.value = withSpring(1, KNOB_SPRING);
    textIn.value = 1;
    open.value = withSpring(1, { stiffness: 300, damping: 30, mass: 1, reduceMotion: NEVER });
    tint.value = withTiming(0, { duration: 300, easing: EASE_IN_OUT, reduceMotion: NEVER });
    spinOp.value = withTiming(0, FADE);
    spinScale.value = withSpring(0.6, SCALE_SPRING);
    cancelAnimation(spinRot);
    checkOp.value = withSpring(0, CHECK_SPRING);
    checkScale.value = withSpring(0.5, CHECK_SPRING);
    setPhase("idle");
  }

  // 宿主改 resetKey → 复位
  const prevKey = useRef(resetKey);
  useEffect(() => {
    if (prevKey.current === resetKey) return;
    prevKey.current = resetKey;
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // 流光：2.4s 匀速一轮；箭头招手：1.6s 一轮（0–25% 右移 3、25–55% 回来、之后停住）
  useEffect(() => {
    if (shimmer && !reduce) {
      sweep.value = 0;
      sweep.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear, reduceMotion: NEVER }), -1, false, undefined, NEVER);
    } else {
      cancelAnimation(sweep);
    }
  }, [shimmer, reduce, sweep]);
  useEffect(() => {
    if (reduce) {
      cancelAnimation(beckon);
      beckon.value = 0;
      return;
    }
    const ease = Easing.bezier(0.33, 0.55, 0.2, 1);
    beckon.value = withRepeat(
      withSequence(
        NEVER,
        withTiming(3, { duration: 400, easing: ease, reduceMotion: NEVER }),
        withTiming(0, { duration: 480, easing: ease, reduceMotion: NEVER }),
        withTiming(0, { duration: 720, reduceMotion: NEVER }),
      ),
      -1,
      false,
      undefined,
      NEVER,
    );
  }, [reduce, beckon]);

  /* ---------- 手势：整条轨道只挂这一个，按在滑块上是拖动，按在空白处是轻轻探一下 ---------- */

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      if (busy.value) return;
      touched.value = true;
      const left = PAD + knobOffset(x.value, maxX.value);
      if (e.x >= left && e.x <= left + KNOB) {
        cancelAnimation(x);
        from.value = x.value;
        moved.value = false;
        dragging.value = true;
        press.value = withTiming(0.94, { duration: 90, easing: EASE_IN_OUT, reduceMotion: NEVER });
      } else {
        nudge();
      }
    })
    .onUpdate((e) => {
      if (!dragging.value || busy.value) return;
      if (Math.abs(e.translationX) > 3) moved.value = true;
      x.value = from.value + e.translationX;
    })
    .onFinalize((e) => {
      if (!dragging.value) return;
      dragging.value = false;
      press.value = withSpring(1, KNOB_SPRING);
      if (busy.value) return;
      const m = maxX.value;
      const v = x.value;
      const vel = e.velocityX;
      // 甩得够快：按 0.12s 后的落点判断，不必真拖到头
      const projected = v + Math.max(0, vel) * 0.12;
      if (v >= m * ratio - 0.5 || (vel > 600 && projected >= m * ratio)) completeUI(vel);
      else if (!moved.value) nudge();
      else springBack(vel);
    });

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setFull(w);
    fullW.value = w;
    // 只在待滑动时更新可拖距离（和网页版的 ResizeObserver 一样）
    if (!busyRef.current) maxX.value = Math.max(0, w - H);
  };

  /* ---------- 样式 ---------- */

  const trackStyle = useAnimatedStyle(
    () => ({
      width: H + Math.max(0, fullW.value - H) * open.value,
      // motion 混色是平方空间插值，对应 gamma 2
      backgroundColor: interpolateColor(tint.value, [0, 1], [pal.track, color], "RGB", { gamma: 2 }),
    }),
    [pal.track, color],
  );

  const fillStyle = useAnimatedStyle(() => {
    const m = maxX.value;
    const p = m > 0 ? clamp(x.value / m, 0, 1) : 0;
    return {
      width: Math.max(knobOffset(x.value, m), 0) + KNOB + PAD * 2,
      opacity: textIn.value * (0.4 + 0.6 * p),
    };
  });

  const hintStyle = useAnimatedStyle(() => {
    const m = maxX.value;
    const p = m > 0 ? clamp(x.value / m, 0, 1) : 0;
    const trackW = H + Math.max(0, fullW.value - H) * open.value;
    return {
      opacity: textIn.value * clamp(1 - p / 0.5, 0, 1),
      // 提示框按组件全宽排版，平移到轨道中间；再跟着滑块走 0.3 倍
      transform: [{ translateX: (trackW - fullW.value) / 2 + knobOffset(x.value, m) * 0.3 }],
    };
  });

  const knobStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, knobIn.value),
    transform: [{ translateX: knobOffset(x.value, maxX.value) }, { scale: (0.4 + 0.6 * knobIn.value) * press.value }],
  }));

  const chevStyle = useAnimatedStyle(() => {
    const m = maxX.value;
    const p = m > 0 ? clamp(x.value / m, 0, 1) : 0;
    return { opacity: 1 - clamp((p - 0.6) / 0.3, 0, 1), transform: [{ translateX: beckon.value }] };
  });

  const lockStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, lock.value),
    transform: [{ scale: 0.3 + 0.7 * lock.value }],
  }));

  const spinStyle = useAnimatedStyle(() => ({
    opacity: spinOp.value,
    transform: [{ scale: spinScale.value }, { rotate: `${spinRot.value * 360}deg` }],
  }));

  const checkStyle = useAnimatedStyle(() => ({
    opacity: clamp(checkOp.value, 0, 1),
    transform: [{ scale: checkScale.value }],
  }));

  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - ring.value),
    transform: [{ scale: 1 + 1.1 * ring.value }],
  }));

  const knobShadow = `0px 2px 6px rgba(0,0,0,0.16), 0px 6px 16px ${alpha(color, 0.35)}`;

  return (
    <GestureHandlerRootView style={styles.root}>
      <View
        style={styles.root}
        onLayout={onLayout}
        accessible
        accessibilityRole="button"
        accessibilityLabel={phase === "success" ? successLabel : label}
        accessibilityHint={idle ? "轻点两下确认" : undefined}
        accessibilityState={{ busy: phase === "loading", disabled: !idle }}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "activate" && idle) runOnUI(completeUI)();
        }}
      >
        {/* 成功时从轨道后面扩散出去的一圈 */}
        <Animated.View pointerEvents="none" style={[styles.ring, { left: full / 2 - H / 2, backgroundColor: color }, ringStyle]} />

        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.track, { opacity: full > 0 ? 1 : 0 }, trackStyle]}>
            {/* 跟着滑块铺开的底色 */}
            <Animated.View pointerEvents="none" style={[styles.fill, { backgroundColor: alpha(color, 0.22) }, fillStyle]} />

            {/* 提示文字（左边留 40 给滑块） */}
            <Animated.View pointerEvents="none" style={[styles.hintWrap, { width: full }, hintStyle]}>
              <Hint label={label} shimmer={shimmer && !reduce} pal={pal} sweep={sweep} />
            </Animated.View>

            {/* 滑块 */}
            <Animated.View pointerEvents="none" style={[styles.knob, { backgroundColor: color, boxShadow: knobShadow }, knobStyle]}>
              <Animated.View style={[styles.icon24, chevStyle]}>
                <Chevrons />
              </Animated.View>
              <Animated.View style={[styles.icon20, lockStyle]}>
                <Lock />
              </Animated.View>
            </Animated.View>

            {/* 处理中：转圈；成功：画出对勾 */}
            <View pointerEvents="none" style={styles.center}>
              <Animated.View style={[styles.icon28, spinStyle]}>
                <Spinner />
              </Animated.View>
            </View>
            <View pointerEvents="none" style={styles.center}>
              <Animated.View style={[styles.icon28, checkStyle]}>
                <Check draw={draw} />
              </Animated.View>
            </View>
          </Animated.View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
  );
}

/* ---------- 提示文字 + 流光 ---------- */

/** 流光层数：每层是一条以高光为中心、宽度递减的窗口，叠起来就是由中间向两边线性变淡的高光 */
const SLICES = 6;

function Hint({ label, shimmer, pal, sweep }: { label: string; shimmer: boolean; pal: typeof LIGHT; sweep: SharedValue<number> }) {
  const [w, setW] = useState(0);
  return (
    <View style={styles.hintBox} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Text numberOfLines={1} style={[styles.hintText, { color: pal.hint }]}>
        {label}
      </Text>
      {shimmer && w > 0 && Array.from({ length: SLICES }, (_, i) => <ShimmerSlice key={i} index={i} w={w} label={label} color={pal.hintHi} sweep={sweep} />)}
    </View>
  );
}

/**
 * 网页版：背景宽 250%，高光在 42%–58%，background-position 100% → 0%。
 * 换算到提示框（宽 W，含左边 40）里：高光中心从 -0.25W 匀速走到 1.25W，半宽 0.2W。
 * 第 i 层窗口半宽 0.2W × (N − i) / N、透明度 1 / (N − i)，叠起来中心处正好是高亮色，向两边线性退回底色
 */
function ShimmerSlice({ index, w, label, color, sweep }: { index: number; w: number; label: string; color: string; sweep: SharedValue<number> }) {
  const half = (0.2 * w * (SLICES - index)) / SLICES;
  const windowStyle = useAnimatedStyle(() => {
    const left = w * (-0.25 + 1.5 * sweep.value) - half;
    return { transform: [{ translateX: left }] };
  }, [w, half]);
  const innerStyle = useAnimatedStyle(() => {
    const left = w * (-0.25 + 1.5 * sweep.value) - half;
    return { transform: [{ translateX: -left }] };
  }, [w, half]);
  return (
    <Animated.View style={[styles.slice, { width: half * 2 }, windowStyle]}>
      <Animated.View style={[styles.sliceInner, { width: w }, innerStyle]}>
        <Text numberOfLines={1} style={[styles.hintText, { color, opacity: 1 / (SLICES - index) }]}>
          {label}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

/* ---------- 图标（lucide 的坐标，圆头细条拼出来） ---------- */

/** 一段圆头线段：24 的 viewBox 坐标 × u，线宽 s */
function Seg({ x1, y1, x2, y2, u, s }: { x1: number; y1: number; x2: number; y2: number; u: number; s: number }) {
  const len = Math.hypot(x2 - x1, y2 - y1) * u;
  const cx = ((x1 + x2) / 2) * u;
  const cy = ((y1 + y2) / 2) * u;
  return (
    <View
      style={{
        position: "absolute",
        left: cx - (len + s) / 2,
        top: cy - s / 2,
        width: len + s,
        height: s,
        borderRadius: s / 2,
        backgroundColor: "#fff",
        transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
      }}
    />
  );
}

/** chevrons-right（24，线宽 2.4）：m6 17 5-5-5-5 / m13 17 5-5-5-5 */
function Chevrons() {
  return (
    <>
      {[6, 13].map((x0) => (
        <View key={x0} style={StyleSheet.absoluteFill}>
          <Seg x1={x0} y1={7} x2={x0 + 5} y2={12} u={1} s={2.4} />
          <Seg x1={x0 + 5} y1={12} x2={x0} y2={17} u={1} s={2.4} />
        </View>
      ))}
    </>
  );
}

/** lock（20，线宽 2.4 × 20/24）：rect(3, 11, 18, 11, r2) + M7 11V7a5 5 0 0 1 10 0v4 */
function Lock() {
  const u = 20 / 24;
  const s = 2.4 * u;
  return (
    <>
      <View
        style={{
          position: "absolute",
          left: 7 * u - s / 2,
          top: 2 * u - s / 2,
          width: 10 * u + s,
          height: 9 * u + s / 2,
          borderWidth: s,
          borderBottomWidth: 0,
          borderColor: "#fff",
          borderTopLeftRadius: 5 * u + s / 2,
          borderTopRightRadius: 5 * u + s / 2,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: 3 * u - s / 2,
          top: 11 * u - s / 2,
          width: 18 * u + s,
          height: 11 * u + s,
          borderWidth: s,
          borderColor: "#fff",
          borderRadius: 2 * u + s / 2,
        }}
      />
    </>
  );
}

/** 转圈：r = 9、线宽 2.6（24 的 viewBox）、65% 的弧。两个底半圆环（0°–180°、54°–234°）拼成弧，两头补圆点 */
function Spinner() {
  const r = 9 * ICON;
  const s = 2.6 * ICON;
  const c = 14;
  const half = (rot: number) => (
    <View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${rot}deg` }] }]}>
      <View style={{ position: "absolute", left: 0, top: c, width: 28, height: c, overflow: "hidden" }}>
        <View
          style={{
            position: "absolute",
            left: c - r - s / 2,
            top: -r - s / 2,
            width: 2 * r + s,
            height: 2 * r + s,
            borderRadius: r + s / 2,
            borderWidth: s,
            borderColor: "#fff",
          }}
        />
      </View>
    </View>
  );
  const dot = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return (
      <View
        style={{
          position: "absolute",
          left: c + r * Math.cos(a) - s / 2,
          top: c + r * Math.sin(a) - s / 2,
          width: s,
          height: s,
          borderRadius: s / 2,
          backgroundColor: "#fff",
        }}
      />
    );
  };
  return (
    <>
      {half(0)}
      {half(54)}
      {dot(0)}
      {dot(234)}
    </>
  );
}

/** 对勾：M6 12.5l4 4L18 8.5（28 的框，线宽 2.8 × 28/24），按 draw 0 → 1 顺着笔画画出来 */
const CHECK_A = { x: 6 * ICON, y: 12.5 * ICON };
const CHECK_B = { x: 10 * ICON, y: 16.5 * ICON };
const CHECK_C = { x: 18 * ICON, y: 8.5 * ICON };
const CHECK_S = 2.8 * ICON;
const LEG1 = Math.hypot(CHECK_B.x - CHECK_A.x, CHECK_B.y - CHECK_A.y);
const LEG2 = Math.hypot(CHECK_C.x - CHECK_B.x, CHECK_C.y - CHECK_B.y);

function Check({ draw }: { draw: SharedValue<number> }) {
  const legStyle = (a: { x: number; y: number }, b: { x: number; y: number }, offset: number, total: number) => {
    "worklet";
    const len = clamp(draw.value * (LEG1 + LEG2) - offset, 0, total);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    // 从起点往前长：中心 = 起点 + 方向 × len / 2
    const cx = a.x + Math.cos(ang) * (len / 2);
    const cy = a.y + Math.sin(ang) * (len / 2);
    return {
      opacity: draw.value * (LEG1 + LEG2) > offset ? 1 : 0,
      left: cx - (len + CHECK_S) / 2,
      top: cy - CHECK_S / 2,
      width: len + CHECK_S,
      transform: [{ rotate: `${ang}rad` }],
    };
  };
  const leg1 = useAnimatedStyle(() => legStyle(CHECK_A, CHECK_B, 0, LEG1));
  const leg2 = useAnimatedStyle(() => legStyle(CHECK_B, CHECK_C, LEG1, LEG2));
  return (
    <>
      <Animated.View style={[styles.stroke, leg1]} />
      <Animated.View style={[styles.stroke, leg2]} />
    </>
  );
}

const styles = StyleSheet.create({
  // 不铺底色：背景跟随宿主 App
  root: {
    alignSelf: "stretch",
    height: H,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    top: 0,
    width: H,
    height: H,
    borderRadius: H / 2,
  },
  track: {
    height: H,
    borderRadius: H / 2,
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: H / 2,
  },
  hintWrap: {
    position: "absolute",
    left: 0,
    top: 0,
    height: H,
    alignItems: "center",
    justifyContent: "center",
  },
  hintBox: {
    paddingLeft: 40,
  },
  hintText: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 16 * 0.08,
  },
  slice: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    overflow: "hidden",
  },
  sliceInner: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    paddingLeft: 40,
  },
  knob: {
    position: "absolute",
    left: PAD,
    top: PAD,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  icon24: { position: "absolute", width: 24, height: 24 },
  icon20: { position: "absolute", width: 20, height: 20 },
  icon28: { width: 28, height: 28 },
  center: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  stroke: {
    position: "absolute",
    height: CHECK_S,
    borderRadius: CHECK_S / 2,
    backgroundColor: "#fff",
  },
});
