// 前后对比（React Native 版）：分割线带一点柔和的弹簧跟手，拖过边缘会像橡皮筋一样拉不动、松手弹回；
// 点画面任意位置就滑过去，标签靠近边缘时自动淡出。进场时轻轻晃一下，提示可以拖。对应网站 src/cases/image-compare。
//
// 内容：主要用法是宿主传自己的前 / 后两张图（before / after：图片 source，或任意 React 元素）；不传时用网站版那张手绘的湖边日落。
// 插画不依赖 svg：天空 / 湖面是 linear-gradient 背景，太阳光晕是一圈圈半透明圆叠出的径向渐变，
// 山是按折线逐段 skewY 的竖条（竖条裁切、里面再反向 skewY 一块整山大小的渐变，所以渐变方向仍是竖直的），树是三角形边框。
// 「修图前」是同一张画按 CSS filter: saturate(.12) contrast(.78) brightness(1.06) 逐色换算后的灰调版本 + 一层灰雾
// （这几个滤镜都是仿射变换，逐色换算和整图滤镜等价；RN 的 filter 在 iOS 上不支持 saturate / contrast，所以不用它）。
// 画面固定 16:10（可改 aspectRatio），宽度铺满父容器、最宽 960；网页演示四周的留白不画，由宿主排版。
//
// 动画：target 是手指 / 进场晃动直接写的目标值；pos 跟随 target 的弹簧 { stiffness: 420, damping: 34, mass: 0.6 }，
// 每次目标改变都从当前值、带着当前速度重新起弹簧（自定义 Reanimated 动画，和 motion 的 useSpring 一致，不截断速度）。
// 揭开用两层反向平移（外层移走、内层移回来），全程只改 transform。
// 手势：一个 Pan。按下（onBegin）就把分割线目标放到手指处，和网页 pointerdown 一样；横向（上下模式为纵向）移动才接管，
// 反方向移动交给外层滚动（= 网页的 touch-action: pan-y / pan-x），被接管前抬手 / 交出也会把橡皮筋收回边界。
import { isValidElement, memo, useEffect, useRef, useState, type ReactElement } from "react";
import {
  Image,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  ReduceMotion,
  cancelAnimation,
  defineAnimation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
  type AnimationObject,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

export type ImageCompareProps = {
  /** 起始位置：分割线一开始停在哪里（0–100，%） */
  start?: number;
  /** 方向：左右拖动还是上下拖动 */
  orientation?: "horizontal" | "vertical";
  /** 把手样式：圆形 / 胶囊 / 细线 */
  handle?: "circle" | "bar" | "line";
  /** 显示标签：是否显示「修图前 / 修图后」标签 */
  showLabels?: boolean;
  /** 修图前的图：图片 source（require / { uri }）或任意 React 元素；不传用内置插画的灰调版本 */
  before?: ImageSourcePropType | ReactElement;
  /** 修图后的图：同上；不传用内置插画 */
  after?: ImageSourcePropType | ReactElement;
  /** 左（上）标签文案，默认「修图前」 */
  beforeLabel?: string;
  /** 右（下）标签文案，默认「修图后」 */
  afterLabel?: string;
  /** 画面宽高比，默认 16:10；图片按 cover 裁切铺满 */
  aspectRatio?: number;
  /** 松手 / 读屏调整后回调最终位置（0–100，修图前占的百分比） */
  onChange?: (value: number) => void;
  /** 对比框样式；默认 width 100%、最宽 960、水平居中 */
  style?: StyleProp<ViewStyle>;
};

/* ---------- 小工具 ---------- */

const NEVER = ReduceMotion.Never;
const clamp100 = (v: number) => {
  "worklet";
  return Math.min(100, Math.max(0, v));
};
/** 拖出边界时的橡皮筋：越往外越拉不动，最多再走 4% */
const RUBBER = 4;
const rubber = (v: number) => {
  "worklet";
  if (v < 0) return -RUBBER * (1 - Math.exp(v / RUBBER / 2.5));
  if (v > 100) return 100 + RUBBER * (1 - Math.exp(-(v - 100) / RUBBER / 2.5));
  return v;
};
/** motion 的 easeInOut */
const EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1);
/** 把手按下放大：{ duration: 0.25, ease: [0.28, 1.3, 0.36, 1] } */
const HANDLE = { duration: 250, easing: Easing.bezier(0.28, 1.3, 0.36, 1), reduceMotion: NEVER };

/* ---------- 和 motion 一致的物理弹簧（继承被打断动画的速度，不截断） ---------- */

type SpringSpec = { stiffness: number; damping: number; mass: number };
const POS: SpringSpec = { stiffness: 420, damping: 34, mass: 0.6 };

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
    // 420 / 34 / 0.6 的阻尼比 ≈ 1.07，走这一支（略过阻尼）
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

function motionSpring(toValue: number, spec: SpringSpec): number {
  "worklet";
  return defineAnimation<MotionSpringAnimation>(toValue, () => {
    "worklet";
    const onStart = (a: MotionSpringAnimation, value: number, now: number, prev: { velocity?: unknown } | null | undefined) => {
      a.from = value;
      a.target = toValue;
      a.current = value;
      a.begin = now;
      a.v0 = prev && typeof prev.velocity === "number" ? prev.velocity : 0;
      a.velocity = a.v0;
    };
    const onFrame = (a: MotionSpringAnimation, now: number): boolean => {
      const t = (now - a.begin) / 1000;
      const { x, v } = solveSpring(spec, a.from, a.target, a.v0, t);
      // motion 的默认收尾阈值：变化量很小（< 5）时用更细的阈值
      const granular = Math.abs(a.target - a.from) < 5;
      const done = Math.abs(v) <= (granular ? 0.01 : 2) && Math.abs(a.target - x) <= (granular ? 0.005 : 0.5);
      a.current = done ? a.target : x;
      a.velocity = done ? 0 : v;
      return done;
    };
    return { onStart, onFrame, toValue, current: toValue, from: toValue, target: toValue, v0: 0, velocity: 0, begin: 0, reduceMotion: false } as MotionSpringAnimation;
  }) as unknown as number;
}

/* ---------- 颜色（style.css 浅色 / 深色） ---------- */

const PALETTE = {
  light: { edge: "rgba(0,0,0,0.06)", shadow: "0 1px 2px rgba(0,0,0,0.06), 0 18px 50px rgba(0,0,0,0.14)", chip: "rgba(16,16,20,0.58)" },
  dark: { edge: "rgba(255,255,255,0.08)", shadow: "0 1px 2px rgba(0,0,0,0.3), 0 18px 50px rgba(0,0,0,0.5)", chip: "rgba(0,0,0,0.62)" },
} as const;

/* ---------- 组件 ---------- */

export function ImageCompare({
  start = 50,
  orientation = "horizontal",
  handle = "circle",
  showLabels = true,
  before,
  after,
  beforeLabel = "修图前",
  afterLabel = "修图后",
  aspectRatio = 1.6,
  onChange,
  style,
}: ImageCompareProps) {
  const horizontal = orientation !== "vertical";
  const pal = PALETTE[useColorScheme() === "dark" ? "dark" : "light"];
  const ar = aspectRatio > 0 ? aspectRatio : 1.6;

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [now, setNow] = useState(Math.round(clamp100(start)));
  const FW = useSharedValue(0);
  const FH = useSharedValue(0);

  const target = useSharedValue(clamp100(start));
  const pos = useSharedValue(clamp100(start));
  const lift = useSharedValue(1); // 把手缩放
  const dragging = useSharedValue(false);
  const edge = useSharedValue(false);
  const prevStart = useRef(start);

  // pos = useSpring(target)：目标每变一次就带着当前速度重新起弹簧
  useAnimatedReaction(
    () => target.value,
    (t, prev) => {
      if (prev !== null && t !== prev) pos.value = motionSpring(t, POS);
    },
  );

  useEffect(() => {
    // 进场时轻轻晃一下，提示可以拖：[s, s+8a, s−4a, s]，1.4s，延迟 0.6s，easeInOut，times [0, .38, .72, 1]
    const s = clamp100(start);
    const a = s > 85 ? -1 : 1;
    const seg = (to: number, ms: number) => withTiming(to, { duration: ms, easing: EASE_IN_OUT, reduceMotion: NEVER });
    target.value = withDelay(600, withSequence(seg(clamp100(s + 8 * a), 1400 * 0.38), seg(clamp100(s - 4 * a), 1400 * 0.34), seg(s, 1400 * 0.28)), NEVER);
    return () => cancelAnimation(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (prevStart.current === start) return;
    prevStart.current = start;
    cancelAnimation(target);
    target.value = clamp100(start);
    setNow(Math.round(clamp100(start)));
  }, [start, target]);

  const report = (v: number) => {
    setNow(Math.round(v));
    onChange?.(v);
  };

  /* ---------- 拖动 ---------- */

  const pct = (x: number, y: number) => {
    "worklet";
    return horizontal ? (x / Math.max(FW.value, 1)) * 100 : (y / Math.max(FH.value, 1)) * 100;
  };
  const setRaw = (raw: number) => {
    "worklet";
    target.value = rubber(raw);
    edge.value = raw <= 0 || raw >= 100;
  };
  const end = () => {
    "worklet";
    if (!dragging.value) return;
    dragging.value = false;
    lift.value = withTiming(1, HANDLE);
    // 松手：橡皮筋弹回边界
    const v = clamp100(target.value);
    target.value = v;
    runOnJS(report)(v);
  };

  const pan = Gesture.Pan()
    .shouldCancelWhenOutside(false)
    .activeOffsetX(horizontal ? [-4, 4] : [-10000, 10000])
    .activeOffsetY(horizontal ? [-10000, 10000] : [-4, 4])
    .failOffsetY(horizontal ? [-8, 8] : [-10000, 10000])
    .failOffsetX(horizontal ? [-10000, 10000] : [-8, 8])
    .onBegin((e) => {
      "worklet";
      if (dragging.value) return;
      // 按下：停掉进场晃动，分割线目标直接放到手指处（pos 弹簧滑过去）
      cancelAnimation(target);
      dragging.value = true;
      edge.value = clamp100(target.value) % 100 === 0;
      setRaw(pct(e.x, e.y));
      lift.value = withTiming(1.1, HANDLE);
    })
    .onUpdate((e) => {
      "worklet";
      if (dragging.value) setRaw(pct(e.x, e.y));
    })
    .onFinalize(() => {
      "worklet";
      end();
    });

  const nudge = (step: number) => {
    cancelAnimation(target);
    const v = clamp100(target.value + step);
    target.value = v;
    report(v);
  };

  /* ---------- 样式 ---------- */

  const axis = horizontal ? FW : FH;
  // 外层移走 (p − 100)%、内层移回 (100 − p)%：外层的裁切框正好露出前 p%
  const outerStyle = useAnimatedStyle(() => {
    const d = ((clamp100(pos.value) - 100) / 100) * axis.value;
    return { transform: horizontal ? [{ translateX: d }] : [{ translateY: d }] };
  });
  const innerStyle = useAnimatedStyle(() => {
    const d = ((100 - clamp100(pos.value)) / 100) * axis.value;
    return { transform: horizontal ? [{ translateX: d }] : [{ translateY: d }] };
  });
  // 分割线跟着未截断的 pos 走，橡皮筋时会稍微出界
  const dividerStyle = useAnimatedStyle(() => {
    const d = (pos.value / 100) * axis.value;
    return { transform: horizontal ? [{ translateX: d }] : [{ translateY: d }] };
  });
  const handleStyle = useAnimatedStyle(() => ({ transform: [{ scale: lift.value }] }));
  const beforeLabelStyle = useAnimatedStyle(() => ({ opacity: interpolate(pos.value, [6, 24], [0, 1], Extrapolation.CLAMP) }));
  const afterLabelStyle = useAnimatedStyle(() => ({ opacity: interpolate(pos.value, [76, 94], [1, 0], Extrapolation.CLAMP) }));

  // border-radius: clamp(12px, 3cqw, 22px)
  const corner = Math.min(Math.max(size.w * 0.03, 12), 22);
  const thin = handle === "line";
  const lineW = thin ? 1.5 : 2;

  return (
    <GestureDetector gesture={pan}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="拖动对比修图前后"
        accessibilityValue={{ min: 0, max: 100, now, text: `${beforeLabel}占 ${now}%` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? 5 : -5)}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          FW.value = width;
          FH.value = height;
          setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
        }}
        style={[styles.frame, { aspectRatio: ar, borderRadius: corner, boxShadow: pal.shadow }, style]}
      >
        <View style={[StyleSheet.absoluteFill, { borderRadius: corner, overflow: "hidden" }]}>
          {/* 修图后：完整铺底 */}
          <Layer content={after} graded={false} w={size.w} h={size.h} />
          {/* 修图前：两层反向平移揭开 */}
          <Animated.View style={[StyleSheet.absoluteFill, styles.clip, outerStyle]}>
            <Animated.View style={[StyleSheet.absoluteFill, innerStyle]}>
              <Layer content={before} graded w={size.w} h={size.h} />
            </Animated.View>
          </Animated.View>

          {showLabels && (
            <>
              <Animated.View pointerEvents="none" style={[styles.chip, { backgroundColor: pal.chip, top: 14, left: 14 }, beforeLabelStyle]}>
                <Text style={styles.chipText}>{beforeLabel}</Text>
              </Animated.View>
              <Animated.View
                pointerEvents="none"
                style={[styles.chip, { backgroundColor: pal.chip }, horizontal ? { top: 14, right: 14 } : { bottom: 14, left: 14 }, afterLabelStyle]}
              >
                <Text style={styles.chipText}>{afterLabel}</Text>
              </Animated.View>
            </>
          )}

          <Animated.View pointerEvents="none" style={[horizontal ? styles.dividerH : styles.dividerV, dividerStyle]}>
            <View
              style={[
                styles.line,
                horizontal ? { top: 0, bottom: 0, left: -lineW / 2, width: lineW } : { left: 0, right: 0, top: -lineW / 2, height: lineW },
                { boxShadow: thin ? "0 0 6px rgba(0,0,0,0.2)" : "0 0 10px rgba(0,0,0,0.25)" },
              ]}
            />
            <Animated.View style={handleStyle}>
              <HandleView style={handle} horizontal={horizontal} />
            </Animated.View>
          </Animated.View>
        </View>
        {/* 细描边画在最上层，避免被图片盖住 */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: corner, borderWidth: 1, borderColor: pal.edge }]} />
      </View>
    </GestureDetector>
  );
}

/* ---------- 一层画面：宿主的图 / 元素，或内置插画 ---------- */

function Layer({ content, graded, w, h }: { content?: ImageSourcePropType | ReactElement; graded: boolean; w: number; h: number }) {
  if (content != null) {
    if (isValidElement(content)) return <View style={StyleSheet.absoluteFill}>{content}</View>;
    return <Image source={content as ImageSourcePropType} resizeMode="cover" style={StyleSheet.absoluteFill} />;
  }
  if (w <= 0 || h <= 0) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Scene graded={graded} w={w} h={h} />
      {graded && <View style={[StyleSheet.absoluteFill, { backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.1), rgba(160,160,160,0.16))" }]} />}
    </View>
  );
}

/* ---------- 把手 ---------- */

function HandleView({ style, horizontal }: { style: "circle" | "bar" | "line"; horizontal: boolean }) {
  if (style === "circle") {
    return (
      <View style={[styles.handle, styles.handleShadow, { width: 46, height: 46, borderRadius: 23 }]}>
        <View style={{ transform: [{ rotate: horizontal ? "0deg" : "90deg" }] }}>
          <Strokes size={22} color="#1a1a1a" width={2.2} lines={CHEVRONS} />
        </View>
      </View>
    );
  }
  if (style === "bar") {
    return (
      <View style={[styles.handle, styles.handleShadow, horizontal ? { width: 16, height: 56 } : { width: 56, height: 16 }, { borderRadius: 999 }]}>
        <View style={{ flexDirection: horizontal ? "column" : "row", gap: 3 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.grip, horizontal ? { width: 6, height: 1.5 } : { width: 1.5, height: 6 }]} />
          ))}
        </View>
      </View>
    );
  }
  return <View style={[styles.handle, { width: 12, height: 12, borderRadius: 6, boxShadow: "0 0 0 4px rgba(255,255,255,0.35), 0 2px 8px rgba(0,0,0,0.25)" }]} />;
}

/** ‹ ›：M9 7l-5 5 5 5 M15 7l5 5-5 5（24 格坐标） */
const CHEVRONS: [number, number][][] = [
  [
    [9, 7],
    [4, 12],
    [9, 17],
  ],
  [
    [15, 7],
    [20, 12],
    [15, 17],
  ],
];

/** 折线 → 圆头细条（相当于 stroke-linecap / linejoin: round），坐标按 24 格（或 base 格）缩放 */
function Strokes({ size, color, width, lines, base = 24 }: { size: number; color: string; width: number; lines: [number, number][][]; base?: number }) {
  const k = size / base;
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

/* ---------- 内置插画（网站 SVG：800 × 500，xMidYMid slice） ---------- */

type RGB = [number, number, number]; // 0…1

function hexRGB(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** CSS filter: saturate(0.12) contrast(0.78) brightness(1.06)，sRGB 空间，每步截断到 0…1 */
function grade([r, g, b]: RGB): RGB {
  const s = 0.12;
  const c01 = (v: number) => Math.min(1, Math.max(0, v));
  const sat: RGB = [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ];
  return sat.map((v) => c01(c01((c01(v) - 0.5) * 0.78 + 0.5) * 1.06)) as RGB;
}

const css = ([r, g, b]: RGB, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

type Paint = (hex: string, a?: number) => string;
const painter = (graded: boolean): Paint => (hex, a = 1) => css(graded ? grade(hexRGB(hex)) : hexRGB(hex), a);
const vgrad = (p: Paint, stops: [string, number][]) => `linear-gradient(180deg, ${stops.map(([c, at]) => `${p(c)} ${at * 100}%`).join(", ")})`;

/**
 * 太阳光晕（radialGradient：0 #fff3c4/.95、.3 #ffc46b/.55、1 #ff8a5b/0）：
 * 从外到内叠 n 个圆，逐环解出每个圆的颜色和不透明度，使叠出来的每一环正好等于渐变在该处的颜色（预乘后）
 */
function glowRings(graded: boolean, n: number) {
  const stops: { at: number; c: RGB; a: number }[] = [
    { at: 0, c: hexRGB("#fff3c4"), a: 0.95 },
    { at: 0.3, c: hexRGB("#ffc46b"), a: 0.55 },
    { at: 1, c: hexRGB("#ff8a5b"), a: 0 },
  ].map((s) => ({ ...s, c: graded ? grade(s.c) : s.c }));
  const sample = (rho: number) => {
    let i = 0;
    while (i < stops.length - 2 && rho > stops[i + 1].at) i++;
    const A = stops[i];
    const B = stops[i + 1];
    const t = Math.min(1, Math.max(0, (rho - A.at) / (B.at - A.at)));
    return { c: A.c.map((v, j) => v + (B.c[j] - v) * t) as RGB, a: A.a + (B.a - A.a) * t };
  };
  const out: { r: number; color: string }[] = [];
  let P: RGB = [0, 0, 0]; // 已叠好的外圈（预乘）
  let Aacc = 0;
  for (let k = n; k >= 1; k--) {
    const { c, a } = sample((k - 0.5) / n);
    const ak = Aacc >= 1 ? 0 : Math.max(0, 1 - (1 - a) / (1 - Aacc));
    const ck: RGB = ak > 0 ? (c.map((v, j) => Math.min(1, Math.max(0, (v * a - (1 - ak) * P[j]) / ak))) as RGB) : c;
    out.push({ r: (190 * k) / n, color: css(ck, Math.round(ak * 1000) / 1000) });
    P = P.map((v, j) => ak * ck[j] + (1 - ak) * v) as RGB;
    Aacc = ak + (1 - ak) * Aacc;
  }
  return out;
}

const GLOW = { plain: glowRings(false, 18), graded: glowRings(true, 18) };

type Box = { x: number; y: number; w: number; h: number };
type Col = { left: number; top: number; width: number; height: number; deg: number; il: number; it: number };

/**
 * 折线 → 一排竖条：外层竖条 skewY 让顶边正好落在这一段山脊上（overflow 裁切），
 * 里面放一块和整座山外框一样大的竖直渐变，反向 skewY 抵消倾斜，再补上倾斜带来的竖向偏移 → 渐变仍按整座山的外框对齐
 */
function ridgeColumns(pts: [number, number][], box: Box): Col[] {
  const out: Col[] = [];
  const bottom = box.y + box.h;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const w = x2 - x1;
    if (w <= 0) continue;
    const tan = (y2 - y1) / w;
    const W = w + 0.6; // 稍微重叠，盖住接缝
    const top = y1 + (W / 2) * tan; // skewY 以中心为原点
    const shift = (box.x + box.w / 2 - (x1 + W / 2)) * tan;
    out.push({ left: x1, top, width: W, height: bottom - top + W * Math.abs(tan) + 2, deg: (Math.atan(tan) * 180) / Math.PI, il: box.x - x1, it: box.y - shift - top });
  }
  return out;
}

/** 二次贝塞尔采样成折线（不含起点） */
function quad(p0: [number, number], c: [number, number], p1: [number, number], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}

// 形状（与颜色无关，模块加载时算一次）
const FAR_BOX: Box = { x: 0, y: 186, w: 800, h: 154 };
const MID_BOX: Box = { x: 0, y: 276, w: 800, h: 86 };
const LEFT_BOX: Box = { x: 0, y: 362.6, w: 350, h: 137.4 };
const RIGHT_BOX: Box = { x: 572, y: 388, w: 228, h: 112 };
const FAR = ridgeColumns([[0, 300], [70, 246], [140, 280], [230, 196], [320, 268], [410, 214], [500, 262], [600, 186], [700, 248], [800, 214]], FAR_BOX);
const MID = ridgeColumns([[0, 336], [70, 292], [150, 322], [230, 276], [320, 334], [400, 302], [480, 338], [570, 290], [660, 334], [740, 302], [800, 322]], MID_BOX);
const LEFT_HILL = ridgeColumns([[0, 372], ...quad([0, 372], [110, 346], [220, 392], 14), ...quad([220, 392], [300, 428], [350, 500], 10)], LEFT_BOX);
const RIGHT_HILL = ridgeColumns(
  ([[800, 392], ...quad([800, 392], [700, 376], [630, 424], 12), ...quad([630, 424], [590, 456], [572, 500], 8)] as [number, number][]).reverse(),
  RIGHT_BOX,
);
const STARS: [number, number][] = [[80, 40], [160, 90], [250, 30], [340, 70], [120, 140], [700, 50], [640, 110], [470, 40], [760, 120]];
const CLOUDS: [number, number, number, number][] = [[190, 190, 110, 14], [260, 176, 70, 11], [660, 200, 90, 10]];
const BIRDS: [number, number][][] = [[300, 150, 9], [350, 128, 6], [268, 170, 5]].flatMap(([x, y, s]) => [
  [[x, y] as [number, number], ...quad([x, y], [x + s, y - s], [x + 2 * s, y], 4)],
  [[x + 2 * s, y] as [number, number], ...quad([x + 2 * s, y], [x + 3 * s, y - s], [x + 4 * s, y], 4)],
]);
const REFLECTIONS: [number, number, number, number, number][] = [[508, 366, 104, 4, 0.85], [522, 380, 76, 4, 0.7], [532, 396, 56, 3, 0.55], [540, 412, 40, 3, 0.4], [546, 428, 28, 2, 0.3]];
const TREES: [number, number, number][] = [[40, 360, 1], [78, 352, 1.3], [118, 366, 0.9], [160, 372, 1.15], [205, 388, 0.85], [728, 382, 1.2], [770, 376, 0.95]];

function Mountain({ cols, box, fill }: { cols: Col[]; box: Box; fill: string }) {
  return (
    <>
      {cols.map((c, i) => (
        <View
          key={i}
          style={{ position: "absolute", left: c.left, top: c.top, width: c.width, height: c.height, overflow: "hidden", transform: [{ skewY: `${c.deg}deg` }] }}
        >
          <View style={{ position: "absolute", left: c.il, top: c.it, width: box.w, height: box.h, backgroundImage: fill, transform: [{ skewY: `${-c.deg}deg` }] }} />
        </View>
      ))}
    </>
  );
}

const Scene = memo(function Scene({ graded, w, h }: { graded: boolean; w: number; h: number }) {
  const p = painter(graded);
  const k = Math.max(w / 800, h / 500);
  const hill = vgrad(p, [["#1c6b5a", 0], ["#0b2f33", 1]]);
  return (
    <View style={{ position: "absolute", left: (w - 800) / 2, top: (h - 500) / 2, width: 800, height: 500, transform: [{ scale: k }] }}>
      {/* 天空 */}
      <View style={[StyleSheet.absoluteFill, { backgroundImage: vgrad(p, [["#24307e", 0], ["#8f4bb8", 0.38], ["#ef6f8a", 0.6], ["#ff9b5c", 0.78], ["#ffd27a", 1]]) }]} />
      {/* 星星 */}
      {STARS.map(([x, y], i) => {
        const r = i % 3 ? 1.2 : 1.8;
        return <View key={`st${i}`} style={{ position: "absolute", left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: r, backgroundColor: p("#ffffff", 0.7) }} />;
      })}
      {/* 太阳光晕 + 太阳 */}
      {(graded ? GLOW.graded : GLOW.plain).map(({ r, color }) => (
        <View key={`g${r}`} style={{ position: "absolute", left: 560 - r, top: 300 - r, width: r * 2, height: r * 2, borderRadius: r, backgroundColor: color }} />
      ))}
      <View style={{ position: "absolute", left: 512, top: 252, width: 96, height: 96, borderRadius: 48, backgroundColor: p("#fff4cf") }} />
      {/* 云（整组 0.28 透明度，重叠处不叠深）：椭圆 = 圆按 ry / rx 纵向压扁 */}
      <View needsOffscreenAlphaCompositing style={[StyleSheet.absoluteFill, { opacity: 0.28 }]}>
        {CLOUDS.map(([cx, cy, rx, ry], i) => (
          <View
            key={`c${i}`}
            style={{ position: "absolute", left: cx - rx, top: cy - rx, width: rx * 2, height: rx * 2, borderRadius: rx, backgroundColor: p("#ffffff"), transform: [{ scaleY: ry / rx }] }}
          />
        ))}
      </View>
      {/* 飞鸟 */}
      <View style={{ position: "absolute", left: 0, top: 0 }}>
        <Strokes size={800} base={800} color={p("#3a1f5c")} width={2.4} lines={BIRDS} />
      </View>
      {/* 远山、近山 */}
      <Mountain cols={FAR} box={FAR_BOX} fill={vgrad(p, [["#b267c9", 0], ["#e88aa8", 1]])} />
      <Mountain cols={MID} box={MID_BOX} fill={vgrad(p, [["#5b2f91", 0], ["#8a4aa6", 1]])} />
      {/* 湖面 + 倒影 */}
      <View style={{ position: "absolute", left: 0, top: 358, width: 800, height: 142, backgroundImage: vgrad(p, [["#ffb170", 0], ["#b3549e", 0.4], ["#22296b", 1]]) }} />
      {REFLECTIONS.map(([x, y, rw, rh, a], i) => (
        <View key={`r${i}`} style={{ position: "absolute", left: x, top: y, width: rw, height: rh, borderRadius: rh / 2, backgroundColor: p("#ffe7a6", a) }} />
      ))}
      {/* 两侧山坡 */}
      <Mountain cols={LEFT_HILL} box={LEFT_BOX} fill={hill} />
      <Mountain cols={RIGHT_HILL} box={RIGHT_BOX} fill={hill} />
      {/* 树：三角形边框 */}
      {TREES.map(([x, y, s], i) => (
        <View
          key={`t${i}`}
          style={{
            position: "absolute",
            left: x - 18 * s,
            top: y - 70 * s,
            width: 0,
            height: 0,
            borderLeftWidth: 18 * s,
            borderRightWidth: 18 * s,
            borderBottomWidth: 70 * s,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderBottomColor: p("#0a2a24"),
          }}
        />
      ))}
    </View>
  );
});

/* ---------- 样式（来自 style.css） ---------- */

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    maxWidth: 960,
    alignSelf: "center",
  },
  clip: {
    overflow: "hidden",
  },
  chip: {
    position: "absolute",
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: 999,
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
  },
  chipText: {
    color: "#fff",
    fontSize: 12.5,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  dividerH: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  dividerV: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  line: {
    position: "absolute",
    backgroundColor: "#fff",
  },
  handle: {
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  handleShadow: {
    boxShadow: "0 2px 6px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.18)",
  },
  grip: {
    borderRadius: 1,
    backgroundColor: "#b5b5b5",
  },
});
