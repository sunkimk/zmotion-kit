// 点赞迸发（React Native 版）：按下时爱心被压扁，松开后带着速度弹起、瞬间填色，光环和两层粒子同时炸开；计数只滚动变化的那一位。
// 对应网站 src/cases/like-burst（React + motion）。尺寸按 em 换算（根字号随容器缩放），参数里的 px 以 16px 为基准。
// 动画全部是 Reanimated 共享值（UI 线程），手势用 Gesture Handler 的 Tap。
// 不依赖 react-native-svg：爱心用同一条 SVG 路径预先栅格化成白色蒙版 PNG（8 倍分辨率），再用 tintColor 上色。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View, useColorScheme, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  cancelAnimation,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

export type LikeBurstProps = {
  /** 点亮后爱心、光环和粒子的颜色 */
  color?: string;
  /** 炸开的粒子数量（4–24） */
  particles?: number;
  /** 粒子飞出的距离，px（24–96） */
  spread?: number;
  /** 爱心弹起时的回弹程度，0 为不回弹（0–0.9） */
  bounce?: number;
  /** 是否在爱心旁显示点赞数 */
  showCount?: boolean;
};

// 和网站一样：系统「减弱动态效果」只关掉迸发，爱心和计数照常动
const NEVER = ReduceMotion.Never;
const PRESS_MS = 90;
const POP_MS = 260;
const RING_MS = 420;
const DOT_MS = 700;
const BURST_MS = 80 + 30 + DOT_MS;
/** 1ch：系统字体半粗等宽数字的宽度 / 字号（iOS SF Pro ≈ 0.631，Android Roboto = 0.5615） */
const CH = Platform.OS === 'ios' ? 0.6314 : 0.5615;

// ---------- 曲线（worklet，UI 线程上跑） ----------

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
const clamp01 = (v: number) => {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
};
const pressEase = (t: number) => {
  'worklet';
  return cubicBezier(0.3, 0, 0.5, 1, t);
};
const popEase = (t: number) => {
  'worklet';
  return cubicBezier(0.28, 1.3, 0.36, 1, t);
};
const ringEase = (t: number) => {
  'worklet';
  return cubicBezier(0.2, 0.7, 0.3, 1, t);
};
const dotEase = (t: number) => {
  'worklet';
  return cubicBezier(0.15, 0.8, 0.3, 1, t);
};
const easeOut = (t: number) => {
  'worklet';
  return cubicBezier(0, 0, 0.58, 1, t);
};
const easeInOut = (t: number) => {
  'worklet';
  return cubicBezier(0.42, 0, 0.58, 1, t);
};
/** CSS 的 ease */
const cssEase = (t: number) => {
  'worklet';
  return cubicBezier(0.25, 0.1, 0.25, 1, t);
};
const linear = (t: number) => {
  'worklet';
  return t;
};

const PRESS = { duration: PRESS_MS, easing: pressEase, reduceMotion: NEVER };
const POP = { duration: POP_MS, easing: popEase, reduceMotion: NEVER };

// ---------- 颜色 ----------

type Palette = { fg: string; muted: string; chip: string; chipRing: string; like2: string; shadow: string };

function palette(dark: boolean, like: string): Palette {
  return dark
    ? {
        fg: '#f2f2f2',
        muted: '#6c6c6c',
        chip: '#232323',
        chipRing: 'rgba(255,255,255,0.06)',
        like2: oklabMix(like, '#ffffff', 0.6),
        shadow: '0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px -6px rgba(0,0,0,0.5)',
      }
    : {
        fg: '#111111',
        muted: '#9a9a9a',
        chip: '#ffffff',
        chipRing: 'rgba(0,0,0,0.04)',
        like2: oklabMix(like, '#ffffff', 0.55),
        shadow: '0 0 0 1px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.05), 0 8px 24px -6px rgba(0,0,0,0.1)',
      };
}

function parseHex(hex: string): [number, number, number] {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const v = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(v)) return [0, 0, 0];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const gam = (v: number) => {
  const c = Math.min(Math.max(v, 0), 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};
function toOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: [number, number, number]): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
/** CSS 的 color-mix(in oklab, a w, b) */
function oklabMix(a: string, b: string, w: number): string {
  const x = toOklab(parseHex(a));
  const y = toOklab(parseHex(b));
  const rgb = fromOklab([x[0] * w + y[0] * (1 - w), x[1] * w + y[1] * (1 - w), x[2] * w + y[2] * (1 - w)]);
  return `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
}

// ---------- 组件 ----------

export function LikeBurst({
  color = '#FF3B5C',
  particles = 12,
  spread = 56,
  bounce = 0.5,
  showCount = true,
}: LikeBurstProps) {
  const dark = useColorScheme() === 'dark';
  const reduce = useReducedMotion();
  const pal = useMemo(() => palette(dark, color), [dark, color]);
  // 根字号：clamp(15px, 5.2cqmin, 24px)，量到容器尺寸前先不显示，避免跳一下
  const [em, setEm] = useState<number | null>(null);
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState(128);
  const [burst, setBurst] = useState(0);
  const likedRef = useRef(false);
  // 爱心自己的缩放：按下压扁，松开带着速度弹回（点亮时速度更大，会冲过 1 再回来）
  const heart = useSharedValue(1);
  // 整个按钮的 whileTap 缩放
  const chip = useSharedValue(1);
  // 点亮程度：点亮是瞬间的（配合弹起），熄灭才用 0.22s ease 慢慢褪
  const lit = useSharedValue(0);

  const toggle = () => {
    const next = !likedRef.current;
    likedRef.current = next;
    setLiked(next);
    setCount((c) => c + (next ? 1 : -1));
    if (next && !reduce) setBurst((b) => b + 1);
    // 先停掉按下时的补间：Reanimated 打断时会把旧动画的速度叠加进来，motion 是直接用给定的初速度
    cancelAnimation(heart);
    heart.value = withSpring(1, {
      stiffness: 520,
      damping: next ? 34 - bounce * 26 : 30,
      mass: 1,
      velocity: next ? 6 + bounce * 10 : 2,
      reduceMotion: NEVER,
    });
    if (next) {
      cancelAnimation(lit);
      lit.value = 1;
    } else {
      lit.value = withTiming(0, { duration: 220, easing: cssEase, reduceMotion: NEVER });
    }
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  // 和 motion 的 onTapStart / onTap / onTapCancel 对应：按下压扁；在按钮里松手算点击；拖出去松手算取消
  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .maxDuration(60_000)
        .shouldCancelWhenOutside(true)
        .onBegin(() => {
          heart.value = withTiming(0.78, PRESS);
          chip.value = withTiming(0.96, PRESS);
        })
        .onFinalize((_e, success) => {
          chip.value = withTiming(1, POP);
          if (success) toggleRef.current();
          else heart.value = withSpring(1, { stiffness: 500, damping: 30, mass: 1, reduceMotion: NEVER });
        }),
    [heart, chip]
  );

  const chipStyle = useAnimatedStyle(() => ({ transform: [{ scale: chip.value }] }));
  const heartStyle = useAnimatedStyle(() => ({ transform: [{ scale: heart.value }] }));
  const fillStyle = useAnimatedStyle(() => ({ opacity: lit.value }));
  // CSS 颜色过渡是在 sRGB 里直接插值，所以 gamma 取 1
  const strokeStyle = useAnimatedStyle(() => ({
    tintColor: interpolateColor(lit.value, [0, 1], [pal.muted, color], 'RGB', { gamma: 1 }),
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setEm(Math.min(Math.max(15, 0.052 * Math.min(width, height)), 24));
  };

  const n = Math.round(particles);

  return (
    <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }} onLayout={onLayout}>
      {em !== null && (
        <GestureDetector gesture={gesture}>
          <Animated.View
            accessible
            accessibilityRole="button"
            accessibilityLabel={liked ? '取消点赞' : '点赞'}
            accessibilityState={{ selected: liked }}
            accessibilityActions={[{ name: 'activate' }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'activate') toggle();
            }}
            style={[
              {
                flexDirection: 'row',
                alignItems: 'center',
                paddingTop: 0.75 * em,
                paddingBottom: 0.75 * em,
                paddingLeft: 0.95 * em,
                paddingRight: 1.35 * em,
                borderRadius: 999,
                backgroundColor: pal.chip,
                // 1px 描边环 + 投影，和网页 box-shadow 同一串（RN 0.76+ 新架构支持）
                boxShadow: pal.shadow,
              },
              chipStyle,
            ]}
          >
            <View style={{ width: 2.25 * em, height: 2.25 * em }}>
              {burst > 0 && (
                <Burst
                  key={burst}
                  em={em}
                  liked={liked}
                  n={n}
                  spread={spread}
                  like={color}
                  like2={pal.like2}
                />
              )}
              <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: 2.25 * em, height: 2.25 * em }, heartStyle]}>
                <Animated.Image
                  source={HEART_FILL}
                  fadeDuration={0}
                  resizeMode="stretch"
                  style={[{ position: 'absolute', width: 2.25 * em, height: 2.25 * em, tintColor: color }, fillStyle]}
                />
                <Animated.Image
                  source={HEART_STROKE}
                  fadeDuration={0}
                  resizeMode="stretch"
                  style={[{ position: 'absolute', width: 2.25 * em, height: 2.25 * em }, strokeStyle]}
                />
              </Animated.View>
            </View>
            {showCount && <Count value={count} up={liked} em={em} fg={pal.fg} />}
          </Animated.View>
        </GestureDetector>
      )}
    </View>
  );
}

// ---------- 光环 + 粒子（每次点亮换一个 key，重新炸一次） ----------

function Burst({
  em,
  liked,
  n,
  spread,
  like,
  like2,
}: {
  em: number;
  liked: boolean;
  n: number;
  spread: number;
  like: string;
  like2: string;
}) {
  // 从这次迸发开始经过的毫秒数，所有光环/粒子都按它取样
  const clock = useSharedValue(0);
  // 取消点赞时光环 0.12s 淡出
  const exit = useSharedValue(1);

  useEffect(() => {
    clock.value = withTiming(BURST_MS, { duration: BURST_MS, easing: linear, reduceMotion: NEVER });
  }, [clock]);
  useEffect(() => {
    if (!liked) exit.value = withTiming(0, { duration: 120, easing: easeInOut, reduceMotion: NEVER });
  }, [liked, exit]);

  const px = em / 16;
  const ringBorder = 9 * px;
  // 光环：scale 0.45→1.4、边框 9px→0（0.42s, [0.2,0.7,0.3,1]），透明度 [1,1,0] @ [0,0.55,1]
  const ringStyle = useAnimatedStyle(() => {
    const p = clamp01(clock.value / RING_MS);
    const e = ringEase(p);
    const o = p <= 0.55 ? 1 : 1 - easeInOut((p - 0.55) / 0.45);
    return {
      opacity: o * exit.value,
      borderWidth: ringBorder * (1 - e),
      transform: [{ scale: 0.45 + (1.4 - 0.45) * e }],
    };
  });

  const ringSize = 2.85 * em; // inset: -0.3em
  const center = 1.125 * em;
  const dots: { a: number; d: number; s: number; delay: number; c: string }[] = [];
  if (liked) {
    for (let i = 0; i < n; i++) {
      // 每个方向一大一小两颗，小的略偏一点角度、飞得更近，颜色浅一档
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      dots.push({ a, d: spread * px, s: 7 * px, delay: 80, c: like });
      dots.push({ a: a + 0.32, d: spread * 0.72 * px, s: 5 * px, delay: 110, c: like2 });
    }
  }

  return (
    <>
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: -0.3 * em,
            top: -0.3 * em,
            width: ringSize,
            height: ringSize,
            borderRadius: ringSize / 2,
            borderColor: like,
            pointerEvents: 'none',
          },
          ringStyle,
        ]}
      />
      {dots.map((d, k) => (
        <Dot key={k} clock={clock} center={center} {...d} />
      ))}
    </>
  );
}

function Dot({
  clock,
  center,
  a,
  d,
  s,
  delay,
  c,
}: {
  clock: SharedValue<number>;
  center: number;
  a: number;
  d: number;
  s: number;
  delay: number;
  c: string;
}) {
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // 位置：0.45d → d（0.7s, [0.15,0.8,0.3,1]）；scale：[0,1,0] @ [0,0.25,1]，每段 easeOut
  const style = useAnimatedStyle(() => {
    const p = clamp01((clock.value - delay) / DOT_MS);
    const r = d * (0.45 + 0.55 * dotEase(p));
    const sc = p < 0.25 ? easeOut(p / 0.25) : 1 - easeOut((p - 0.25) / 0.75);
    return { transform: [{ translateX: cos * r }, { translateY: sin * r }, { scale: sc }] };
  });
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: center - s / 2,
          top: center - s / 2,
          width: s,
          height: s,
          borderRadius: s / 2,
          backgroundColor: c,
          pointerEvents: 'none',
        },
        style,
      ]}
    />
  );
}

// ---------- 计数 ----------

/** 只滚动变化的那几位：点赞时新数字从下往上进，取消时反过来 */
function Count({ value, up, em, fg }: { value: number; up: boolean; em: number; fg: string }) {
  const chars = String(value).split('');
  const fs = 1.2 * em;
  const w = CH * fs;
  return (
    // zIndex：粒子从数字后面穿过
    <View style={{ flexDirection: 'row', minWidth: 3 * w, marginLeft: 0.6 * em, zIndex: 1 }}>
      {chars.map((ch, i) => {
        const slot = chars.length - i; // 从个位往左数，位数变化时其它位不跟着动
        return <Slot key={slot} ch={ch} up={up} fs={fs} w={w} fg={fg} />;
      })}
    </View>
  );
}

function Slot({ ch, up, fs, w, fg }: { ch: string; up: boolean; fs: number; w: number; fg: string }) {
  // gen 0 是第一次出现（initial={false}，不做进场）；之后每换一个数字 gen +1，新旧两个数字各自是新组件
  const [st, setSt] = useState<{ cur: string; prev: string | null; gen: number; up: boolean }>({
    cur: ch,
    prev: null,
    gen: 0,
    up,
  });
  if (st.cur !== ch) setSt({ cur: ch, prev: st.cur, gen: st.gen + 1, up });
  const h = 1.25 * fs;
  const pad = 0.12 * fs;
  return (
    <View style={{ width: w, height: h + pad * 2, marginTop: -pad, marginBottom: -pad, overflow: 'hidden' }}>
      {st.prev !== null && <Digit key={`x${st.gen}`} ch={st.prev} kind="exit" up={st.up} fs={fs} w={w} h={h} top={pad} fg={fg} />}
      <Digit key={`e${st.gen}`} ch={st.cur} kind={st.gen === 0 ? 'still' : 'enter'} up={st.up} fs={fs} w={w} h={h} top={pad} fg={fg} />
    </View>
  );
}

function Digit({
  ch,
  kind,
  up,
  fs,
  w,
  h,
  top,
  fg,
}: {
  ch: string;
  kind: 'still' | 'enter' | 'exit';
  up: boolean;
  fs: number;
  w: number;
  h: number;
  top: number;
  fg: string;
}) {
  // y：0.26s [0.28,1.3,0.36,1]（带回弹）；透明度：0.16s easeInOut
  const py = useSharedValue(kind === 'still' ? 1 : 0);
  const po = useSharedValue(kind === 'still' ? 1 : 0);
  useEffect(() => {
    if (kind === 'still') return;
    py.value = withTiming(1, POP);
    po.value = withTiming(1, { duration: 160, easing: easeInOut, reduceMotion: NEVER });
  }, [kind, py, po]);
  const dist = (up ? 1 : -1) * 0.7 * h;
  const isExit = kind === 'exit';
  const style = useAnimatedStyle(() =>
    isExit
      ? { opacity: 1 - po.value, transform: [{ translateY: -dist * py.value }] }
      : { opacity: po.value, transform: [{ translateY: dist * (1 - py.value) }] }
  );
  return (
    <Animated.Text
      style={[
        {
          position: 'absolute',
          left: 0,
          top,
          width: w,
          height: h,
          lineHeight: h,
          fontSize: fs,
          fontWeight: '600',
          fontVariant: ['tabular-nums'],
          textAlign: 'center',
          color: fg,
          includeFontPadding: false,
        },
        style,
      ]}
    >
      {ch}
    </Animated.Text>
  );
}

// ---------- 爱心蒙版（viewBox 24 的网站 SVG 路径，192×192 白色，描边 1.8、圆角连接） ----------
// M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.6 4.5c2.1 0 3.6 1.2 5.4 3.1 1.8-1.9 3.3-3.1 5.4-3.1 3.7 0 5.7 3.9 4.2 7.3C19.5 16.4 12 21 12 21z

const HEART_STROKE = {
  uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAALlUExURUdwTP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////4M8h4cAAAD2dFJOUwD9/P4CAfgGBwMfDWESYAnuRQj6rDQ24tHd7/H5RwUiBGjM0+P0NUpnDhf3sPvP3PbJGiQULRBrbWljQCEZZGqdmPXgp9fwwMqvCm8R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',
};
const HEART_FILL = {
  uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAH+UExURUdwTP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////yhkgbsAAACpdFJOUwABDPcD2gnDBgcNwP35EQtNXwLStfrtscv+ZS3u2MLzrR9EPmAnLxI9Ixt7aSYEcgpqdaX08Jnh04/e6qu5xcihvsS8x/UINzbm7/KTjK5RfHFBVEkFVm1adDtoJENhIB15OmsrQkUYMFwlW39nTDUiFHpIORVkISgc7LaiqZvjgaqDmr+6n9uAna/Bh+u0pJyn9rf86caIz9Gj4LP71OiwZixLSufXkovD3u9AAAAFSUlEQVR42u2chXIbSRRF34hlgWPJsiMzxRAzM0MMYWZmZmZmZl7e/stN7aZSm8Ryd8/0zLypeucD7pxb1siNAiAIgiAIgiAIgiAIgiAIgiAIgiAIIiXFixY3h7xnW8KR1on4ubYlS6MqUqNLl7Sdi//RGgm3nPWGmhcvKjZF3rXsfDv7iY7O5QEjqYHlnR0/p7afX+ZSa6+VXHCzFORdLNUbW3oxL1Wq+0KJpkx/RVk+m5F4zph8qi8nPnNqftkKNf4ruxiXiVVBudDgqgl+atdKBfpz/EyIS6tlUldfEkstmGP0w7/GzUTxl4umlvuFQ91rDL0KFZlMgsRloW+kwOWETGpmhYGPTxeTI57LD82NS4Z26f4Yrc1isrjX8ULXuaVDs9bq868sZDq4kj5TZvoVPZmFlXr857UwXXRUpc6s6tCX2TIu77++m+kkb0OqzA2TejO718v6p+Uz3SQ2Tp+5MaE/8880yQI9zAhXp4u8aiiyR84/hxnjmufHRM81g5E5Mv6bCg0+jRX9MDYKFhlNnNokUSCTGabX993Qs9d4Yqa4/yymgOv/m5O4rqtInCXq78lX8TjW9+2LI61PSWC+R7BABlND39e/gatPUWCG4BDaq+h5zP9vA5dfVZ5Xs+4N+I/QlzfZF1KXJ/YW3FD3QNYbDPYqjLsh4r85rPCJLDtbZVp4s0CBLQwxWwQKzMZcYDbff24Sc4HkXG6BMoaaMm6Bm7gL3OQWuIW7wC3uTCyJu0CSNzPbypCz1aKBnGnwBnS3sRe4zSlwB3uBO5wCd7EXuMspEMJeIMQp0I+9QL+Th3IiwznHF7iHvcA985e0zIW3vDWAvcAAp8B97AXucwpsw15gG6dACfYCJbwpMfYC3EnxA9z+D7hTyoe4CzzkFqjGXaCavz2Mu8A8boFYFmb/rBh/ae4R5gKPrN0eUI/IBkFgEq//pNCBpPl4C/wltEOzHW+B7WK7fINY/QcFt1l3YC2wQ3Snewin/5DwUYOdOAvsFD8sMYzRf1jitEp5GJ9/uFyiADzGV+Cx1ImtXa3Y/Ft3yZ05q8FWoEb21PcILv8R6TPguQlM/olckAbV3LJa3h88iLYK+j06CkDtKBb/0Vp9x9d/wVIgB3TyBIf/E903ONK8GPy9aboLwO6n9vs/3W3kFtAe+wvsMXYPq9Nu/06DF8nqbJ4gD9YZvclXYeuL7K0Aw+y1cbE0a6+Ky6ClEbv8I6WghH1Je/yT+1RdKK63p0C9uhvdC+zw/1vllXQbNvAHNIUFwFNktX+RB5QSeGat/7MAKMZn6WG0kA+Uk15gnX9BOpiAuss8PPwuMAWXRcvuQyb5f/kUWbJqPZwOphHMNt8/OwgmUtdstn9zHZhKrM1c/7YYmI2p46IFYAH7zfPfD5Zw4Lk5+s8PgEUcNGXVdPQgWMahF+r9XxwCCzmsfK3Cexgs5chLtf4vj4DF+BYqnb74wHK0V+r8X2lgBxmKFowiGWATld0q/LsrwTaKXxv3f10MNtLQY9S/pwFsRTtq6GBL+KgGdnMsT79/3jFAQNUbvf5vqgAFDW/1+b9tACw06viPEGkERIy/k/V/Nw6oiL6X838fBWRoTR/E9T80aYCP4+2i/u3HASVRwRH2wihgpUbgpyzdNYCY3I88/4+/AmrGONcn5o8Bdn77lFr/0+/gAE6kXMLOPgHO4OS0P9VYeBIcw6lp9tMKToGDiNX/8IXqro+Bszj93eHrkdPgODxN3/4I7iYPOJHar/uy/lpwKFrjFGNTjRo4lzOfP58BgiAIgiAIgiAIgiAIglDOP2lskCxhXReYAAAAAElFTkSuQmCC',
};
