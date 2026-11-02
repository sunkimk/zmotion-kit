// 圆点加载（React Native 版）：四种圆点循环（波浪 / 轨道 / 脉冲 / 弹跳），圆点错峰运动。
// 完成时圆点收拢到中心、长成圆章、画出对勾，停一会儿再散开继续加载。
// 对应网站 src/cases/dot-loader（React + CSS keyframes / transition）。
// 循环动画：一根 UI 线程上的时钟（useFrameCallback，完成时暂停 = animation-play-state: paused），
// 每个圆点按 CSS keyframes 逐段取样（每段各自的缓动、同样的负延迟错峰）。
// 「完成」是一组可打断的 CSS transition：withDelay + withTiming，从当前值出发，时长 / 延迟 / 贝塞尔和网站一致。
// 不依赖 react-native-svg：对勾是两段圆头线段（View），长度跟着描边进度变化。
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, useColorScheme, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  runOnUI,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

export type DotLoaderVariant = 'wave' | 'orbit' | 'pulse' | 'bounce';

export type DotLoaderProps = {
  /** 加载动画的样式：波浪 / 轨道 / 脉冲 / 弹跳 */
  variant?: DotLoaderVariant;
  /** 圆点的数量（3–12），容器太窄时圆点会自动变小 */
  count?: number;
  /** 循环动画的速度倍率（0.3–2.5） */
  speed?: number;
  /** 单个圆点的直径，px（4–22） */
  dotSize?: number;
  /** 圆点和圆章的颜色 */
  color?: string;
  /** 受控：加载是否完成。不传则和网站一样，点一下模拟完成，停 1.8s 自动回到加载 */
  done?: boolean;
  /** 点击加载区域时回调（受控模式下由宿主决定怎么处理） */
  onPress?: () => void;
  /** 加载中的文案 */
  loadingText?: string;
  /** 完成后的文案 */
  doneText?: string;
};

const VARIANTS: DotLoaderVariant[] = ['wave', 'orbit', 'pulse', 'bounce'];
/** 完成后停留多久再回到加载 */
const HOLD_MS = 1800;
// 网站在系统「减弱动态效果」下只把循环换成淡入淡出，完成过渡照常走，所以这里不让 Reanimated 直接跳到终点
const NEVER = ReduceMotion.Never;

// ---------- 曲线（worklet，UI 线程上跑） ----------

/** CSS 的 cubic-bezier(x1, y1, x2, y2)，y 可以超出 0…1（回弹曲线） */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, p: number): number {
  'worklet';
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let t = p;
  for (let i = 0; i < 8; i++) {
    const x = ((ax * t + bx) * t + cx) * t - p;
    if (Math.abs(x) < 1e-7) return ((ay * t + by) * t + cy) * t;
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d) < 1e-6) break;
    t -= x / d;
  }
  let lo = 0;
  let hi = 1;
  t = p;
  for (let i = 0; i < 40; i++) {
    const x = ((ax * t + bx) * t + cx) * t;
    if (Math.abs(x - p) < 1e-7) break;
    if (x < p) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return ((ay * t + by) * t + cy) * t;
}

// 曲线编号：keyframes 取样时按编号选缓动（worklet 里传函数数组不方便）
const C_LINEAR = 0;
const C_EASE_OUT = 1;
const C_EASE_IN_OUT = 2;
const C_OUT_CUBIC = 3;
const C_IN_CUBIC = 4;

function ease(id: number, t: number): number {
  'worklet';
  if (id === C_EASE_OUT) return cubicBezier(0, 0, 0.58, 1, t);
  if (id === C_EASE_IN_OUT) return cubicBezier(0.42, 0, 0.58, 1, t);
  if (id === C_OUT_CUBIC) return cubicBezier(0.33, 1, 0.68, 1, t);
  if (id === C_IN_CUBIC) return cubicBezier(0.32, 0, 0.67, 0, t);
  return t;
}

/** keyframes 取样：at / val 一一对应；curves[j] 作用在第 j 段（只给一个就每段都用它） */
function kf(p: number, at: number[], val: number[], curves: number[]): number {
  'worklet';
  if (p <= at[0]) return val[0];
  for (let j = 1; j < at.length; j++) {
    if (p <= at[j]) {
      const span = at[j] - at[j - 1];
      if (span <= 0) return val[j];
      const c = curves[Math.min(j - 1, curves.length - 1)];
      return val[j - 1] + (val[j] - val[j - 1]) * ease(c, (p - at[j - 1]) / span);
    }
  }
  return val[val.length - 1];
}

/** CSS 循环的相位：duration / delay 都除以 speed，等价于在「乘过 speed 的时间 u」上取样；负 delay = 提前开跑 */
function phase(u: number, delay: number, dur: number): number {
  'worklet';
  const x = (u - delay) / dur;
  return x - Math.floor(x);
}

/** 减弱动态效果：循环换成 dl-fade（透明度 0.3 ↔ 1，ease-in-out），保留各自的时长和错峰 */
function fadeKF(p: number): number {
  'worklet';
  return kf(p, [0, 0.5, 1], [0.3, 1, 0.3], [C_EASE_IN_OUT]);
}

const clamp01 = (v: number) => {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

const linear = (t: number) => {
  'worklet';
  return t;
};
const cssEaseIn = (t: number) => {
  'worklet';
  return cubicBezier(0.42, 0, 1, 1, t);
};
const cssEaseOut = (t: number) => {
  'worklet';
  return cubicBezier(0, 0, 0.58, 1, t);
};
/** --dl-ease-in */
const gatherEase = (t: number) => {
  'worklet';
  return cubicBezier(0.5, 0, 0.2, 1, t);
};
/** --dl-spring（带回弹） */
const springEase = (t: number) => {
  'worklet';
  return cubicBezier(0.28, 1.3, 0.36, 1, t);
};
/** 圆章缩回 */
const badgeOutEase = (t: number) => {
  'worklet';
  return cubicBezier(0.4, 0, 0.2, 1, t);
};
/** 对勾描边 */
const drawEase = (t: number) => {
  'worklet';
  return cubicBezier(0.65, 0, 0.35, 1, t);
};

type Ease = (t: number) => number;
const tween = (to: number, ms: number, easing: Ease, delay = 0) =>
  delay > 0
    ? withDelay(delay, withTiming(to, { duration: ms, easing, reduceMotion: NEVER }), NEVER)
    : withTiming(to, { duration: ms, easing, reduceMotion: NEVER });

// ---------- 颜色 ----------

function rgba(hex: string, a: number): string {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const v = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(v)) return `rgba(0,0,0,${a})`;
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

// ---------- 组件 ----------

export function DotLoader({
  variant = 'wave',
  count = 5,
  speed = 1,
  dotSize = 14,
  color = '#0A84FF',
  done: doneProp,
  onPress,
  loadingText = '正在加载',
  doneText = '加载完成',
}: DotLoaderProps) {
  const dark = useColorScheme() === 'dark';
  const reduce = useReducedMotion();
  const [width, setWidth] = useState<number | null>(null);
  const [internalDone, setInternalDone] = useState(false);
  const controlled = doneProp !== undefined;
  const done = controlled ? !!doneProp : internalDone;
  const doneRef = useRef(done);
  doneRef.current = done;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const n = Math.min(12, Math.max(1, Math.round(count)));
  const v: DotLoaderVariant = VARIANTS.includes(variant) ? variant : 'wave';
  const sp = Math.max(0.1, speed);
  // 圆点尺寸：参数值，窄容器里自动缩小，保证一排放得下
  const s = width === null ? dotSize : Math.max(1, Math.min(dotSize, (width - 56) / (n * 1.8)));
  // 圆章直径是圆点的 k 倍，小圆点时保证对勾仍然看得清
  const k = Math.max(3.6, 44 / Math.max(4, dotSize));

  // 循环时钟（秒）：完成时暂停，回到加载时从停下的相位接着走
  const loop = useSharedValue(0);
  const paused = useSharedValue(done ? 1 : 0);
  useFrameCallback((f) => {
    'worklet';
    if (paused.value) return;
    const dt = f.timeSincePreviousFrame ?? 0;
    loop.value += Math.min(dt, 100) / 1000;
  });

  // 完成过渡，都是 0…1 的进度
  const gather = useSharedValue(done ? 1 : 0); // 圆点收拢
  const fade = useSharedValue(done ? 0 : 1); // 圆点透明度
  const grow = useSharedValue(done ? 1 : 0); // 圆章 scale：0 = 1/k，1 = 1
  const badgeOp = useSharedValue(done ? 1 : 0);
  const check = useSharedValue(done ? 1 : 0); // 对勾描边进度
  const press = useSharedValue(1);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (done) {
      paused.value = 1;
      gather.value = tween(1, 300, gatherEase);
      fade.value = tween(0, 100, linear, 200);
      grow.value = tween(1, 500, springEase, 200);
      badgeOp.value = tween(1, 60, linear, 200);
      check.value = tween(1, 320, drawEase, 340);
    } else {
      paused.value = 0;
      // 回来：等圆章缩回去，再带一点回弹散开
      gather.value = tween(0, 460, springEase, 160);
      fade.value = tween(1, 120, linear, 160);
      grow.value = tween(0, 260, badgeOutEase, 40);
      badgeOp.value = tween(0, 100, linear, 200);
      check.value = tween(0, 140, cssEaseIn);
    }
  }, [done, paused, gather, fade, grow, badgeOp, check]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const tapped = () => {
    onPress?.();
    if (controlled) return;
    clearTimeout(timer.current);
    if (doneRef.current) {
      setInternalDone(false);
      return;
    }
    setInternalDone(true);
    timer.current = setTimeout(() => setInternalDone(false), HOLD_MS);
  };
  const tapRef = useRef(tapped);
  tapRef.current = tapped;

  // :active { scale: 0.96 }，transition: scale 0.09s ease-out；在按钮里松手才算点击
  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .maxDuration(60_000)
        .shouldCancelWhenOutside(true)
        .onBegin(() => {
          press.value = withTiming(0.96, { duration: 90, easing: cssEaseOut, reduceMotion: NEVER });
        })
        .onFinalize((_e, success) => {
          press.value = withTiming(1, { duration: 90, easing: cssEaseOut, reduceMotion: NEVER });
          if (success) tapRef.current();
        }),
    [press]
  );
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const set = setSize(v, n, s);
  const B = s * k;
  // min-width: 120px; min-height: size * k + 24px; padding: 12px 20px
  const w = Math.max(120, Math.max(set.w, B) + 40);
  const h = Math.max(B + 24, Math.max(set.h, B) + 24);
  const label = controlled
    ? done
      ? doneText
      : loadingText
    : done
      ? '加载完成，点击重新加载'
      : '正在加载，点击模拟完成';

  return (
    <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', gap: 14 }} onLayout={onLayout}>
      {width !== null && (
        <>
          <GestureDetector gesture={gesture}>
            <Animated.View
              accessible
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ busy: !done }}
              accessibilityActions={[{ name: 'activate' }]}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === 'activate') tapped();
              }}
              style={[{ width: w, height: h, borderRadius: 24 }, pressStyle]}
            >
              <View
                key={`${v}-${n}`}
                style={{ position: 'absolute', left: (w - set.w) / 2, top: (h - set.h) / 2, width: set.w, height: set.h }}
              >
                {Array.from({ length: n }, (_, i) => (
                  <Slot
                    key={i}
                    i={i}
                    n={n}
                    s={s}
                    v={v}
                    sp={sp}
                    reduce={reduce}
                    color={color}
                    shadow={dark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.28)'}
                    set={set}
                    loop={loop}
                    gather={gather}
                    fade={fade}
                  />
                ))}
              </View>
              <Badge B={B} k={k} left={(w - B) / 2} top={(h - B) / 2} color={color} grow={grow} op={badgeOp} check={check} />
            </Animated.View>
          </GestureDetector>
          <Caption done={done} loadingText={loadingText} doneText={doneText} />
        </>
      )}
    </View>
  );
}

function setSize(v: DotLoaderVariant, n: number, s: number): { w: number; h: number } {
  const row = (gap: number) => n * s + (n - 1) * gap * s;
  if (v === 'pulse') return { w: row(0.9), h: 2.8 * s };
  if (v === 'bounce') return { w: row(0.75), h: 3.8 * s };
  if (v === 'orbit') return { w: s * 5.2 + 16, h: s * 5.2 + 16 };
  return { w: row(0.75), h: 2.6 * s };
}

// ---------- 一个圆点（含脉冲外圈 / 弹跳影子 / 轨道摆臂） ----------

const WAVE_AT = [0, 0.5, 1];
const PULSE_AT = [0, 0.3, 0.7, 1];
const RING_AT = [0, 0.3, 0.75, 1];
const SQUASH_AT = [0, 0.14, 0.5, 0.86, 1];

function Slot({
  i,
  n,
  s,
  v,
  sp,
  reduce,
  color,
  shadow,
  set,
  loop,
  gather,
  fade,
}: {
  i: number;
  n: number;
  s: number;
  v: DotLoaderVariant;
  sp: number;
  reduce: boolean;
  color: string;
  shadow: string;
  set: { w: number; h: number };
  loop: SharedValue<number>;
  gather: SharedValue<number>;
  fade: SharedValue<number>;
}) {
  const mid = (n - 1) / 2;
  const gap = v === 'pulse' ? 1.9 : 1.75;
  const cx = (i - mid) * s * gap;
  const orbit = v === 'orbit';
  const slotW = orbit ? set.w : s;
  const slotH = orbit ? set.h : v === 'bounce' ? 3.8 * s : s;
  // 收拢目标：移到中心（弹跳还要上移到正中），scale(0.7)；轨道只缩到 0.1
  const gx = -cx;
  const gy = v === 'bounce' ? -1.4 * s : 0;
  const t = n > 1 ? i / (n - 1) : 0;

  const slotStyle = useAnimatedStyle(() => {
    const m = gather.value;
    return {
      opacity: clamp01(fade.value),
      transform: orbit
        ? [{ scale: 1 - 0.9 * m }]
        : [{ translateX: gx * m }, { translateY: gy * m }, { scale: 1 - 0.3 * m }],
    };
  });

  // 圆点自己（轨道是整根摆臂）的循环
  const dotStyle = useAnimatedStyle(() => {
    const u = loop.value * sp;
    if (v === 'wave') {
      const p = phase(u, i * 0.11 - 3.3, 1.1);
      if (reduce) return { opacity: fadeKF(p), transform: [{ translateY: 0 }, { scale: 1 }] };
      return {
        opacity: kf(p, WAVE_AT, [0.4, 1, 0.4], [C_EASE_IN_OUT]),
        transform: [
          { translateY: kf(p, WAVE_AT, [0.5, -0.5, 0.5], [C_EASE_IN_OUT]) * s },
          { scale: kf(p, WAVE_AT, [0.86, 1, 0.86], [C_EASE_IN_OUT]) },
        ],
      };
    }
    if (v === 'pulse') {
      const p = phase(u, i * 0.15 - 12, Math.max(1.2, n * 0.15 + 0.5));
      if (reduce) return { opacity: fadeKF(p), transform: [{ scale: 1 }] };
      return {
        opacity: kf(p, PULSE_AT, [0.3, 1, 0.3, 0.3], [C_EASE_IN_OUT]),
        transform: [{ scale: kf(p, PULSE_AT, [0.55, 1.05, 0.55, 0.55], [C_EASE_IN_OUT]) }],
      };
    }
    if (v === 'bounce') {
      const p = phase(u, i * 0.12 - 6.4, 0.64);
      if (reduce) return { opacity: fadeKF(p), transform: [{ translateY: 0 }, { scaleX: 1 }, { scaleY: 1 }] };
      // 上抛减速（easeOutCubic）、下落加速（easeInCubic）；落地压扁，以底边为原点
      return {
        opacity: 1,
        transform: [
          { translateY: kf(p, WAVE_AT, [0, -2, 0], [C_OUT_CUBIC, C_IN_CUBIC]) * s },
          { scaleX: kf(p, SQUASH_AT, [1.3, 0.92, 1, 0.92, 1.3], [C_LINEAR]) },
          { scaleY: kf(p, SQUASH_AT, [0.72, 1.1, 1, 1.1, 0.72], [C_LINEAR]) },
        ],
      };
    }
    // 轨道：整根摆臂绕中心转一圈，cubic-bezier(0.55, 0.08, 0.35, 0.95)
    const p = phase(u, i * 0.09 - 2.8, 1.4);
    if (reduce) return { opacity: fadeKF(p), transform: [{ rotate: '0deg' }] };
    return { opacity: 1, transform: [{ rotate: `${360 * cubicBezier(0.55, 0.08, 0.35, 0.95, p)}deg` }] };
  });

  // 脉冲外圈 / 弹跳影子
  const auxStyle = useAnimatedStyle(() => {
    const u = loop.value * sp;
    if (v === 'pulse') {
      const p = phase(u, i * 0.15 - 12, Math.max(1.2, n * 0.15 + 0.5));
      if (reduce) return { opacity: fadeKF(p), transform: [{ scale: 1 }] };
      return {
        opacity: kf(p, RING_AT, [0, 0.5, 0, 0], [C_EASE_OUT]),
        transform: [{ scale: kf(p, RING_AT, [1, 1, 2.6, 2.6], [C_EASE_OUT]) }],
      };
    }
    if (v === 'bounce') {
      const p = phase(u, i * 0.12 - 6.4, 0.64);
      if (reduce) return { opacity: fadeKF(p), transform: [{ scale: 1 }] };
      return {
        opacity: kf(p, WAVE_AT, [1, 0.3, 1], [C_OUT_CUBIC, C_IN_CUBIC]),
        transform: [{ scale: kf(p, WAVE_AT, [1, 0.45, 1], [C_OUT_CUBIC, C_IN_CUBIC]) }],
      };
    }
    return { opacity: 0, transform: [{ scale: 1 }] };
  });

  const dot = { width: s, height: s, borderRadius: s / 2, backgroundColor: color };

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: set.w / 2 + (orbit ? 0 : cx) - slotW / 2,
          top: set.h / 2 - slotH / 2,
          width: slotW,
          height: slotH,
        },
        slotStyle,
      ]}
    >
      {v === 'wave' && <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, dot, dotStyle]} />}
      {v === 'pulse' && (
        <>
          <Animated.View
            style={[
              { position: 'absolute', left: 0, top: 0, width: s, height: s, borderRadius: s / 2, borderWidth: 1.5, borderColor: color },
              auxStyle,
            ]}
          />
          <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, dot, dotStyle]} />
        </>
      )}
      {v === 'bounce' && (
        <>
          {/* 影子：底边比圆点低 0.22 个圆点，radial-gradient(closest-side, shadow, transparent) */}
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: 0,
                top: 3.8 * s - 0.32 * s + 0.22 * s,
                width: s,
                height: 0.32 * s,
                borderRadius: s / 2,
                backgroundImage: `radial-gradient(closest-side, ${shadow}, rgba(0,0,0,0))`,
              },
              auxStyle,
            ]}
          />
          <Animated.View
            style={[{ position: 'absolute', left: 0, top: 2.8 * s, transformOrigin: ['50%', '100%', 0] }, dot, dotStyle]}
          />
        </>
      )}
      {v === 'orbit' && (
        <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: slotW, height: slotH }, dotStyle]}>
          {/* 头大尾小 */}
          <View
            style={[
              { position: 'absolute', left: (slotW - s) / 2, top: 0, opacity: 1 - t * 0.65, transform: [{ scale: 1 - t * 0.55 }] },
              dot,
            ]}
          />
        </Animated.View>
      )}
    </Animated.View>
  );
}

// ---------- 圆章 + 对勾 ----------

// 对勾路径 M6.5 12.5 l3.6 3.6 L17.5 8.5（viewBox 24，svg 占圆章的 60%），拆成两段
const SEG1 = { x: 6.5, y: 12.5, len: Math.hypot(3.6, 3.6), deg: 45 };
const SEG2 = { x: 10.1, y: 16.1, len: Math.hypot(7.4, 7.6), deg: (Math.atan2(-7.6, 7.4) * 180) / Math.PI };
const CHECK_LEN = SEG1.len + SEG2.len;

function Badge({
  B,
  k,
  left,
  top,
  color,
  grow,
  op,
  check,
}: {
  B: number;
  k: number;
  left: number;
  top: number;
  color: string;
  grow: SharedValue<number>;
  op: SharedValue<number>;
  check: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: clamp01(op.value),
    transform: [{ scale: 1 / k + (1 - 1 / k) * grow.value }],
  }));
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left,
          top,
          width: B,
          height: B,
          borderRadius: B / 2,
          backgroundColor: color,
          // box-shadow: 0 10px 28px -10px color-mix(color 80%, transparent)
          boxShadow: `0 10px 28px -10px ${rgba(color, 0.8)}`,
          pointerEvents: 'none',
        },
        style,
      ]}
    >
      <CheckSeg B={B} seg={SEG1} before={0} check={check} />
      <CheckSeg B={B} seg={SEG2} before={SEG1.len} check={check} />
    </Animated.View>
  );
}

function CheckSeg({
  B,
  seg,
  before,
  check,
}: {
  B: number;
  seg: { x: number; y: number; len: number; deg: number };
  before: number;
  check: SharedValue<number>;
}) {
  const u = (B * 0.6) / 24;
  const o = B * 0.2;
  const sw = 2.6 * u;
  const style = useAnimatedStyle(() => {
    // 已经画出的长度（stroke-dashoffset 1 → 0）
    const drawn = Math.min(Math.max(clamp01(check.value) * CHECK_LEN - before, 0), seg.len);
    return { width: drawn * u + sw, opacity: drawn > 0.0001 ? 1 : 0 };
  });
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: o + seg.x * u - sw / 2,
          top: o + seg.y * u - sw / 2,
          height: sw,
          borderRadius: sw / 2,
          backgroundColor: '#fff',
          // 绕起点（圆头的圆心）旋转
          transformOrigin: [sw / 2, sw / 2, 0],
          transform: [{ rotate: `${seg.deg}deg` }],
        },
        style,
      ]}
    />
  );
}

// ---------- 文案：新的从下方 8px 进来，旧的往上 8px 出去，spring { stiffness: 520, damping: 34 } ----------

const CAPTION_SPRING = { stiffness: 520, damping: 34, mass: 1, reduceMotion: NEVER };

function swapCaption(inY: SharedValue<number>, inO: SharedValue<number>, outY: SharedValue<number>, outO: SharedValue<number>) {
  'worklet';
  if (inO.value < 0.01) {
    inY.value = 8;
    inO.value = 0;
  }
  inY.value = withSpring(0, CAPTION_SPRING);
  inO.value = withSpring(1, CAPTION_SPRING);
  outY.value = withSpring(-8, CAPTION_SPRING);
  outO.value = withSpring(0, CAPTION_SPRING);
}

function Caption({ done, loadingText, doneText }: { done: boolean; loadingText: string; doneText: string }) {
  const aY = useSharedValue(0);
  const aO = useSharedValue(done ? 0 : 1);
  const bY = useSharedValue(0);
  const bO = useSharedValue(done ? 1 : 0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (done) runOnUI(swapCaption)(bY, bO, aY, aO);
    else runOnUI(swapCaption)(aY, aO, bY, bO);
  }, [done, aY, aO, bY, bO]);

  const aStyle = useAnimatedStyle(() => ({ opacity: clamp01(aO.value), transform: [{ translateY: aY.value }] }));
  const bStyle = useAnimatedStyle(() => ({ opacity: clamp01(bO.value), transform: [{ translateY: bY.value }] }));
  const text = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: 0,
    height: 18,
    lineHeight: 18,
    fontSize: 13,
    textAlign: 'center' as const,
    color: '#8a8a8e',
  };

  return (
    <View style={{ alignSelf: 'stretch', height: 18, overflow: 'hidden' }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Animated.Text numberOfLines={1} style={[text, aStyle]}>
        {loadingText}
      </Animated.Text>
      <Animated.Text numberOfLines={1} style={[text, bStyle]}>
        {doneText}
      </Animated.Text>
    </View>
  );
}

