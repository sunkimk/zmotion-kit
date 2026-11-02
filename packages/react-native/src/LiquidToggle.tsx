// 液态开关（React Native 版）：滑块像一滴液体，左右两条边各自做弹簧，前沿快、后沿慢 → 被拉长；后沿冲过头 → 被挤扁。
// 动画全部跑在 UI 线程（Reanimated 共享值 + 自定义弹簧动画），手势用 Gesture Handler。
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, useColorScheme } from "react-native";
import Animated, {
  defineAnimation,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  type AnimationObject,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector, State } from "react-native-gesture-handler";

export type LiquidToggleProps = {
  /** 打开后轨道填充的颜色 */
  color?: string;
  /** 前后沿的时间差，越大滑块被拉得越长，0 为刚体（0–1） */
  stretch?: number;
  /** 开关的宽度（px），高度按比例变化（56–160） */
  size?: number;
  /** 滑块从一端到另一端的弹簧时长（秒，0.2–1.2） */
  duration?: number;
  /** 到达终点时的过冲与回弹，0 为不回弹（0–0.8） */
  bounce?: number;
  /** 受控：当前是否打开；不传则组件内部自己管理 */
  value?: boolean;
  /** 用户点按 / 拖动 / 甩动切换后回调 */
  onValueChange?: (v: boolean) => void;
};

/* ---------- 颜色（对应 style.css 的浅色 / 深色变量） ---------- */
const PALETTE = {
  light: {
    track: "#e3e3e8",
    knob: "#ffffff",
    knobBottom: "#ebebeb", // color-mix(in srgb, #fff 92%, #000)
    muted: "#8a8a8a",
    ring: "rgba(0,0,0,0.06)",
  },
  dark: {
    track: "#3a3a3e",
    knob: "#f7f7f7",
    knobBottom: "#e3e3e3", // color-mix(in srgb, #f7f7f7 92%, #000)
    muted: "#777777",
    ring: "rgba(255,255,255,0.06)",
  },
} as const;

function geometry(size: number) {
  const W = size;
  const H = Math.round(size * 0.58);
  const pad = Math.max(2, Math.round(H * 0.08));
  const d = H - pad * 2; // 滑块直径
  const T = W - pad * 2; // 轨道内宽
  return { W, H, pad, d, T, travel: T - d, wide: d * 0.24 };
}
type Geo = ReturnType<typeof geometry>;

const clamp = (v: number, lo: number, hi: number) => {
  "worklet";
  return Math.min(hi, Math.max(lo, v));
};

/* ---------- 和 motion（v14）完全一致的弹簧 ---------- */
// motion 的 { duration, bounce } 不是「感知时长」：它会求一组 stiffness / damping，使弹簧在 duration 秒内基本停稳（包络 < 0.001），
// 并且忽略继承的速度、到 duration 时直接落到终点。这里把 motion 的 findSpring 原样搬过来，换算成物理参数后自己解析求解。
type SpringSpec = {
  stiffness: number;
  damping: number;
  mass: number;
  /** true = 由 duration/bounce 定义：忽略继承速度，到 duration 秒时结束 */
  timed: boolean;
  duration: number; // 秒，仅 timed 用
};

const physics = (stiffness: number, damping: number, mass = 1): SpringSpec => ({
  stiffness,
  damping,
  mass,
  timed: false,
  duration: 0,
});

/** motion-dom spring.mjs 的 findSpring（bounce ≥ 0 的部分） */
function timed(durationSec: number, bounce: number): SpringSpec {
  const safeMin = 0.001;
  const ratio = Math.max(1 - bounce, 0.05);
  const duration = clamp(durationSec, 0.01, 10);
  const angular = (f: number, r: number) => f * Math.sqrt(1 - r * r);
  let envelope: (f: number) => number;
  let derivative: (f: number) => number;
  if (ratio < 1) {
    envelope = (f) => {
      const decay = f * ratio;
      const delta = decay * duration;
      const b = angular(f, ratio);
      const c = Math.exp(-delta);
      return safeMin - (decay / b) * c;
    };
    derivative = (f) => {
      const decay = f * ratio;
      const delta = decay * duration;
      const e = ratio * ratio * f * f * duration;
      const ff = Math.exp(-delta);
      const g = angular(f * f, ratio);
      const factor = -envelope(f) + safeMin > 0 ? -1 : 1;
      return (factor * -e * ff) / g;
    };
  } else {
    envelope = (f) => -safeMin + Math.exp(-f * duration) * (f * duration + 1);
    derivative = (f) => Math.exp(-f * duration) * (-f * duration * duration);
  }
  let f = 5 / duration;
  for (let i = 1; i < 12; i++) f = f - envelope(f) / derivative(f);
  let stiffness = f * f;
  let damping = ratio * 2 * Math.sqrt(stiffness);
  if (!(stiffness > 0 && stiffness < Infinity) || !(damping >= 0 && damping < Infinity)) {
    stiffness = 100;
    damping = 10;
  }
  return { stiffness, damping, mass: 1, timed: true, duration };
}

/** 弹簧解析解：返回 t 秒时的位置与速度（单位/秒） */
function solveSpring(spec: SpringSpec, from: number, to: number, v0: number, t: number) {
  "worklet";
  const { stiffness: k, damping: c, mass: m } = spec;
  const zeta = c / (2 * Math.sqrt(k * m));
  const w0 = Math.sqrt(k / m);
  const delta = to - from; // e(0)：离终点还差多少
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
  begin: number; // ms，已含 delay
}

/**
 * 像 motion 的 animate(value, target, spring) 一样驱动一个共享值：
 * - 物理弹簧继承被打断动画的速度；duration 弹簧不继承（与 motion 一致）
 * - delay 期间停在起点不动（motion 会立即停掉旧动画再等待）
 */
function motionSpring(toValue: number, spec: SpringSpec, delaySec = 0): number {
  "worklet";
  return defineAnimation<MotionSpringAnimation>(toValue, () => {
    "worklet";
    const onStart = (
      a: MotionSpringAnimation,
      value: number,
      now: number,
      prev: { velocity?: unknown } | null | undefined,
    ) => {
      a.from = value;
      a.target = toValue;
      a.current = value;
      a.begin = now + delaySec * 1000;
      const inherited = prev && typeof prev.velocity === "number" ? prev.velocity : 0;
      a.v0 = spec.timed ? 0 : inherited;
      a.velocity = delaySec > 0 ? 0 : a.v0;
    };
    const onFrame = (a: MotionSpringAnimation, now: number): boolean => {
      const t = (now - a.begin) / 1000;
      if (t < 0) {
        a.current = a.from;
        a.velocity = 0;
        return false;
      }
      const { x, v } = solveSpring(spec, a.from, a.target, a.v0, t);
      let done: boolean;
      if (spec.timed) {
        done = t >= spec.duration;
      } else {
        const granular = Math.abs(a.target - a.from) < 5;
        done = Math.abs(v) <= (granular ? 0.01 : 2) && Math.abs(a.target - x) <= (granular ? 0.005 : 0.5);
      }
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
      // 系统「减弱动态效果」由组件自己处理（stretch / bounce 归零），这里不让 Reanimated 直接跳到终点
      reduceMotion: false,
    } as MotionSpringAnimation;
  }) as unknown as number;
}

const CANCELLED = State.CANCELLED;

export function LiquidToggle({
  color = "#34C759",
  stretch = 0.6,
  size = 96,
  duration = 0.5,
  bounce = 0.35,
  value,
  onValueChange,
}: LiquidToggleProps) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const pal = PALETTE[scheme];
  const reduce = useReducedMotion();
  const g: Geo = useMemo(() => geometry(size), [size]);

  const controlled = value !== undefined;
  const [inner, setInner] = useState(false);
  const on = controlled ? !!value : inner;
  const [tick, setTick] = useState(0);

  // UI 线程上的「当前状态」（相当于网页版的 onRef）
  const onSV = useSharedValue(on);
  // 滑块左右两条边（轨道内坐标），以及颜色有多「满」
  const xl = useSharedValue(on ? g.travel : 0);
  const xr = useSharedValue(on ? g.T : g.d);
  const level = useSharedValue(on ? 1 : 0);
  // 拖拽状态
  const dragging = useSharedValue(false);
  const dragged = useSharedValue(false);
  const lastTx = useSharedValue(0);

  const s = reduce ? 0 : stretch;
  const b = reduce ? 0 : bounce;

  // 所有弹簧参数在 JS 线程算好，worklet 直接捕获
  const springs = useMemo(() => {
    const k = 900;
    const trailK = k * (1 - 0.8 * s) + 60;
    return {
      lead: timed(duration, b),
      level: timed(duration * 0.9, 0),
      trail: timed(duration * (1 + s * 0.7), Math.min(0.9, b * (1 + s * 0.5))),
      trailDelay: s * duration * 0.2,
      quick: physics(520, 34),
      dragLead: physics(k, 2 * Math.sqrt(k) * 0.9),
      dragTrail: physics(trailK, 2 * Math.sqrt(trailK) * 0.75),
    };
  }, [duration, b, s]);

  // 尺寸变化时直接跳到当前状态的静止位置
  useEffect(() => {
    const st = onSV.value;
    xl.value = st ? g.travel : 0;
    xr.value = st ? g.T : g.d;
    level.value = st ? 1 : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  const settle = (next: boolean) => {
    "worklet";
    const Lt = next ? g.travel : 0;
    const Rt = next ? g.T : g.d;
    const right = Rt >= xr.value;
    const lead = right ? xr : xl;
    const leadT = right ? Rt : Lt;
    const trail = right ? xl : xr;
    const trailT = right ? Lt : Rt;
    lead.value = motionSpring(leadT, springs.lead);
    level.value = motionSpring(next ? 1 : 0, springs.level);
    trail.value = motionSpring(trailT, springs.trail, springs.trailDelay);
  };

  const notify = (next: boolean) => {
    if (!controlled) setInner(next);
    onValueChange?.(next);
    setTick((t) => t + 1);
  };

  const commit = (next: boolean) => {
    "worklet";
    onSV.value = next;
    settle(next);
    runOnJS(notify)(next);
  };

  // 受控值从外部变化，或父组件没接受这次切换 → 把滑块送回 / 送到对应的一端
  useEffect(() => {
    if (onSV.value === on) return;
    onSV.value = on;
    runOnUI(settle)(on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, tick]);

  /* ---------- 按压 / 拖拽 ---------- */
  const pressDown = () => {
    "worklet";
    dragging.value = true;
    dragged.value = false;
    lastTx.value = 0;
    // 按住时滑块向内变宽
    if (onSV.value) xl.value = motionSpring(g.travel - g.wide, springs.quick);
    else xr.value = motionSpring(g.d + g.wide, springs.quick);
  };

  const move = (dx: number) => {
    "worklet";
    if (!dragging.value) return;
    const dir = Math.sign(dx - lastTx.value);
    lastTx.value = dx;
    if (!dragged.value && Math.abs(dx) < 4) return;
    dragged.value = true;
    const kw = g.d + g.wide;
    const hi = g.T - kw;
    const base = onSV.value ? hi : 0;
    // 拖过头时橡皮筋：越拉越难，最多再挤进去 rubberMax，滑块被压在墙上变窄
    const rubberMax = g.d * 0.22;
    const rubber = (o: number) => rubberMax * (1 - 1 / (o / (rubberMax * 2) + 1));
    let p = base + dx;
    level.value = clamp(p / hi, 0, 1);
    if (p < 0) p = -rubber(-p);
    else if (p > hi) p = hi + rubber(p - hi);
    if (dir >= 0) {
      xr.value = motionSpring(p + kw, springs.dragLead);
      xl.value = motionSpring(p, springs.dragTrail);
    } else {
      xl.value = motionSpring(p, springs.dragLead);
      xr.value = motionSpring(p + kw, springs.dragTrail);
    }
  };

  const release = (vx: number) => {
    "worklet";
    if (!dragging.value) return;
    dragging.value = false;
    if (!dragged.value) {
      commit(!onSV.value);
      return;
    }
    // 按松手时的位置 + 速度往前「投」一段再判断，甩一下就能切换
    const kw = g.d + g.wide;
    const center = (xl.value + xr.value) / 2 + clamp(vx * 0.12, -g.T, g.T);
    const next = center > kw / 2 + (g.T - kw) / 2;
    if (next !== onSV.value) commit(next);
    else settle(next);
  };

  const cancel = () => {
    "worklet";
    if (!dragging.value) return;
    dragging.value = false;
    settle(onSV.value);
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .shouldCancelWhenOutside(false)
    .onBegin(() => {
      "worklet";
      pressDown();
    })
    .onUpdate((e) => {
      "worklet";
      move(e.translationX);
    })
    .onFinalize((e) => {
      "worklet";
      if (e.state === CANCELLED) cancel();
      else release(e.velocityX);
    });

  const toggleFromA11y = () => {
    "worklet";
    commit(!onSV.value);
  };

  /* ---------- 由左右两条边推导出滑块的位置 / 宽度等；后沿越过前沿时保留最小宽度（被挤扁） ---------- */
  const knobStyle = useAnimatedStyle(() => {
    const minW = g.d * 0.62;
    const R = clamp(xr.value, minW, g.T);
    const L = clamp(xl.value, 0, g.T - minW);
    const w = Math.max(R - L, minW);
    const left = Math.min(L, R - minW);
    const scaleY = w >= g.d ? 1 - Math.min((w - g.d) / g.d, 1) * 0.2 : 1 + ((g.d - w) / g.d) * 0.4;
    return { width: w, transform: [{ translateX: left }, { scaleY }] };
  });

  const fillStyle = useAnimatedStyle(() => {
    const minW = g.d * 0.62;
    const R = clamp(xr.value, minW, g.T);
    return { width: R + g.pad * 2, opacity: level.value };
  });

  return (
    <View style={styles.body}>
      <GestureDetector gesture={pan}>
        <View
          accessible
          accessibilityRole="switch"
          accessibilityLabel="液态开关"
          accessibilityState={{ checked: on }}
          onAccessibilityTap={() => runOnUI(toggleFromA11y)()}
          style={[
            styles.track,
            {
              width: g.W,
              height: g.H,
              borderRadius: g.H / 2,
              backgroundColor: pal.track,
              boxShadow: `inset 0 0 0 1px ${pal.ring}, inset 0 2px 4px rgba(0,0,0,0.06)`,
            },
          ]}
        >
          <Animated.View
            pointerEvents="none"
            style={[styles.fill, { height: g.H, borderRadius: g.H / 2, backgroundColor: color }, fillStyle]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.knob,
              {
                top: g.pad,
                left: g.pad,
                height: g.d,
                borderRadius: g.d / 2,
                backgroundColor: pal.knob,
                backgroundImage: `linear-gradient(180deg, ${pal.knob}, ${pal.knobBottom})`,
                boxShadow:
                  "0 0 0 0.5px rgba(0,0,0,0.04), 0 3px 8px rgba(0,0,0,0.16), 0 1px 1px rgba(0,0,0,0.08)",
              },
              knobStyle,
            ]}
          />
        </View>
      </GestureDetector>
      <Caption on={on} color={pal.muted} width={Math.max(g.W, 64)} />
    </View>
  );
}

/* ---------- 文案「已开启 / 已关闭」：新文案带着位移淡入，旧文案反向淡出 ---------- */
// 网页版：spring { stiffness: 420, damping: 32 }；初次渲染不做动画（initial={false}）
const CAPTION_SPRING = physics(420, 32);

function Caption({ on, color, width }: { on: boolean; color: string; width: number }) {
  const onY = useSharedValue(0);
  const onO = useSharedValue(on ? 1 : 0);
  const offY = useSharedValue(0);
  const offO = useSharedValue(on ? 0 : 1);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    runOnUI(animateCaption)(on, onY, onO, offY, offO);
  }, [on, onY, onO, offY, offO]);

  const onStyle = useAnimatedStyle(() => ({ opacity: clamp(onO.value, 0, 1), transform: [{ translateY: onY.value }] }));
  const offStyle = useAnimatedStyle(() => ({ opacity: clamp(offO.value, 0, 1), transform: [{ translateY: offY.value }] }));

  return (
    <View style={[styles.caption, { width }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Animated.Text style={[styles.captionText, { color }, onStyle]}>已开启</Animated.Text>
      <Animated.Text style={[styles.captionText, { color }, offStyle]}>已关闭</Animated.Text>
    </View>
  );
}

function animateCaption(
  on: boolean,
  onY: SharedValue<number>,
  onO: SharedValue<number>,
  offY: SharedValue<number>,
  offO: SharedValue<number>,
) {
  "worklet";
  // 与网页一致：打开时「已开启」从下方 +10 进入、「已关闭」向下 +10 退出；关闭时都在 -10
  const off = on ? 10 : -10;
  const [inY, inO, outY, outO] = on ? [onY, onO, offY, offO] : [offY, offO, onY, onO];
  if (inO.value < 0.01) {
    inY.value = off;
    inO.value = 0;
  }
  inY.value = motionSpring(0, CAPTION_SPRING);
  inO.value = motionSpring(1, CAPTION_SPRING);
  outY.value = motionSpring(off, CAPTION_SPRING);
  outO.value = motionSpring(0, CAPTION_SPRING);
}

const styles = StyleSheet.create({
  body: {
    alignItems: "center",
    gap: 18,
  },
  track: {
    position: "relative",
  },
  fill: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  knob: {
    position: "absolute",
  },
  caption: {
    height: 20,
    overflow: "hidden",
  },
  captionText: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 20,
    lineHeight: 20,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "500",
  },
});
