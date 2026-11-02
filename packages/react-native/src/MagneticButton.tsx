// 磁吸按钮（React Native 版）：指针靠近时按钮被「吸」过去，文字比按钮跑得更远形成视差，磁场随距离渐亮；
// 离开后弹簧回位，点击泛起涟漪，文案换成「已开始」1.5 秒后换回。对应网站 src/cases/magnetic-button。
//
// 指针 / 触屏：
// - iPad 触控板 / 鼠标、Android 鼠标（Gesture.Hover）：和网页鼠标一样，悬停就有磁吸，悬在按钮上放大到 1.03。
// - 触屏：网页在粗指针上靠「按住移动时的 pointermove + 抬手 pointerup 复位」，根节点 touch-action: pan-y、按钮 touch-action: none。
//   这里照搬：按在按钮上立刻接管（缩到 0.95，移动时按钮跟着吸，抬手还在按钮上就算点击）；
//   按在按钮外面先看方向，横向移动才接管（吸），纵向移动交还给外层 ScrollView 滚动（= pan-y）。抬手 / 被打断都弹回原位。
//   触摸只有一个 Pan 手势负责（manualActivation），悬停是另一种输入，由 Hover 手势负责，两者同时挂在根节点上。
//
// 动画：按钮位移 x / y、磁场亮度都是 motion 的 useSpring（每次目标改变都从当前值、带着当前速度重新起弹簧，速度不截断），
// 用自定义 Reanimated 动画按 motion 的弹簧解析解逐帧求值；文字 / 箭头视差是对 x / y 做软限幅（tanh），在 useAnimatedStyle 里算。
// 依赖：react-native-reanimated + react-native-gesture-handler；不依赖 svg，图标用圆头细条拼。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View, useColorScheme, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  defineAnimation,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type AnimationObject,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

export type MagneticButtonProps = {
  /** 吸力：按钮跟随指针的比例，越大被拉得越远（0.1–1） */
  strength?: number;
  /** 磁场半径：指针距离按钮边缘多近时开始产生吸引（px，30–160） */
  radius?: number;
  /** 弹簧刚度：越大跟手越紧，越小越黏滞、回弹越慢（60–600） */
  stiffness?: number;
  /** 文字视差：文字位移是按钮位移的几倍，1 为不视差（1–2.5） */
  parallax?: number;
  /** 按钮与磁场光晕的颜色 */
  color?: string;
  /** 按钮文案（默认「开始体验」） */
  title?: string;
  /** 点击后 1.5 秒内显示的文案（默认「已开始」） */
  doneTitle?: string;
  /** 点击回调 */
  onPress?: () => void;
  /** 根节点样式；默认铺满父容器（width / height 100%），不铺底色 */
  style?: StyleProp<ViewStyle>;
};

/* ---------- 曲线 ---------- */
// 和网站一样：系统「减弱动态效果」只减小吸力，其余动画照常
const NEVER = ReduceMotion.Never;
/** 悬停放大 / 回弹：{ duration: 0.26, ease: [0.28, 1.3, 0.36, 1] } */
const POP = { duration: 260, easing: Easing.bezier(0.28, 1.3, 0.36, 1), reduceMotion: NEVER };
/** 按下：{ duration: 0.09, ease: [0.3, 0, 0.5, 1] } */
const PRESS = { duration: 90, easing: Easing.bezier(0.3, 0, 0.5, 1), reduceMotion: NEVER };
/** 涟漪：0.6s，ease [0.2, 0.7, 0.3, 1] */
const RIPPLE = { duration: 600, easing: Easing.bezier(0.2, 0.7, 0.3, 1), reduceMotion: NEVER };

const clamp = (v: number, lo: number, hi: number) => {
  "worklet";
  return Math.min(hi, Math.max(lo, v));
};
const smooth = (t: number) => {
  "worklet";
  return t * t * (3 - 2 * t);
};
/** 软限幅：小位移原样通过，越往外越难拉，永远不超过 max */
const soft = (v: number, max: number) => {
  "worklet";
  return max * Math.tanh(v / max);
};

/* ---------- 颜色 ---------- */

function rgbOf(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return [0, 0, 0];
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1].slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
const rgba = ([r, g, b]: [number, number, number], a: number) => `rgba(${r},${g},${b},${a})`;

/** 根据背景色选择黑/白文字，保证浅色按钮也可读 */
function readableText(hex: string) {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? "#111" : "#fff";
}

/**
 * 用一圈圈半透明圆叠出径向渐变（不依赖 svg / radial-gradient）：
 * alpha(ρ) 是半径比例 ρ 处的目标不透明度；返回从大到小的圆（半径比例 + 各自不透明度），叠起来后每一环正好是目标值
 */
function rings(n: number, alpha: (rho: number) => number) {
  const out: { r: number; a: number }[] = [];
  for (let k = n; k >= 1; k--) {
    const inner = alpha((k - 0.5) / n);
    const outer = k === n ? 0 : alpha((k + 0.5) / n);
    out.push({ r: k / n, a: Math.max(0, 1 - (1 - inner) / (1 - outer)) });
  }
  return out;
}
/** 高光：radial-gradient(120px circle, white .32, transparent 70%) → 半径 84 内线性衰减 */
const SHINE_R = 84;
const SHINE = rings(10, (rho) => 0.32 * (1 - rho));
/** 磁场：radial-gradient(closest-side, fill, transparent) → 中心为 1、边缘为 0（再乘 fill 的不透明度） */
const FIELD = (a0: number) => rings(10, (rho) => a0 * (1 - rho));

/* ---------- 和 motion 一致的弹簧（物理弹簧继承速度；duration 弹簧按 findSpring 换算） ---------- */

type SpringSpec = { stiffness: number; damping: number; mass: number; timed: boolean; duration: number };
const physics = (stiffness: number, damping: number, mass = 1): SpringSpec => ({ stiffness, damping, mass, timed: false, duration: 0 });

/** motion-dom spring.mjs 的 findSpring（bounce ≥ 0 的部分）：duration 是「停稳时间」 */
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
      return safeMin - (decay / angular(f, ratio)) * Math.exp(-decay * duration);
    };
    derivative = (f) => {
      const decay = f * ratio;
      const e = ratio * ratio * f * f * duration;
      const ff = Math.exp(-decay * duration);
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

/** 像 motion 的 useSpring / animate 一样驱动共享值：物理弹簧继承被打断动画的速度（不截断），duration 弹簧不继承 */
function motionSpring(toValue: number, spec: SpringSpec): number {
  "worklet";
  return defineAnimation<MotionSpringAnimation>(toValue, () => {
    "worklet";
    const onStart = (a: MotionSpringAnimation, value: number, now: number, prev: { velocity?: unknown } | null | undefined) => {
      a.from = value;
      a.target = toValue;
      a.current = value;
      a.begin = now;
      const inherited = prev && typeof prev.velocity === "number" ? prev.velocity : 0;
      a.v0 = spec.timed ? 0 : inherited;
      a.velocity = a.v0;
    };
    const onFrame = (a: MotionSpringAnimation, now: number): boolean => {
      const t = (now - a.begin) / 1000;
      const { x, v } = solveSpring(spec, a.from, a.target, a.v0, t);
      let done: boolean;
      if (spec.timed) {
        done = t >= spec.duration;
      } else {
        // motion 的默认收尾阈值：变化量很小（< 5，比如亮度）时用更细的阈值
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
      reduceMotion: false,
    } as MotionSpringAnimation;
  }) as unknown as number;
}

const POWER = physics(300, 30);
/** 文案切换：motion { type: "spring", duration: 0.38, bounce: 0.2 } */
const TEXT = timed(0.38, 0.2);

/* ---------- 组件 ---------- */

type Ripple = { id: number; x: number; y: number };

export function MagneticButton({
  strength = 0.4,
  radius = 90,
  stiffness = 220,
  parallax = 1.6,
  color = "#5B5BF6",
  title = "开始体验",
  doneTitle = "已开始",
  onPress,
  style,
}: MagneticButtonProps) {
  const dark = useColorScheme() === "dark";
  const reduce = useReducedMotion();

  const [box, setBox] = useState({ w: 0, h: 0 });
  const [btn, setBtn] = useState({ w: 0, h: 0 });
  // 根字号跟着画布走：clamp(15px, 4.4cqmin, 19px)
  const fs = clamp(Math.min(box.w, box.h) * 0.044, 15, 19);
  const lh = fs * 1.2;

  const [done, setDone] = useState(0); // 每次点击 +1，用来重启「已开始」的计时
  const [ripples, setRipples] = useState<Ripple[]>([]);

  const rgb = rgbOf(color);
  const fg = readableText(color);
  const pal = useMemo(
    () => ({
      line: rgba(rgb, dark ? 0.3 : 0.22),
      fieldRings: FIELD(dark ? 0.16 : 0.1),
      shadow: dark ? rgba([rgb[0] * 0.4, rgb[1] * 0.4, rgb[2] * 0.4].map(Math.round) as [number, number, number], 1) : rgba(rgb, 0.5),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [color, dark],
  );

  // 布局（UI 线程用）：根节点和按钮的尺寸
  const W = useSharedValue(0);
  const H = useSharedValue(0);
  const BW = useSharedValue(0);
  const BH = useSharedValue(0);
  // 按钮位移、磁场亮度、高光位置（相对按钮左上角，px）、按钮缩放
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const power = useSharedValue(0);
  const hx = useSharedValue(0);
  const hy = useSharedValue(0);
  const scale = useSharedValue(1);
  // 手势状态
  const own = useSharedValue(false); // 这次触摸是否由组件接管
  const pressed = useSharedValue(false); // 按下时在按钮上
  const hovered = useSharedValue(false);
  const sx = useSharedValue(0);
  const sy = useSharedValue(0);

  // 阻尼比 ≈ 0.68：被吸过去时有一点点过冲，松开后利落回位，不会晃个不停
  const magnet = useMemo(() => physics(stiffness, 2 * Math.sqrt(stiffness * 0.7) * 0.68, 0.7), [stiffness]);
  const k = reduce ? strength * 0.25 : strength;

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(0), 1500);
    return () => clearTimeout(t);
  }, [done]);

  /* ---------- 磁吸逻辑（和网页 onMove 一致） ---------- */

  const move = (px: number, py: number) => {
    "worklet";
    const bw = BW.value;
    const bh = BH.value;
    if (bw <= 0) return;
    const cx = W.value / 2;
    const cy = H.value / 2;
    const dx = px - cx;
    const dy = py - cy;
    // 指针到胶囊形按钮边缘的距离（按钮内部为 0）
    const half = bh / 2;
    const qx = Math.max(Math.abs(dx) - (bw / 2 - half), 0);
    const d = Math.max(Math.hypot(qx, dy) - half, 0);
    const f = d >= radius ? 0 : smooth(1 - d / radius);
    x.value = motionSpring(dx * k * f, magnet);
    y.value = motionSpring(dy * k * f, magnet);
    power.value = motionSpring(f, POWER);
    hx.value = px - (cx - bw / 2);
    hy.value = py - (cy - bh / 2);
  };

  const reset = () => {
    "worklet";
    x.value = motionSpring(0, magnet);
    y.value = motionSpring(0, magnet);
    power.value = motionSpring(0, POWER);
  };

  /** 按钮当前（被吸走后）的左上角 */
  const btnLeft = () => {
    "worklet";
    return W.value / 2 - BW.value / 2 + x.value;
  };
  const btnTop = () => {
    "worklet";
    return H.value / 2 - BH.value / 2 + y.value;
  };
  const onButton = (px: number, py: number) => {
    "worklet";
    const l = btnLeft();
    const t = btnTop();
    return px >= l && px <= l + BW.value && py >= t && py <= t + BH.value;
  };

  const click = (px: number, py: number) => {
    setRipples((list) => [...list.slice(-3), { id: Date.now() + Math.random(), x: px, y: py }]);
    setDone((n) => n + 1);
    onPress?.();
  };

  /* ---------- 触屏：一个 Pan 负责按下 / 移动 / 抬手 ---------- */
  const pan = Gesture.Pan()
    .manualActivation(true)
    .shouldCancelWhenOutside(false)
    .onTouchesDown((e, manager) => {
      "worklet";
      const t = e.changedTouches[0];
      if (!t || own.value || e.numberOfTouches > 1) return;
      sx.value = t.x;
      sy.value = t.y;
      if (onButton(t.x, t.y)) {
        // 按钮 touch-action: none → 立刻接管；按下本身不吸，移动后才吸
        own.value = true;
        pressed.value = true;
        scale.value = withTiming(0.95, PRESS);
        manager.activate();
      }
    })
    .onTouchesMove((e, manager) => {
      "worklet";
      const t = e.allTouches[0];
      if (!t) return;
      if (!own.value) {
        // 根节点 touch-action: pan-y → 横向移动才接管，纵向交给外层滚动
        const dx = t.x - sx.value;
        const dy = t.y - sy.value;
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (Math.abs(dx) >= Math.abs(dy)) {
          own.value = true;
          manager.activate();
        } else {
          manager.fail();
          return;
        }
      }
      move(t.x, t.y);
    })
    .onFinalize((e, success) => {
      "worklet";
      if (pressed.value) {
        pressed.value = false;
        scale.value = withTiming(hovered.value ? 1.03 : 1, POP);
        if (success && onButton(e.x, e.y)) runOnJS(click)(e.x - btnLeft(), e.y - btnTop());
      }
      own.value = false;
      // 网页：非鼠标的 pointerup / pointercancel → 复位
      reset();
    });

  /* ---------- 触控板 / 鼠标悬停 ---------- */
  const hoverAt = (px: number, py: number) => {
    "worklet";
    move(px, py);
    const over = onButton(px, py);
    if (over !== hovered.value) {
      hovered.value = over;
      if (!pressed.value) scale.value = withTiming(over ? 1.03 : 1, POP);
    }
  };
  const hover = Gesture.Hover()
    .onStart((e) => {
      "worklet";
      hoverAt(e.x, e.y);
    })
    .onUpdate((e) => {
      "worklet";
      hoverAt(e.x, e.y);
    })
    .onFinalize(() => {
      "worklet";
      if (hovered.value) {
        hovered.value = false;
        if (!pressed.value) scale.value = withTiming(1, POP);
      }
      if (!own.value) reset();
    });

  const gesture = Gesture.Simultaneous(pan, hover);

  /* ---------- 样式 ---------- */

  const fieldStyle = useAnimatedStyle(() => {
    const p = clamp(power.value, 0, 1);
    return { opacity: p, transform: [{ scale: 0.86 + 0.14 * p }] };
  });

  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  const shineStyle = useAnimatedStyle(() => ({
    opacity: clamp(power.value, 0, 1),
    transform: [{ translateX: hx.value - SHINE_R }, { translateY: hy.value - SHINE_R }],
  }));

  // 文字相对按钮再多走 (parallax - 1) 倍，但被软限幅在按钮里，箭头再多一点
  const labelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: soft(x.value * (parallax - 1), 14) }, { translateY: soft(y.value * (parallax - 1), 6) }],
  }));
  const arrowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: soft(x.value * (parallax - 1) * 0.5, 4) }],
  }));

  const fw = btn.w + radius * 2;
  const fh = btn.h + radius * 2;

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.root, style]} // 不铺底色：背景跟随宿主 App
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          W.value = width;
          H.value = height;
          setBox((b) => (b.w === width && b.h === height ? b : { w: width, h: height }));
        }}
      >
        {/* 磁场：大小就是「磁场半径」，指针越近越亮 */}
        {btn.w > 0 && (
          <Animated.View
            pointerEvents="none"
            needsOffscreenAlphaCompositing
            style={[
              styles.field,
              { left: box.w / 2 - fw / 2, top: box.h / 2 - fh / 2, width: fw, height: fh, borderRadius: fh / 2, borderColor: pal.line },
              fieldStyle,
            ]}
          >
            {/* closest-side 椭圆：圆按 fw / fh 横向拉伸（子元素坐标从 1px 边框内侧算起，所以各退 1） */}
            <View style={{ position: "absolute", left: fw / 2 - fh / 2 - 1, top: -1, width: fh, height: fh, transform: [{ scaleX: fw / fh }] }}>
              {pal.fieldRings.map(({ r, a }) => (
                <View
                  key={r}
                  style={{ position: "absolute", left: (fh * (1 - r)) / 2, top: (fh * (1 - r)) / 2, width: fh * r, height: fh * r, borderRadius: (fh * r) / 2, backgroundColor: rgba(rgb, a) }}
                />
              ))}
            </View>
          </Animated.View>
        )}

        <Animated.View
          accessible
          accessibilityRole="button"
          accessibilityLabel={done ? doneTitle : title}
          onAccessibilityTap={() => click(btn.w / 2, btn.h / 2)}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            BW.value = width;
            BH.value = height;
            setBtn((b) => (b.w === width && b.h === height ? b : { w: width, h: height }));
          }}
          style={[
            styles.btn,
            {
              minWidth: fs * 9.5,
              paddingVertical: fs,
              paddingHorizontal: fs * 1.75,
              backgroundColor: color,
              boxShadow: dark
                ? `inset 0 1px 0 rgba(255,255,255,0.18), 0 0 0 1px rgba(255,255,255,0.04), 0 12px 28px -10px ${pal.shadow}`
                : `inset 0 1px 0 rgba(255,255,255,0.22), 0 1px 2px rgba(0,0,0,0.12), 0 12px 28px -10px ${pal.shadow}`,
            },
            buttonStyle,
          ]}
        >
          {/* 高光 + 涟漪：裁在胶囊里，压在文字下面 */}
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip]}>
            <Animated.View needsOffscreenAlphaCompositing style={[styles.shine, shineStyle]}>
              {SHINE.map(({ r, a }) => (
                <View
                  key={r}
                  style={{
                    position: "absolute",
                    left: SHINE_R * (1 - r),
                    top: SHINE_R * (1 - r),
                    width: SHINE_R * 2 * r,
                    height: SHINE_R * 2 * r,
                    borderRadius: SHINE_R * r,
                    backgroundColor: `rgba(255,255,255,${a})`,
                  }}
                />
              ))}
            </Animated.View>
            {ripples.map((r) => (
              <RippleView key={r.id} x={r.x} y={r.y} d={fs * 20} onDone={() => setRipples((list) => list.filter((it) => it.id !== r.id))} />
            ))}
          </View>

          <Animated.View style={[styles.label, { height: lh }, labelStyle]}>
            <Swap
              on={done > 0}
              lh={lh}
              idle={
                <View style={[styles.row, { gap: fs * 0.45 }]}>
                  <Text style={[styles.text, { color: fg, fontSize: fs, lineHeight: lh, letterSpacing: fs * 0.02 }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <Animated.View style={arrowStyle}>
                    <Strokes size={fs * 1.1} color={fg} width={2.4} lines={ARROW} />
                  </Animated.View>
                </View>
              }
              done={
                <View style={[styles.row, { gap: fs * 0.45 }]}>
                  <Strokes size={fs * 1.1} color={fg} width={2.6} lines={CHECK} />
                  <Text style={[styles.text, { color: fg, fontSize: fs, lineHeight: lh, letterSpacing: fs * 0.02 }]} numberOfLines={1}>
                    {doneTitle}
                  </Text>
                </View>
              }
            />
          </Animated.View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

/* ---------- 文案切换：新文案从下方 110% 进入，旧文案向上 110% 退出（AnimatePresence popLayout，初次渲染不动） ---------- */

function Swap({ on, lh, idle, done }: { on: boolean; lh: number; idle: ReactNode; done: ReactNode }) {
  const idleY = useSharedValue(0);
  const idleO = useSharedValue(on ? 0 : 1);
  const doneY = useSharedValue(0);
  const doneO = useSharedValue(on ? 1 : 0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    runOnUI(swapText)(on, lh, idleY, idleO, doneY, doneO);
  }, [on, lh, idleY, idleO, doneY, doneO]);

  const idleStyle = useAnimatedStyle(() => ({ opacity: clamp(idleO.value, 0, 1), transform: [{ translateY: idleY.value }] }));
  const doneStyle = useAnimatedStyle(() => ({ opacity: clamp(doneO.value, 0, 1), transform: [{ translateY: doneY.value }] }));

  // 当前文案在文档流里撑开宽度，另一条绝对定位叠在同一格（都居中）
  return (
    <>
      <Animated.View style={[on ? styles.ghost : null, idleStyle]}>{idle}</Animated.View>
      <Animated.View style={[on ? null : styles.ghost, doneStyle]}>{done}</Animated.View>
    </>
  );
}

function swapText(on: boolean, lh: number, idleY: SharedValue<number>, idleO: SharedValue<number>, doneY: SharedValue<number>, doneO: SharedValue<number>) {
  "worklet";
  const [inY, inO, outY, outO] = on ? [doneY, doneO, idleY, idleO] : [idleY, idleO, doneY, doneO];
  if (inO.value < 0.01) {
    inY.value = lh * 1.1;
    inO.value = 0;
  }
  inY.value = motionSpring(0, TEXT);
  inO.value = motionSpring(1, TEXT);
  outY.value = motionSpring(-lh * 1.1, TEXT);
  outO.value = motionSpring(0, TEXT);
}

/* ---------- 涟漪：20em 白色圆，scale 0 → 1、opacity 0.4 → 0 ---------- */

function RippleView({ x, y, d, onDone }: { x: number; y: number; d: number; onDone: () => void }) {
  const p = useSharedValue(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const finish = () => doneRef.current();
    p.value = withTiming(1, RIPPLE, (finished) => {
      "worklet";
      if (finished) runOnJS(finish)();
    });
  }, [p]);
  const st = useAnimatedStyle(() => ({ opacity: 0.4 * (1 - p.value), transform: [{ scale: p.value }] }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: x - d / 2, top: y - d / 2, width: d, height: d, borderRadius: d / 2, backgroundColor: "rgba(255,255,255,0.5)" }, st]}
    />
  );
}

/* ---------- 图标（lucide ArrowRight / Check，24 格坐标；圆头细条拼折线） ---------- */

const ARROW: [number, number][][] = [
  [
    [5, 12],
    [19, 12],
  ],
  [
    [12, 5],
    [19, 12],
    [12, 19],
  ],
];
const CHECK: [number, number][][] = [
  [
    [20, 6],
    [9, 17],
    [4, 12],
  ],
];

function Strokes({ size, color, width, lines }: { size: number; color: string; width: number; lines: [number, number][][] }) {
  const k = size / 24;
  const t = width * k;
  const bars: { left: number; top: number; len: number; deg: number }[] = [];
  for (const pts of lines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1) * k + t;
      bars.push({ left: ((x1 + x2) / 2) * k - len / 2, top: ((y1 + y2) / 2) * k - t / 2, len, deg: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI });
    }
  }
  return (
    <View style={{ width: size, height: size }}>
      {bars.map((b, i) => (
        <View
          key={i}
          style={{ position: "absolute", left: b.left, top: b.top, width: b.len, height: t, borderRadius: t / 2, backgroundColor: color, transform: [{ rotate: `${b.deg}deg` }] }}
        />
      ))}
    </View>
  );
}

/* ---------- 样式（来自 style.css） ---------- */

const styles = StyleSheet.create({
  root: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  field: {
    position: "absolute",
    borderWidth: 1,
    overflow: "hidden",
  },
  btn: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  clip: {
    borderRadius: 999,
    overflow: "hidden",
  },
  shine: {
    position: "absolute",
    left: 0,
    top: 0,
    width: SHINE_R * 2,
    height: SHINE_R * 2,
  },
  label: {
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  text: {
    fontWeight: "600",
  },
  ghost: {
    position: "absolute",
  },
});
