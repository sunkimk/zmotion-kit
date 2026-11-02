// 滚轮计数器（React Native 版）：加减时每一位数字像里程表一样独立滚动，方向跟随加减，滚得越快越模糊；
// 长按越按越快，到达上下限时数字左右一抖。
// 对应网站 src/cases/rolling-counter（React + motion）。尺寸按容器的 cqmin 换算（和 CSS 的 clamp(…, n cqmin, …) 一致）。
// 每一位是一根「数字轴」（共享值，motion 的 useSpring → withSpring，改目标时带当前速度接着走），
// 速度由逐帧差分得到（motion 的 useVelocity）。
// RN 在 iOS 上没有 blur 滤镜，「运动模糊」用上下两层错开的残影近似；CSS 的上下渐隐蒙版用胶囊底色的渐变遮罩近似。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View, useColorScheme, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  cancelAnimation,
  runOnUI,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

export type RollingCounterProps = {
  /** 每次加减的数值（1–25） */
  step?: number;
  /** 允许的最小值，可以是负数（-99–0） */
  min?: number;
  /** 允许的最大值，位数会随数值自动增减（9–9999） */
  max?: number;
  /** 数字滚动的弹簧刚度，越小滚得越慢、越有惯性（60–700） */
  stiffness?: number;
  /** 滚动越快，数字越模糊 */
  blur?: boolean;
  /** 受控：当前数值。不传则组件内部自己管理（初始 9） */
  value?: number;
  /** 用户加减后回调新的数值 */
  onValueChange?: (value: number) => void;
};

// 系统「减弱动态效果」由组件自己处理（弹簧阻尼加大、关掉模糊、抖动减弱），不让 Reanimated 直接跳到终点
const NEVER = ReduceMotion.Never;
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const COL_SPRING = { stiffness: 420, damping: 34, mass: 1, reduceMotion: NEVER };
const FILL_SPRING = { stiffness: 260, damping: 30, mass: 1, reduceMotion: NEVER };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampW = (v: number, lo: number, hi: number) => {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
};

// ---------- 曲线 ----------

/** CSS / motion 的 cubic-bezier(x1, y1, x2, y2)，y 可以超出 0…1（回弹曲线） */
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
const pressEase = (t: number) => {
  'worklet';
  return cubicBezier(0.3, 0, 0.5, 1, t);
};
const popEase = (t: number) => {
  'worklet';
  return cubicBezier(0.28, 1.3, 0.36, 1, t);
};
/** motion 的 easeOut */
const easeOut = (t: number) => {
  'worklet';
  return cubicBezier(0, 0, 0.58, 1, t);
};
/** CSS 的 ease */
const cssEase = (t: number) => {
  'worklet';
  return cubicBezier(0.25, 0.1, 0.25, 1, t);
};

/** whileTap 按下：{ duration: 0.09, ease: [0.3, 0, 0.5, 1] } */
const PRESS = { duration: 90, easing: pressEase, reduceMotion: NEVER };
/** 松开弹回：{ duration: 0.26, ease: [0.28, 1.3, 0.36, 1] } */
const POP = { duration: 260, easing: popEase, reduceMotion: NEVER };

/** motion 的 animate(mv, [0, a, b, …, 0], { duration, ease: "easeOut" })：关键帧均匀分布，每段各用一次 easeOut */
function keyframes(values: number[], totalMs: number) {
  const seg = totalMs / (values.length - 1);
  const steps = values.slice(1).map((v) => withTiming(v, { duration: seg, easing: easeOut, reduceMotion: NEVER }));
  return withSequence(withTiming(values[0], { duration: 0, reduceMotion: NEVER }), ...steps);
}

// ---------- 颜色（style.css 浅色 / 深色） ----------

type Palette = { fg: string; muted: string; pill: string; pillClear: string; btn: string; btnFg: string; track: string; fill: string };
const LIGHT: Palette = {
  fg: '#111111',
  muted: '#8a8a8a',
  pill: '#ffffff',
  pillClear: 'rgba(255,255,255,0)',
  btn: '#f1f1f1',
  btnFg: '#111111',
  track: '#e6e6e6',
  fill: '#111111',
};
const DARK: Palette = {
  fg: '#f5f5f5',
  muted: '#6f6f6f',
  pill: '#1d1d1d',
  pillClear: 'rgba(29,29,29,0)',
  btn: '#2a2a2a',
  btnFg: '#f5f5f5',
  track: '#2a2a2a',
  fill: '#f5f5f5',
};

// ---------- 组件 ----------

export function RollingCounter({
  step = 1,
  min = 0,
  max = 120,
  stiffness = 240,
  blur = true,
  value: valueProp,
  onValueChange,
}: RollingCounterProps) {
  const pal = useColorScheme() === 'dark' ? DARK : LIGHT;
  const reduce = useReducedMotion();
  const lo = Math.round(Math.min(min, max));
  const hi = Math.round(Math.max(min, max));
  const stepN = Math.max(1, Math.round(step));

  const [internal, setInternal] = useState(() => clamp(9, lo, hi));
  const controlled = valueProp !== undefined;
  const value = controlled ? clamp(Math.round(valueProp), lo, hi) : internal;
  const valueRef = useRef(value);
  valueRef.current = value;

  // 绝对值变大 → 新出现的位从下往上滚进来；变小反过来
  const last = useRef(value);
  const absDir = useRef(1);
  if (value !== last.current) {
    absDir.current = Math.abs(value) >= Math.abs(last.current) ? 1 : -1;
    last.current = value;
  }
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  // 1ch：粗体等宽数字「0」的宽度，用一个看不见的 Text 量出来
  const [chm, setChm] = useState<{ fs: number; ch: number } | null>(null);

  const shake = useSharedValue(0);
  const shakeMinus = useSharedValue(0);
  const shakePlus = useSharedValue(0);
  const pressMinus = useSharedValue(1);
  const pressPlus = useSharedValue(1);
  const fill = useSharedValue(hi === lo ? 1 : (value - lo) / (hi - lo));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const progress = hi === lo ? 1 : (value - lo) / (hi - lo);
  useEffect(() => {
    fill.value = withSpring(progress, FILL_SPRING);
  }, [progress, fill]);

  const commit = (next: number) => {
    valueRef.current = next;
    if (!controlled) setInternal(next);
    onValueChange?.(next);
  };

  // 上下限变化时把当前值收回范围内
  useEffect(() => {
    const raw = controlled ? Math.round(valueProp) : internal;
    const v = clamp(raw, lo, hi);
    if (v !== raw) commit(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lo, hi]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const knock = (dir: number) => {
    const k = dir * (reduce ? 0.4 : 1);
    const btn = dir > 0 ? shakePlus : shakeMinus;
    shake.value = keyframes([0, 7 * k, -6 * k, 4 * k, -2 * k, 0], 420);
    btn.value = keyframes([0, 5 * k, -4 * k, 2 * k, 0], 360);
  };

  /** 走一步，返回是否成功（到达极限则抖动并返回 false） */
  const bump = (dir: number) => {
    const cur = valueRef.current;
    const next = clamp(cur + dir * stepN, lo, hi);
    if (next === cur) {
      knock(dir);
      return false;
    }
    commit(next);
    return true;
  };

  const stop = () => clearTimeout(timer.current);

  /** 长按：先走一步，420ms 后开始连走，间隔从 150ms 指数收敛到 32ms（越按越快） */
  const start = (dir: number) => {
    stop();
    if (!bump(dir)) return;
    let n = 0;
    const loop = (delay: number) => {
      timer.current = setTimeout(() => {
        if (!bump(dir)) {
          // 走到头了：whileTap 撤掉，按钮弹回
          (dir > 0 ? pressPlus : pressMinus).value = withTiming(1, POP);
          return;
        }
        n += 1;
        loop(Math.max(32, 150 * Math.pow(0.88, n)));
      }, delay);
    };
    loop(420);
  };

  const actions = useRef({ start, stop, bump });
  actions.current = { start, stop, bump };

  const holdGesture = (dir: number, pressSv: SharedValue<number>) =>
    // Pan(minDistance 0)：按下立即开始，手指移出按钮也继续（相当于 setPointerCapture），松手才停
    Gesture.Pan()
      .runOnJS(true)
      .minDistance(0)
      .onBegin(() => {
        const atLimit = dir < 0 ? valueRef.current <= lo : valueRef.current >= hi;
        if (!atLimit) pressSv.value = withTiming(0.9, PRESS);
        actions.current.start(dir);
      })
      .onFinalize(() => {
        actions.current.stop();
        pressSv.value = withTiming(1, POP);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const minusGesture = useMemo(() => holdGesture(-1, pressMinus), [lo, hi, pressMinus]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plusGesture = useMemo(() => holdGesture(1, pressPlus), [lo, hi, pressPlus]);

  const valueStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox({ w: width, h: height });
  };

  const cq = box ? Math.min(box.w, box.h) / 100 : 0;
  const btn = clamp(13 * cq, 40, 60);
  const fs = clamp(15 * cq, 40, 88);
  const ch = chm && chm.fs === fs ? chm.ch : null;
  const lineH = 1.2 * fs;
  const abs = Math.abs(value);
  const places = String(Math.max(Math.abs(lo), Math.abs(hi))).length;
  const damping = Math.sqrt(stiffness) * (reduce ? 2 : 1.45);
  const atMin = value <= lo;
  const atMax = value >= hi;
  const enterFrom = mounted.current ? -absDir.current : 0;

  return (
    <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }} onLayout={onLayout}>
      {box !== null && (
        <Text
          style={{ position: 'absolute', opacity: 0, fontSize: fs, fontWeight: '700', fontVariant: ['tabular-nums'] }}
          onLayout={(e) => setChm({ fs, ch: e.nativeEvent.layout.width })}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          0
        </Text>
      )}
      {box !== null && ch !== null && (
        <View style={{ alignItems: 'center', gap: clamp(5 * cq, 14, 28) }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: clamp(3 * cq, 8, 18),
              padding: clamp(2 * cq, 6, 10),
              borderRadius: 999,
              backgroundColor: pal.pill,
              boxShadow: '0 1px 2px rgba(0,0,0,0.06), 0 10px 30px rgba(0,0,0,0.07)',
            }}
          >
            <StepButton
              dir={-1}
              size={btn}
              off={atMin}
              step={stepN}
              pal={pal}
              gesture={minusGesture}
              press={pressMinus}
              shake={shakeMinus}
              onActivate={() => actions.current.bump(-1)}
            />
            <Animated.View
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={`当前数值 ${value}`}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === 'increment') actions.current.bump(1);
                if (e.nativeEvent.actionName === 'decrement') actions.current.bump(-1);
              }}
              style={[
                { flexDirection: 'row', justifyContent: 'center', minWidth: 2 * ch + 8, paddingHorizontal: 4 },
                valueStyle,
              ]}
            >
              <Sign show={value < 0} ch={ch} h={lineH} fs={fs} fg={pal.fg} />
              {Array.from({ length: places }, (_, i) => places - 1 - i).map((p) => (
                <Column
                  key={p}
                  place={p}
                  abs={abs}
                  shown={p === 0 || abs >= 10 ** p}
                  enterFrom={enterFrom}
                  stiffness={stiffness}
                  damping={damping}
                  blur={blur && !reduce}
                  ch={ch}
                  h={lineH}
                  fs={fs}
                  pal={pal}
                />
              ))}
            </Animated.View>
            <StepButton
              dir={1}
              size={btn}
              off={atMax}
              step={stepN}
              pal={pal}
              gesture={plusGesture}
              press={pressPlus}
              shake={shakePlus}
              onActivate={() => actions.current.bump(1)}
            />
          </View>

          <View style={{ width: Math.min(box.w * 0.7, 260), gap: 8 }}>
            <View
              style={{ height: 4, borderRadius: 999, backgroundColor: pal.track, overflow: 'hidden' }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Animated.View
                style={[
                  { width: '100%', height: '100%', borderRadius: 999, backgroundColor: pal.fill, transformOrigin: 'left' },
                  fillStyle,
                ]}
              />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 11, color: pal.muted, fontVariant: ['tabular-nums'] }}>{lo}</Text>
              <Text style={{ fontSize: 11, color: pal.muted, fontVariant: ['tabular-nums'] }}>{hi}</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ---------- 加减按钮 ----------

function StepButton({
  dir,
  size,
  off,
  step,
  pal,
  gesture,
  press,
  shake,
  onActivate,
}: {
  dir: number;
  size: number;
  off: boolean;
  step: number;
  pal: Palette;
  gesture: ReturnType<typeof Gesture.Pan>;
  press: SharedValue<number>;
  shake: SharedValue<number>;
  onActivate: () => void;
}) {
  // 到达极限：opacity 0.35（transition: opacity 0.2s ease）
  const dim = useSharedValue(off ? 0.35 : 1);
  useEffect(() => {
    dim.value = withTiming(off ? 0.35 : 1, { duration: 200, easing: cssEase, reduceMotion: NEVER });
  }, [off, dim]);
  const style = useAnimatedStyle(() => ({
    opacity: dim.value,
    transform: [{ translateX: shake.value }, { scale: press.value }],
  }));
  // lucide Minus / Plus：viewBox 24，M5 12h14 / M12 5v14，stroke-width 2.6，圆头
  const icon = size * 0.42;
  const u = icon / 24;
  const sw = 2.6 * u;
  const bar = { position: 'absolute' as const, backgroundColor: pal.btnFg, borderRadius: sw / 2 };
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={dir < 0 ? `减少 ${step}` : `增加 ${step}`}
        accessibilityState={{ disabled: off }}
        accessibilityActions={[{ name: 'activate' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') onActivate();
        }}
        style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: pal.btn }, style]}
      >
        <View style={[bar, { left: size / 2 - 7 * u - sw / 2, top: size / 2 - sw / 2, width: 14 * u + sw, height: sw }]} />
        {dir > 0 && <View style={[bar, { left: size / 2 - sw / 2, top: size / 2 - 7 * u - sw / 2, width: sw, height: 14 * u + sw }]} />}
      </Animated.View>
    </GestureDetector>
  );
}

// ---------- 负号 ----------

function Sign({ show, ch, h, fs, fg }: { show: boolean; ch: number; h: number; fs: number; fg: string }) {
  const pres = useSharedValue(show ? 1 : 0);
  useEffect(() => {
    pres.value = withSpring(show ? 1 : 0, COL_SPRING);
  }, [show, pres]);
  const style = useAnimatedStyle(() => ({ width: Math.max(0, 0.9 * ch * pres.value), opacity: clampW(pres.value, 0, 1) }));
  return (
    <Animated.View style={[{ height: h, overflow: 'hidden', alignItems: 'center' }, style]}>
      <Text
        style={{ position: 'absolute', top: 0, width: 0.9 * ch, height: h, lineHeight: h, fontSize: fs, fontWeight: '700', textAlign: 'center', color: fg, includeFontPadding: false }}
      >
        −
      </Text>
    </Animated.View>
  );
}

// ---------- 一位 ----------

/** 数字轴弹到新目标：先停掉旧弹簧，再从当前值、带当前速度出发（Reanimated 4 的 mass 默认 4，这里显式给 1） */
function springTo(mv: SharedValue<number>, vel: SharedValue<number>, target: number, jumpFrom: number | null, k: number, c: number) {
  'worklet';
  let v = vel.value;
  cancelAnimation(mv);
  if (jumpFrom !== null) {
    mv.value = jumpFrom;
    v = 0;
  }
  mv.value = withSpring(target, { stiffness: k, damping: c, mass: 1, velocity: v, reduceMotion: NEVER });
}

function Column({
  place,
  abs,
  shown,
  enterFrom,
  stiffness,
  damping,
  blur,
  ch,
  h,
  fs,
  pal,
}: {
  place: number;
  abs: number;
  shown: boolean;
  enterFrom: number;
  stiffness: number;
  damping: number;
  blur: boolean;
  ch: number;
  h: number;
  fs: number;
  pal: Palette;
}) {
  const target = Math.floor(abs / 10 ** place);
  // 一位的「数字轴」：值 12 表示十位停在 2（mod 10），所以 9 → 10 是往前滚一格而不是倒回去
  const mv = useSharedValue(target);
  const vel = useSharedValue(0);
  const prev = useSharedValue(target);
  // 出现 / 消失：宽度 0 ↔ 1ch，spring { stiffness: 420, damping: 34 }（初次渲染不做动画）
  const pres = useSharedValue(shown ? 1 : 0);
  const wasShown = useRef(shown);

  // useVelocity：逐帧差分，单位 / 秒
  useFrameCallback((f) => {
    'worklet';
    const dt = f.timeSincePreviousFrame;
    const x = mv.value;
    const v = dt ? ((x - prev.value) * 1000) / dt : 0;
    if (v !== vel.value) vel.value = v;
    prev.value = x;
  });

  useEffect(() => {
    if (shown) {
      // 新出现的位从「上一个数字」滚进来（只在完全收起后重新出现时）
      const entering = !wasShown.current;
      wasShown.current = true;
      const jumpFrom = entering && pres.value < 0.001 ? target + enterFrom : null;
      if (entering) pres.value = withSpring(1, COL_SPRING);
      runOnUI(springTo)(mv, vel, target, jumpFrom, stiffness, damping);
    } else if (wasShown.current) {
      // 消失的位保持最后的数字，只收起宽度
      wasShown.current = false;
      pres.value = withSpring(0, COL_SPRING);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, target]);

  const colStyle = useAnimatedStyle(() => ({ width: Math.max(0, ch * pres.value), opacity: clampW(pres.value, 0, 1) }));
  // 模糊半径 = min(|v| * 0.2, 4)px；用主体变淡 + 上下两层残影近似
  const mainStyle = useAnimatedStyle(() => {
    const b = blur ? Math.min(Math.abs(vel.value) * 0.2, 4) : 0;
    return { opacity: 1 - 0.35 * (b / 4) };
  });
  const ghostUp = useAnimatedStyle(() => {
    const b = blur ? Math.min(Math.abs(vel.value) * 0.2, 4) : 0;
    return { opacity: 0.4 * (b / 4), transform: [{ translateY: -0.9 * b }] };
  });
  const ghostDown = useAnimatedStyle(() => {
    const b = blur ? Math.min(Math.abs(vel.value) * 0.2, 4) : 0;
    return { opacity: 0.4 * (b / 4), transform: [{ translateY: 0.9 * b }] };
  });

  const fade = 0.22 * h;
  return (
    <Animated.View style={[{ height: h, overflow: 'hidden', alignItems: 'center' }, colStyle]}>
      {/* 数字轴：宽 1ch，在列里居中，列变窄时两边一起被裁掉 */}
      <View style={{ position: 'absolute', top: 0, width: ch, height: h }}>
        {DIGITS.map((d) => (
          <Digit
            key={d}
            digit={d}
            mv={mv}
            ch={ch}
            h={h}
            fs={fs}
            fg={pal.fg}
            blur={blur}
            mainStyle={mainStyle}
            ghostUp={ghostUp}
            ghostDown={ghostDown}
          />
        ))}
      </View>
      {/* 上下渐隐（CSS mask 的近似：盖一层胶囊底色的渐变） */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: fade,
          backgroundImage: `linear-gradient(to bottom, ${pal.pill}, ${pal.pillClear})`,
          pointerEvents: 'none',
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: fade,
          backgroundImage: `linear-gradient(to top, ${pal.pill}, ${pal.pillClear})`,
          pointerEvents: 'none',
        }}
      />
    </Animated.View>
  );
}

type AnimatedStyle = ReturnType<typeof useAnimatedStyle>;

function Digit({
  digit,
  mv,
  ch,
  h,
  fs,
  fg,
  blur,
  mainStyle,
  ghostUp,
  ghostDown,
}: {
  digit: number;
  mv: SharedValue<number>;
  ch: number;
  h: number;
  fs: number;
  fg: string;
  blur: boolean;
  mainStyle: AnimatedStyle;
  ghostUp: AnimatedStyle;
  ghostDown: AnimatedStyle;
}) {
  // 每个数字按与当前值的环形距离摆放：比当前大的在下方，小的在上方
  const style = useAnimatedStyle(() => {
    const pv = ((mv.value % 10) + 10) % 10;
    let offset = (10 + digit - pv) % 10;
    if (offset > 5) offset -= 10;
    return { transform: [{ translateY: offset * h }] };
  });
  const text = {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    width: ch,
    height: h,
    lineHeight: h,
    fontSize: fs,
    fontWeight: '700' as const,
    fontVariant: ['tabular-nums' as const],
    textAlign: 'center' as const,
    color: fg,
    includeFontPadding: false,
  };
  return (
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: ch, height: h }, style]}>
      {blur && (
        <>
          <Animated.Text style={[text, ghostUp]}>{digit}</Animated.Text>
          <Animated.Text style={[text, ghostDown]}>{digit}</Animated.Text>
        </>
      )}
      <Animated.Text style={[text, mainStyle]}>{digit}</Animated.Text>
    </Animated.View>
  );
}
