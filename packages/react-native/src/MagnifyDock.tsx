// 放大程序坞（React Native 版）：仿 macOS / iPadOS / iOS 的程序坞。点图标会跳几下再「启动」，再点一次前台的图标就退出。
// 对应网站 src/cases/magnify-dock（React + motion）。
// 多端（和网站版一样按组件自己的宽度分，onLayout）：< 600 手机程序坞（等分的玻璃条，图标按下缩小变暗、松手回弹）；
// 600–899 iPad 悬浮程序坞（左常用、竖线、右最近使用，不放大）；≥ 900 macOS 式放大程序坞。也可以用 layout 固定成某一端。
//
// 触屏没有悬停：网站版在触屏上只点按、不放大。这里手机 / iPad 程序坞照此不放大；桌面式程序坞把「悬停」换成「按住滑动」——
// 手指按住 0.3s 或滑动超过 8px 进入放大，图标按与手指的距离放大并浮出名称，在图标上松手就打开它，滑出程序坞再松手算取消；轻点仍是直接打开。
//
// 网页演示里的假桌面 / 主屏（壁纸、主屏图标网格、iPad 小组件、状态栏、菜单栏、底部横条）和打开后的假 App 窗口不画：
// 图标由宿主通过 items 传（不传用网站版默认图标），打开 / 退出走 onOpen / onClose；onOpen 带图标在窗口里的位置，宿主可以从图标处放大自己的页面。
//
// 依赖：react-native-reanimated + react-native-gesture-handler。放大的尺寸弹簧、按压、跳动都在 UI 线程。
// 不依赖 react-native-svg：默认图标是网站版 lucide 线条图标预先栅格化的白色蒙版 PNG（192×192），用 tintColor 上色。
// 没有毛玻璃（backdrop-filter）：iPad / 手机程序坞只用 style.css 里的半透明底色。
import { isValidElement, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactElement } from 'react';
import { Image, Text, View, useColorScheme, type ImageSourcePropType } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView, State } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  ZoomOut,
  cancelAnimation,
  makeMutable,
  measure,
  runOnJS,
  useAnimatedRef,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

export type MagnifyDockItem = {
  /** 唯一标识；不传时用 title */
  id?: string;
  /** 名称：放大时浮在图标上方，也用作无障碍标签 */
  title: string;
  /** 图标：图片会当作模板按 fg 着色（白色蒙版 PNG 最合适）；也可以传任意元素（原样居中，占图标 52%） */
  icon?: ImageSourcePropType | ReactElement;
  /** 底色渐变（160°），两个颜色 */
  colors?: [string, string];
  /** 图标前景色，默认白色 */
  fg?: string;
  /** 桌面程序坞里在它前面画一条竖线（网站版「系统设置」前面那条） */
  divider?: boolean;
};

/** 图标在窗口里的位置（measureInWindow） */
export type MagnifyDockFrame = { x: number; y: number; width: number; height: number };

export type MagnifyDockProps = {
  /** 手指正下方图标的放大倍数，1 为不放大（1–2.6）。只在桌面式程序坞按住滑动时生效 */
  magnification?: number;
  /** 离手指多远以内的图标会被放大，越大衰减越平缓（px，60–320）。只在桌面式程序坞生效 */
  distance?: number;
  /** 图标静止时的尺寸（px，32–72），容器太窄时会自动缩小；iPad / 手机以它为基准再放大一点 */
  baseSize?: number;
  /** 启动时图标是否上下跳几下（三端都有；系统开了「减弱动态效果」时不跳） */
  bounce?: boolean;
  /** 桌面式程序坞放大时是否在图标上方浮出名称 */
  labels?: boolean;
  /** 程序坞里的图标；不传时用网站版的默认图标（桌面 11 个、iPad 6 个、手机 4 个） */
  items?: MagnifyDockItem[];
  /** iPad 程序坞竖线右侧的「最近使用」（最多 3 个，和 items 重复的不显示）；不传时默认图标下显示「访达」，自定义 items 下为空 */
  recents?: MagnifyDockItem[];
  /** 固定成某一端；auto 按组件宽度 */
  layout?: 'auto' | 'phone' | 'ipad' | 'desktop';
  /** 前台 App 的 id（传了就是受控）。宿主关掉自己的页面时设回 null，程序坞就把那个 App 当作已退出 */
  active?: string | null;
  /** 启动或切到前台时回调（启动时在跳动结束、网站版窗口弹出的那一刻），带图标在窗口里的位置 */
  onOpen?: (item: MagnifyDockItem, iconFrame: MagnifyDockFrame) => void;
  /** 再点一次前台 App 的图标退出时回调 */
  onClose?: (item: MagnifyDockItem) => void;
};

type End = 'phone' | 'ipad' | 'desktop';
const endOf = (w: number): End => (w >= 900 ? 'desktop' : w >= 600 ? 'ipad' : 'phone');

// 和网站版一样：减弱动态效果只关掉启动跳动，其余动画照常
const NEVER = ReduceMotion.Never;
const CANCELLED = State.CANCELLED;
/** 按住多久进入放大 */
const HOLD_MS = 300;

// ---------- 曲线（worklet） ----------

/** CSS / motion 的 cubic-bezier(x1, y1, x2, y2)，y 可以超出 0…1 */
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
  let lo = 0;
  let hi = 1;
  let t = p;
  for (let i = 0; i < 40; i++) {
    const x = ((ax * t + bx) * t + cx) * t;
    if (Math.abs(x - p) < 1e-6) break;
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
const easeOut = (t: number) => {
  'worklet';
  return cubicBezier(0, 0, 0.58, 1, t);
};
const easeIn = (t: number) => {
  'worklet';
  return cubicBezier(0.42, 0, 1, 1, t);
};
const easeInOut = (t: number) => {
  'worklet';
  return cubicBezier(0.42, 0, 0.58, 1, t);
};
/** 余弦衰减：手指正下方 1，距离 ≥ dist 时 0 */
const falloff = (t: number) => {
  'worklet';
  return t >= 1 ? 0 : (Math.cos(Math.PI * t) + 1) / 2;
};

/** 放大尺寸：motion useSpring(target, { mass: 0.1, stiffness: 190, damping: 13 })；改目标时 Reanimated 会继承当前速度 */
const SIZE_SPRING = { mass: 0.1, stiffness: 190, damping: 13, reduceMotion: NEVER };
/** 触屏按压：{ duration: 0.09, ease: [0.3, 0, 0.5, 1] }；松手 { type: "spring", stiffness: 520, damping: 20 }，变暗 0.2s 褪去 */
const PRESS_T = { duration: 90, easing: pressEase, reduceMotion: NEVER };
const RELEASE = { stiffness: 520, damping: 20, mass: 1, reduceMotion: NEVER };
const UNDIM_T = { duration: 200, easing: easeInOut, reduceMotion: NEVER };
/** 桌面图标 whileTap：scale 0.92，{ duration: 0.09, ease: "easeOut" } */
const TAP_T = { duration: 90, easing: easeOut, reduceMotion: NEVER };

const gapOf = (b: number) => Math.round(b * 0.2);
const padOf = (b: number) => Math.round(b * 0.2);

/** 手指停在中间图标上方时整条程序坞的宽度，用来决定窄容器里放几个、多大 */
function peakWidth(n: number, b: number, mag: number, dist: number) {
  const g = gapOf(b);
  const pitch = b + g;
  const c = (n - 1) / 2;
  let w = 0;
  for (let k = 0; k < n; k++) w += b + (mag - 1) * b * falloff((Math.abs(k - c) * pitch) / Math.max(1, dist));
  return w + (n - 1) * g + padOf(b) * 2 + g * 2;
}

function fit(width: number, baseSize: number, mag: number, dist: number, count: number) {
  const avail = width - 24;
  const minN = Math.min(5, count);
  for (let n = count; n >= minN && n > 0; n--) {
    for (let b = baseSize; b >= 26; b -= 2) {
      if (peakWidth(n, b, mag, dist) <= avail) {
        if (b >= Math.min(36, baseSize) || n === minN) return { n, b };
        break;
      }
    }
  }
  return { n: minN, b: 26 };
}

// ---------- 颜色（style.css 浅色 / 深色） ----------

type Palette = { glass: string; glassLine: string; glassShadow: string; divider: string; labelBg: string; labelFg: string; dot: string };
const LIGHT: Palette = {
  glass: 'rgba(255,255,255,0.5)',
  glassLine: 'rgba(255,255,255,0.75)',
  glassShadow: '0 1px 1px rgba(0,0,0,0.04), 0 12px 32px -12px rgba(40,40,90,0.3)',
  divider: 'rgba(0,0,0,0.108)',
  labelBg: 'rgba(30,30,34,0.82)',
  labelFg: '#ffffff',
  dot: '#2a2a2e',
};
const DARK: Palette = {
  glass: 'rgba(44,44,58,0.55)',
  glassLine: 'rgba(255,255,255,0.14)',
  glassShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 32px -10px rgba(0,0,0,0.6)',
  divider: 'rgba(255,255,255,0.126)',
  labelBg: 'rgba(240,240,245,0.92)',
  labelFg: '#111111',
  dot: '#f2f2f5',
};
const ICON_SHADOW = 'inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(0,0,0,0.08), 0 4px 10px -4px rgba(0,0,0,0.35)';

// ---------- 默认图标（网站版的 APPS） ----------

type Glyph = keyof typeof GLYPHS;
const app = (id: string, title: string, glyph: Glyph, a: string, b: string, fg?: string, divider?: boolean): MagnifyDockItem => ({
  id,
  title,
  icon: GLYPHS[glyph],
  colors: [a, b],
  fg,
  divider,
});

/** 网站版的 11 个默认图标（桌面程序坞用全部） */
export const MAGNIFY_DOCK_DEFAULT_ITEMS: MagnifyDockItem[] = [
  app('finder', '访达', 'folder', '#7CC8FF', '#1F6BFF'),
  app('browser', '浏览器', 'compass', '#8EE3FF', '#0A84FF'),
  app('messages', '信息', 'message', '#7BEA8C', '#1DB954'),
  app('mail', '邮件', 'mail', '#6FB6FF', '#3157F5'),
  app('photos', '照片', 'photo', '#FFC36B', '#FF4F8B'),
  app('music', '音乐', 'music', '#FF8FA3', '#F2274B'),
  app('calendar', '日历', 'calendar', '#FFFFFF', '#E9E9EE', '#F2453D'),
  app('maps', '地图', 'map', '#B6F37A', '#25B05C'),
  app('notes', '备忘录', 'note', '#FFE58A', '#FFB800'),
  app('terminal', '终端', 'terminal', '#565A66', '#16181D'),
  app('settings', '系统设置', 'settings', '#C9CCD3', '#7A7F8A', undefined, true),
];
const pick = (ids: string[]) => ids.map((id) => MAGNIFY_DOCK_DEFAULT_ITEMS.find((a) => a.id === id)!);
// iPad / 手机程序坞里固定的常用 App
const IPAD_DOCK = pick(['messages', 'browser', 'mail', 'photos', 'music', 'calendar']);
const PHONE_DOCK = pick(['browser', 'messages', 'mail', 'music']);
const IPAD_RECENT_MAX = 3;

const keyOf = (it: MagnifyDockItem) => it.id ?? it.title;
type ViewHandle = ComponentRef<typeof View>;
type RadiusStyle = ReturnType<typeof useAnimatedStyle<{ borderRadius: number }>>;

// ---------- 组件 ----------

export function MagnifyDock({
  magnification = 1.8,
  distance = 150,
  baseSize = 48,
  bounce = true,
  labels = true,
  items,
  recents,
  layout = 'auto',
  active,
  onOpen,
  onClose,
}: MagnifyDockProps) {
  const pal = useColorScheme() === 'dark' ? DARK : LIGHT;
  const reduce = useReducedMotion();
  const [width, setWidth] = useState<number | null>(null);
  const end: End = layout !== 'auto' ? layout : endOf(width ?? 0);
  const rootRef = useAnimatedRef<Animated.View>();

  // 每个图标一组会动的值（惰性创建，不能在循环里调 hook）：放大尺寸、跳动位移、桌面按压缩放
  const sizes = useRef(new Map<string, SharedValue<number>>()).current;
  const lifts = useRef(new Map<string, SharedValue<number>>()).current;
  const presses = useRef(new Map<string, SharedValue<number>>()).current;
  const mv = (map: Map<string, SharedValue<number>>, id: string, init: number) => {
    let v = map.get(id);
    if (!v) {
      v = makeMutable(init);
      map.set(id, v);
    }
    return v;
  };

  // 运行中的 App（桌面程序坞下面的点）；网站版初始状态：访达在运行，自定义 items 从空开始
  const [running, setRunning] = useState<string[]>(() => (items ? [] : ['finder']));
  const [localFront, setLocalFront] = useState<string | null>(null);
  const controlled = active !== undefined;
  const front = controlled ? active : localFront;
  const [hovered, setHovered] = useState<string | null>(null);

  const latest = useRef({ front, running, onOpen, onClose, bounce, reduce });
  latest.current = { front, running, onOpen, onClose, bounce, reduce };
  const lastFront = useRef<string | null>(front);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const iconRefs = useRef(new Map<string, ViewHandle>()).current;
  const allItems = useRef(new Map<string, MagnifyDockItem>()).current;
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // 宿主自己改了前台 App：设回 null 相当于网站版点红点 / 返回退出；设成别的 id 相当于切到前台
  useEffect(() => {
    if (!controlled || active === lastFront.current) return;
    const old = lastFront.current;
    if (active == null && old) setRunning((r) => r.filter((x) => x !== old));
    if (active != null) setRunning((r) => (r.includes(active) ? r : [...r, active]));
    lastFront.current = active ?? null;
  }, [active, controlled]);

  const setFront = (id: string | null) => {
    lastFront.current = id;
    if (!controlled) setLocalFront(id);
  };

  const notifyOpen = (item: MagnifyDockItem) => {
    const cb = latest.current.onOpen;
    if (!cb) return;
    const view = iconRefs.get(keyOf(item));
    if (view) view.measureInWindow((x, y, w, h) => cb(item, { x, y, width: w, height: h }));
    else cb(item, { x: 0, y: 0, width: 0, height: 0 });
  };

  const activate = (id: string, iconSize: number) => {
    const item = allItems.get(id);
    if (!item) return;
    const L = latest.current;
    const y = mv(lifts, id, 0);
    if (L.front === id) {
      // 再点前台应用：轻点一下 [0, 4, 0]（0.24s easeOut），退出
      cancelAnimation(y);
      y.value = withSequence(
        withTiming(4, { duration: 120, easing: easeOut, reduceMotion: NEVER }),
        withTiming(0, { duration: 120, easing: easeOut, reduceMotion: NEVER })
      );
      setRunning((r) => r.filter((x) => x !== id));
      setFront(null);
      L.onClose?.(item);
      return;
    }
    if (L.running.includes(id)) {
      // 已在运行：直接切到前台
      setFront(id);
      notifyOpen(item);
      return;
    }
    setRunning((r) => (r.includes(id) ? r : [...r, id]));
    let delay = 80;
    if (L.bounce && !L.reduce) {
      // 跳动 [0, -h, 0, -h/2, 0, -0.18h, 0]，1.1s，时间点 [0, .2, .42, .58, .74, .86, 1]，easeOut / easeIn 交替；高度按图标尺寸算
      const h = iconSize * 0.62;
      const seg = (to: number, ms: number, easing: (t: number) => number) => withTiming(to, { duration: ms, easing, reduceMotion: NEVER });
      cancelAnimation(y);
      y.value = 0;
      y.value = withSequence(
        seg(-h, 220, easeOut),
        seg(0, 242, easeIn),
        seg(-h * 0.5, 176, easeOut),
        seg(0, 176, easeIn),
        seg(-h * 0.18, 132, easeOut),
        seg(0, 154, easeIn)
      );
      delay = 820;
    }
    timers.current.push(
      setTimeout(() => {
        setFront(id);
        notifyOpen(item);
      }, delay)
    );
  };
  // 手势里调用的稳定入口
  const activateRef = useRef(activate);
  activateRef.current = activate;
  const activateJS = useRef((id: string, size: number) => activateRef.current(id, size)).current;
  const setHoveredJS = useRef((id: string | null) => setHovered(id)).current;

  // ---------- 桌面：放大程序坞 ----------
  const deskAll = items ?? MAGNIFY_DOCK_DEFAULT_ITEMS;
  const f = width == null ? { n: deskAll.length, b: baseSize } : fit(width, baseSize, magnification, distance, deskAll.length);
  const base = f.b;
  const shown = f.n < deskAll.length ? deskAll.slice(0, Math.max(0, f.n - 1)).concat(deskAll[deskAll.length - 1]) : deskAll;
  const gap = gapOf(base);
  const pad = padOf(base);
  const dockH = base + pad * 2;
  const ids = shown.map(keyOf);
  const idsKey = ids.join('|');

  // 参数、容器或分端变化：静止时直接回到新尺寸，名称收起
  useEffect(() => {
    ids.forEach((id) => {
      const s = mv(sizes, id, base);
      cancelAnimation(s);
      s.value = base;
    });
    setHovered(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, end, idsKey]);

  const scrub = useSharedValue(false);
  const down = useSharedValue(false);
  const hold = useSharedValue(0);
  const pressIdx = useSharedValue(-1);
  const hoverIdx = useSharedValue(-1);
  const lastX = useSharedValue(0);
  const lastY = useSharedValue(0);
  const rootCX = useSharedValue(0);

  const pan = useMemo(() => {
    const sizeList = ids.map((id) => mv(sizes, id, base));
    const pressList = ids.map((id) => mv(presses, id, 1));
    const divs = shown.map((it) => !!it.divider);
    const count = ids.length;
    const mag = magnification;
    const dist = Math.max(1, distance);

    /** 每个图标当前的中心和尺寸（相对程序坞中心，按当前帧的弹簧尺寸算，等同网站版每次读 getBoundingClientRect） */
    const layoutNow = () => {
      'worklet';
      const cs: number[] = [];
      const ss: number[] = [];
      let x = 1 + pad;
      for (let i = 0; i < count; i++) {
        if (divs[i]) x += 5 + gap;
        const s = sizeList[i].value;
        cs.push(x + s / 2);
        ss.push(s);
        x += s + gap;
      }
      const total = x - gap + pad + 1;
      for (let i = 0; i < count; i++) cs[i] -= total / 2;
      return { cs, ss, total };
    };
    const hitAt = (x: number, cs: number[], ss: number[]) => {
      'worklet';
      const half = gap / 2;
      let hit = -1;
      for (let i = 0; i < count; i++) if (x >= cs[i] - ss[i] / 2 - half && x <= cs[i] + ss[i] / 2 + half) hit = i;
      return hit;
    };
    /** 手指是否还在程序坞上（上方留出放大后图标的高度，相当于网站版指针还在程序坞或放大的图标上） */
    const inside = (x: number, y: number, total: number) => {
      'worklet';
      return Math.abs(x) <= total / 2 + gap / 2 && y >= -(base * (mag - 1)) - 24 && y <= dockH + 24;
    };
    const magnifyAt = (x: number) => {
      'worklet';
      const { cs, ss } = layoutNow();
      const hit = hitAt(x, cs, ss);
      for (let i = 0; i < count; i++) {
        sizeList[i].value = withSpring(base + (mag - 1) * base * falloff(Math.abs(x - cs[i]) / dist), SIZE_SPRING);
      }
      if (hit >= 0 && hit !== hoverIdx.value) {
        hoverIdx.value = hit;
        runOnJS(setHoveredJS)(ids[hit]);
      }
    };
    const restAll = () => {
      'worklet';
      for (let i = 0; i < count; i++) sizeList[i].value = withSpring(base, SIZE_SPRING);
      if (hoverIdx.value !== -1) {
        hoverIdx.value = -1;
        runOnJS(setHoveredJS)(null);
      }
    };
    const track = () => {
      'worklet';
      const { total } = layoutNow();
      if (inside(lastX.value, lastY.value, total)) magnifyAt(lastX.value);
      else restAll();
    };
    const releasePress = () => {
      'worklet';
      const p = pressIdx.value;
      pressIdx.value = -1;
      if (p >= 0) pressList[p].value = withTiming(1, TAP_T);
      return p;
    };
    const beginScrub = () => {
      'worklet';
      if (scrub.value || !down.value) return;
      scrub.value = true;
      releasePress();
      track();
    };

    return Gesture.Pan()
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .onBegin((e) => {
        'worklet';
        const { cs, ss, total } = layoutNow();
        const m = measure(rootRef);
        rootCX.value = m ? m.pageX + m.width / 2 : e.absoluteX - e.x + total / 2;
        down.value = true;
        scrub.value = false;
        lastX.value = e.absoluteX - rootCX.value;
        lastY.value = e.y;
        const h = hitAt(lastX.value, cs, ss);
        pressIdx.value = h;
        if (h >= 0) pressList[h].value = withTiming(0.92, TAP_T);
        // 按住不动 0.3s 也进入放大（相当于把指针「停」在程序坞上）
        hold.value = 0;
        hold.value = withDelay(
          HOLD_MS,
          withTiming(1, { duration: 0, reduceMotion: NEVER }, (finished) => {
            'worklet';
            if (finished) beginScrub();
          })
        );
      })
      .onUpdate((e) => {
        'worklet';
        lastX.value = e.absoluteX - rootCX.value;
        lastY.value = e.y;
        if (!scrub.value) {
          if (Math.hypot(e.translationX, e.translationY) > 8) {
            cancelAnimation(hold);
            beginScrub();
          }
          return;
        }
        track();
      })
      .onFinalize((e) => {
        'worklet';
        down.value = false;
        cancelAnimation(hold);
        const p = releasePress();
        const x = e.absoluteX - rootCX.value;
        const { cs, ss, total } = layoutNow();
        const ok = e.state !== CANCELLED && inside(x, e.y, total);
        const h = ok ? hitAt(x, cs, ss) : -1;
        if (scrub.value) {
          // 滑动放大后松手：在图标上松手就打开它，滑出程序坞松手算取消
          scrub.value = false;
          restAll();
          if (h >= 0) runOnJS(activateJS)(ids[h], base);
        } else if (p >= 0 && h === p) {
          runOnJS(activateJS)(ids[p], base);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, base, gap, pad, dockH, magnification, distance]);

  // ---------- 触屏端 ----------
  const W = width ?? 0;
  const touchBase = Math.round(baseSize * (end === 'ipad' ? 1.3 : 1.25));
  const ipadList = items ?? IPAD_DOCK;
  const fixed = new Set(ipadList.map(keyOf));
  const recentList = (recents ?? (items ? [] : pick(['finder']))).filter((it) => !fixed.has(keyOf(it))).slice(0, IPAD_RECENT_MAX);
  const phoneList = items ?? PHONE_DOCK;

  // 当前显示的所有图标（activate 按 id 找回宿主传进来的对象）
  allItems.clear();
  const visible = end === 'desktop' ? shown : end === 'ipad' ? ipadList.concat(recentList) : phoneList;
  visible.forEach((it) => allItems.set(keyOf(it), it));

  const setIconRef = (id: string) => (v: ViewHandle | null) => {
    if (v) iconRefs.set(id, v);
    else iconRefs.delete(id);
  };

  let dock: ReactElement | null = null;
  if (width != null) {
    if (end === 'desktop') {
      dock = (
        <GestureDetector gesture={pan}>
          <View
            accessibilityRole="toolbar"
            accessibilityLabel="程序坞"
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap,
              padding: pad,
              height: dockH,
              borderRadius: 18,
              borderWidth: 1,
              borderColor: pal.glassLine,
              backgroundColor: pal.glass,
              boxShadow: pal.glassShadow,
            }}
          >
            {shown.map((it) => {
              const id = keyOf(it);
              return [
                it.divider ? (
                  <View key={`${id}-divider`} style={{ width: 1, alignSelf: 'stretch', marginVertical: 4, marginHorizontal: 2, backgroundColor: pal.divider }} />
                ) : null,
                <DeskItem
                  key={id}
                  item={it}
                  size={mv(sizes, id, base)}
                  lift={mv(lifts, id, 0)}
                  press={mv(presses, id, 1)}
                  running={running.includes(id)}
                  hovered={hovered === id && labels}
                  pal={pal}
                  viewRef={setIconRef(id)}
                  onA11y={() => activate(id, base)}
                />,
              ];
            })}
          </View>
        </GestureDetector>
      );
    } else if (end === 'ipad') {
      // 悬浮圆角程序坞：左常用、竖线、右最近使用；图标太多时按宽度收小
      const n = Math.max(1, ipadList.length + recentList.length);
      const icon = Math.max(1, Math.min(touchBase, (W - 32 - 24 - 25 - (n - 1) * 12) / n));
      dock = (
        <View
          accessibilityRole="toolbar"
          accessibilityLabel="程序坞"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            marginHorizontal: 16,
            borderRadius: 28,
            borderWidth: 1,
            borderColor: pal.glassLine,
            backgroundColor: pal.glass,
            boxShadow: pal.glassShadow,
          }}
        >
          {ipadList.map((it) => (
            <TouchIcon key={keyOf(it)} item={it} size={icon} lift={mv(lifts, keyOf(it), 0)} running={running.includes(keyOf(it))} onTap={activateJS} viewRef={setIconRef(keyOf(it))} />
          ))}
          {recentList.length > 0 && <View style={{ width: 1, alignSelf: 'stretch', marginVertical: 4, backgroundColor: pal.divider }} />}
          {recentList.map((it) => (
            <TouchIcon
              key={`recent-${keyOf(it)}`}
              item={it}
              size={icon}
              lift={mv(lifts, keyOf(it), 0)}
              running={running.includes(keyOf(it))}
              onTap={activateJS}
              viewRef={setIconRef(keyOf(it))}
              enter
            />
          ))}
        </View>
      );
    } else {
      // 手机：等分的玻璃程序坞
      const n = Math.max(1, phoneList.length);
      const icon = Math.max(1, Math.min(touchBase, (W - 48) / n - 16));
      dock = (
        <View
          accessibilityRole="toolbar"
          accessibilityLabel="程序坞"
          style={{
            alignSelf: 'stretch',
            flexDirection: 'row',
            alignItems: 'center',
            marginHorizontal: 10,
            paddingVertical: 15,
            paddingHorizontal: 12,
            borderRadius: 34,
            borderWidth: 1,
            borderColor: pal.glassLine,
            backgroundColor: pal.glass,
            boxShadow: pal.glassShadow,
          }}
        >
          {phoneList.map((it) => (
            <View key={keyOf(it)} style={{ flex: 1, alignItems: 'center' }}>
              <TouchIcon item={it} size={icon} lift={mv(lifts, keyOf(it), 0)} running={running.includes(keyOf(it))} onTap={activateJS} viewRef={setIconRef(keyOf(it))} />
            </View>
          ))}
        </View>
      );
    }
  }

  return (
    <GestureHandlerRootView style={{ alignSelf: 'stretch' }}>
      {/* 不铺底色：背景跟随宿主 App */}
      <Animated.View
        ref={rootRef}
        style={{ alignSelf: 'stretch', alignItems: 'center' }}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setWidth((old) => (old === w ? old : w));
        }}
      >
        {dock}
      </Animated.View>
    </GestureHandlerRootView>
  );
}

// ---------- 图标外观 ----------

/** 160° 渐变圆角方块 + 内高光 + 投影，中间是图标（占 52%） */
function Face({ item, radius, radiusStyle }: { item: MagnifyDockItem; radius?: number; radiusStyle?: RadiusStyle }) {
  const [a, b] = item.colors ?? ['#8EE3FF', '#0A84FF'];
  const fg = item.fg ?? '#ffffff';
  const icon = item.icon;
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          borderRadius: radius,
          backgroundImage: `linear-gradient(160deg, ${a}, ${b})`,
          boxShadow: ICON_SHADOW,
          alignItems: 'center',
          justifyContent: 'center',
        },
        radiusStyle,
      ]}
    >
      {icon == null ? null : isValidElement(icon) ? (
        <View style={{ width: '52%', height: '52%', alignItems: 'center', justifyContent: 'center' }}>{icon}</View>
      ) : (
        <Image
          source={icon as ImageSourcePropType}
          fadeDuration={0}
          resizeMode="contain"
          style={{
            width: '52%',
            height: '52%',
            tintColor: fg,
            // drop-shadow(0 1px 1px rgb(0 0 0 / .15))（iOS 按图片透明度投影）
            shadowColor: '#000',
            shadowOpacity: 0.15,
            shadowRadius: 0.5,
            shadowOffset: { width: 0, height: 1 },
          }}
        />
      )}
    </Animated.View>
  );
}

/** 桌面程序坞里的一个图标：尺寸跟着弹簧走，上方浮出名称，下方运行点；手势统一由程序坞处理 */
function DeskItem({
  item,
  size,
  lift,
  press,
  running,
  hovered,
  pal,
  viewRef,
  onA11y,
}: {
  item: MagnifyDockItem;
  size: SharedValue<number>;
  lift: SharedValue<number>;
  press: SharedValue<number>;
  running: boolean;
  hovered: boolean;
  pal: Palette;
  viewRef: (v: ViewHandle | null) => void;
  onA11y: () => void;
}) {
  // 名称：进场 opacity 0→1、y 6→0、scale .9→1（0.24s [0.28,1.3,0.36,1]）；离场 opacity→0、scale .96（0.07s）
  const labelIn = useSharedValue(0);
  const labelOut = useSharedValue(1);
  // 运行点：scale / opacity 0↔1（0.25s [0.28,1.3,0.36,1]）
  const dot = useSharedValue(running ? 1 : 0);

  useEffect(() => {
    if (hovered) {
      labelOut.value = 0;
      labelIn.value = 0;
      labelIn.value = withTiming(1, { duration: 240, easing: popEase, reduceMotion: NEVER });
    } else {
      labelOut.value = withTiming(1, { duration: 70, easing: easeInOut, reduceMotion: NEVER });
    }
  }, [hovered, labelIn, labelOut]);
  useEffect(() => {
    dot.value = withTiming(running ? 1 : 0, { duration: 250, easing: popEase, reduceMotion: NEVER });
  }, [running, dot]);

  const wrapStyle = useAnimatedStyle(() => ({ width: size.value, height: size.value }));
  // 圆角 23%：随尺寸一起变
  const radiusStyle = useAnimatedStyle(() => ({ borderRadius: size.value * 0.23 }));
  const btnStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }, { scale: press.value }] }));
  const labelStyle = useAnimatedStyle(() => {
    const p = labelIn.value;
    const o = labelOut.value;
    return {
      opacity: Math.min(1, Math.max(0, p)) * (1 - o),
      transform: [{ translateY: 6 * (1 - p) }, { scale: (0.9 + 0.1 * p) * (1 - 0.04 * o) }],
    };
  });
  const dotStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, dot.value), transform: [{ scale: dot.value }] }));

  return (
    <Animated.View
      ref={viewRef}
      style={wrapStyle}
      accessible
      accessibilityRole="button"
      accessibilityLabel={running ? `${item.title}（运行中）` : `打开${item.title}`}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate') onA11y();
      }}
    >
      {/* 名称：下沿在图标上方 12px，水平居中 */}
      <View pointerEvents="none" style={{ position: 'absolute', left: -120, right: -120, bottom: '100%', marginBottom: 12, alignItems: 'center' }}>
        <Animated.View
          style={[
            {
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: 7,
              backgroundColor: pal.labelBg,
              boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
            },
            labelStyle,
          ]}
        >
          <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '500', color: pal.labelFg }}>
            {item.title}
          </Text>
        </Animated.View>
      </View>
      <Animated.View style={[{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }, btnStyle]}>
        <Face item={item} radiusStyle={radiusStyle} />
      </Animated.View>
      {/* 运行点：下沿在图标下方 7px */}
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', left: '50%', marginLeft: -2, bottom: -7, width: 4, height: 4, borderRadius: 2, backgroundColor: pal.dot }, dotStyle]}
      />
    </Animated.View>
  );
}

/** 触屏图标：按下压小、变暗，松手带弹簧回弹（和点赞按钮同一套手感）；点开时和桌面一样会跳动 */
function TouchIcon({
  item,
  size,
  lift,
  running,
  onTap,
  viewRef,
  enter = false,
}: {
  item: MagnifyDockItem;
  size: number;
  lift: SharedValue<number>;
  running: boolean;
  onTap: (id: string, size: number) => void;
  viewRef: (v: ViewHandle | null) => void;
  enter?: boolean;
}) {
  const id = keyOf(item);
  const press = useSharedValue(1);
  const dim = useSharedValue(0);
  // 最近使用新出现时：scale / opacity 0→1（0.3s [0.28,1.3,0.36,1]）
  const appear = useSharedValue(enter ? 0 : 1);
  useEffect(() => {
    if (enter) appear.value = withTiming(1, { duration: 300, easing: popEase, reduceMotion: NEVER });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(60_000)
        .shouldCancelWhenOutside(true)
        .onBegin(() => {
          'worklet';
          press.value = withTiming(0.86, PRESS_T);
          dim.value = withTiming(0.2, PRESS_T);
        })
        .onFinalize((_e, success) => {
          'worklet';
          press.value = withSpring(1, RELEASE);
          dim.value = withTiming(0, UNDIM_T);
          if (success) runOnJS(onTap)(id, size);
        }),
    [id, size, onTap, press, dim]
  );

  const wrapStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, appear.value), transform: [{ scale: appear.value }] }));
  const btnStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }, { scale: press.value }] }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  const radius = size * 0.23;

  return (
    <Animated.View ref={viewRef} style={[{ width: size, height: size }, wrapStyle]} exiting={enter ? ZoomOut.duration(160).reduceMotion(NEVER) : undefined}>
      <GestureDetector gesture={tap}>
        <Animated.View
          style={[{ width: size, height: size }, btnStyle]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={running ? `${item.title}（运行中）` : `打开${item.title}`}
          accessibilityActions={[{ name: 'activate' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'activate') onTap(id, size);
          }}
        >
          <Face item={item} radius={radius} />
          {/* brightness(0.8)：盖一层 20% 黑 */}
          <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: radius, backgroundColor: '#000' }, dimStyle]} />
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

// ---------- 默认图标蒙版（网站版 lucide 图标，viewBox 24、strokeWidth 2、圆头圆角，192×192 白色 PNG） ----------
const GLYPHS = {
  folder: { uri: 'data:image/png;base64,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' },
  compass: { uri: 'data:image/png;base64,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' },
  mail: { uri: 'data:image/png;base64,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' },
  message: { uri: 'data:image/png;base64,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' },
  photo: { uri: 'data:image/png;base64,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' },
  music: { uri: 'data:image/png;base64,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' },
  calendar: { uri: 'data:image/png;base64,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' },
  map: { uri: 'data:image/png;base64,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' },
  note: { uri: 'data:image/png;base64,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' },
  terminal: { uri: 'data:image/png;base64,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' },
  settings: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAwKADAAQAAAABAAAAwAAAAABNOznKAAAc90lEQVR4Ae2dB7gc1XXHJYPomN4EBgnRRBHNpovIyHRhIPloAgdEUXDgIwFhE0wvTiAgjO1gg4mFMQaH3nsJopdQBJJoEqBgI4QQVWALSSi/P5p9eW/frnZmz5n67vm+/9s3s/ee8z/nnpm5c+fO3V69goQIhAiECIQIhAiECIQIhAiECIQIhAiECIQIhAiECIQIhAiECIQIhAiECIQIVDUCvavqWJH8mjdv3lLw2RZsBtYF/cEyQPslM8En4C0wCbwInujdu7f2BwkRKF8ESPo1wAngSTAbJJU5VFBd6VijfBEIjHtkBEjWweBmMBd4iXTdAgb3yKAGp4sfAZJzEHgApC2ysWnxIxIY9ogIkIyLgYuB5xkfdQsU2ZLNxXtEkIOTxYwACaiz/isgL5HtQcWMTmBV6QiQeHuDz/LK/E52xWHvSgc7OFesCJBwR4KvOiVh3v+Ky5HFilJgU8kIKNFAkZK/dvCFg6CNjAsPwhIEjUzbneK3g4USVMuy6FyM7cUDtLuzNFpmW+EAiNl6JP9Aij4FvhmzSl7FPsXwNhwEr+RFoEx2wwEQo7VI/j4UexpsHqN4EYq8AImtOQhmF4FMkTl8o8jkCsTtDLiUJfkVNnEV5yAtIhCuAC0CxNl/AEUmgkVaFC3a119CaCBXgTeLRqxIfMIVoHVrnE+RsiW/vBLnf9c/QZpHIFwBmsemV3TjO4EiZY3TPLhvFG6Imzfyws2/Ct8QgVHAM/mVkI+Bu4Dm/E8FklWB3hXYE+wAvGxKzwngKBAkRCB+BDj7LwW+AF6i6cybtGKgMkDTqb1EPtRevGllPnwfIjA/AiTNcKcM/At6Ek9ToM7hwOsAPCi0a4hAogiQfDcAq3yJAj09bkuouyuQDqvc0BaBUKnnRoCMe9+addQ/2hpBdIx04DHdyiPU70ERIOEGOiTdWHS43Myi52EHPprKEaQuAuE5QF1Aos2NG+9OtPd0hh816uMhpzkoaXkD7mCjdCrCAdC4ybR0iUVeJ/nHWhR0rouuR9l+rfO+Nv63+tSGyeJXCQdA4zZav/Hu2HsfjF0yfkGrznAANIh1OAAaBIVd1v6yZmN6i1XnBt6EqqAvHAB1rcjNpub7W2d+vlSn1mNTUzIssgW+LW1RUMW64QDo3qoHsMs6RcTaX+/Oqlev1xvtTLCvD2X3S1A+FO1pEeAMuTB4FVjk/bTiBqkZFmLU1TIq1oM7Lfdy0RuuAF3D/iM2rTfAT3dV6br1jFGb7gM0wS9IFIFCnw2is9WKcF0ZLAm+AnrNT2fZ9xgenMOni2BrFxSd7aDsXgcdzVRI927Nvoy5/xx8fY7YPRCzfMti6FucQprRugpQV0sn1s+B2mkatmbxWUhxeVLp5RmB7IcuJeKOQCue6YylgDYSPWSaDDQ6ojPj3QS6rRtF7O5F/f8CSwCrrA8Pa3+9IQd4anRKb6dZRcl5IDzvaEcRPDal3u5ga7AFWBM0k7l8MQloYOARcF9a8UF3+YRgrgy0BPg4YJW3UHA2WCtOJCi3DPg58FrnR3P8UxW4jgceovVFfwZirXJBuf7gXPAOsMpEFJwEVks1WEVWjvNrgUuApgt7ixr3bnAQUPepQ9heBGwHRoOPgKcc3WEopX8ge6wnYXR9CBQLxaTLq59srwoOBvcCr5MEqjpkFv/9BqydUrhaqs28C4Sz6macDHTDuWhLhj4FPkTNR5E99VXTuPf5DL19ubyn+qsuxE9n7HeB7om8RfdU7wHdZy0HlgVZiF7gvxick3b86p3J9ACg8baDwNWgXz2RCmz/lMY7NQs/iON52DkpC1sZ23gHe4cQR90rZCKZHQA0ms7654CFMvEsWyPTMLcuDaerQOoSXQV0Y7lS6sayN6CRvrOArgZes2mbeqHhqlSFxuoDrsDIv4IqJr/ip6nPmSS/jGHrUz7O0P8VFOWkDoCryJsu9yRp+JrqFUDJD+mbwLA0yBdE533w2C2Ls1Vnf4mt2u5+MLTz/or9fw/+7E1sdY+QiqR2ANBAOpL/CPZPhXkxlOpBzyAaSF2gzIUYaxhxHKhiV6gWz5v5Zz9irOcJ7pJmF+jfYFvl5NdIyfC8kl+ZgO2pfBwCxKWqsi+OXZCWc6lcATgz/S2Eb0yLdAH06kZNyX9tAbhoBbuD4KHRtVTaswg+wkFPrt3j7R4wGkPj7Hpcr3HkKopGJn5IY1xWJOeI+w/hcwlwb9OC+Kkb/w2J+589+aTRBfolBKua/H/BN/VHC5X8Sgg4/ZoPdTnFsYqiB4A6wF3F9WzBWUgjEg+4MiyOMj193YdEe7Y4lLozoQ22Yu8tQDfIVRSNuN3r5Zj3FeAcL2IF0/N7+Gxc9ORXzOCombFa1uUqbVdQzvX0ye0KwJlnZ4hpTDwNeQel08EssDr4FnDjjq5m8jpfHE9S3dWsQJH30yZ6/nIRWDcDnnOwMQX8CWiOl4ZmB4A0ZM/CtQnBvgl4ygsoOwJ0u5SzTys3Dwe3gznAW/Ra5CFgoTRaL0ud8gH8ALwGvGU2Cm8FB4Bu71KwbyXw9+AZ4Cm3ZRnDlrbwTNNmFQwP+QAlB7c0GhWgbF9wCngDWOQTKo8BQ4F31zCuO6mVk0/ge+AKIF8tooPpZNDt5NTMAcruBzzWW0XN1yc99QTM4tKNgNBImFxmZjN/5YOhXN50GU0s8FibSjuBIWB9oO3lQb38lR26qdVw7ZPgCfAUdrW/8kKcFsPJbcC2YDswEPQFi4N6+YAdevPuNfAweIg4qauTWLArGxokkT2rHAOPX1mVuNTHsduAVd5GwSouhDopQafe+tJVYk2gt5oaHRCdavTcf4nNcqAfWAPoqu6+jhA61S2aDKxSjPsyvOgNrJdUvcE1uOemXs/ynLbeFljv3Wai4xvWyJkVQEAjDHpIYZEruZw9alEQ6pYnArS1up2/NTLWG3EbGHV8vXyFVYdWCLCIphZcaFEQ6pYyAqNhrba3iDX3XA6ABS2JEce5lzkj6GY0SA+KAG2uZywvGF3W8yCTeHSBdGdvkbGWyqFuqSNgbXtr7rmsjmAdKXir1E3Ygjw3anoiuiPYCGhodj2g1e4Ut1rs9DqloCFHnRk15DgBPMKZUk/AqypvGx2rxa9tNR7Lg1ifln7SNvuCViTpt4TacKDpIRuDVs9bVqCM0A98G9QEVfPGs3E/uIaD4bnaFxX51BRni1hzz+UKoJdDLJLV2jMWji3rkqg6G40Eh4MNW1aIV0AHziYRtHqe7pXGgN9wMOiKUXaxTpufaw2Axz3ADCOJ/sb6uVYnKZcFZ0JiCtBollfyo6qbSLdsTJFN2e5Wolw7rG1vzT2XUSBrH3VoudpsPluSTw8AR7D1BjgDWM9m8xXH+ytbsvm6OIhLvGqFK/U9IyNr7rkcAEoAi+g3edM8a1q4NawL3wF88ShQd0Q3tHmJbrDF4dGIU148EtuFrwYFrHOCrLnncgBotMIqp1kVZFWfhtsPW8+D7bOyGcOOuDwfcYtRvBBFPNpcAwT5CkFXV0BTmC2ilYeH5OvJgq3DT35qFeWiizgWuksEv52A2twiM6jscQ+74IaP8y1ErrN4EtV9j8814tjLugy8tLzj1RHPMnyIa5+s4xTHHrw0K9fjvYDr49hrVcbrCLq3laEY32sq9OMER33DwkiUSHrJXOP6ZRFxvSXiXhjO8NEzkceA7l2sco9VgVt9HNNQ4F+Bh3yMkmFu5AyK4KFuT5nO/PXxF/dCdIfgsRewTpuv+adcK9YQMISur7Fz+FT/8HSQa+Nhvwx9/lbhHm04B5irqg3BGcDa50dFh1xnJuatAGp6ycFbrkKhVzctkcvY1TusVRGNXGUuBE8v5KdxBdWrnMUTnB2bQsb8Dp2ZHgTYGwC8LtcphCSxSvmiZxeZCfb0Ev7vEzNtXeHhzJxIagjuugp4Xupq4bgkKZd2y2NQl+zHaoYr9CmfMutSYuvSFGKn3NLL/MUVCKZx1CuWh2XhNXZGyFhFZURGMTwipfj9zpu/+xkBxzU14GWwqjNZLfq6LbMgxznr7VAHd82x0Xz8NKY3zETvHeC/wYtA70F8AiTLgP5gM7AT2BMsBbxlOgrXI4Yfeyuu6SOGm/O/lpnR0iueMhVl+jGSDzyVpqKLIOwC0ugKvYjehVIhjVJ0a4alt2jBriPBEnF5q2xUx7rYF2q6yZlxeSQthyXd9I7rZtG+Q7lknTiX1B1beQj/xO53Qw3H2pg1ro2lpYF+NNpL9APgPwZtP5FV3UiH54+Jy8elG0fBthe9x4E05F9szHKqTST+M4Vo6Nfd9faUq6BzlCPXSega5EVQuoB0eskoL241PRBbEeghprdcVrNRuk8ioaGwMd4RQd/p3sFA5wQnnlrUd+UU+K2MXun2kAkp8DvDg1idjt+ynekQuHdc1K/WsOLFdY5ZN6ehYFEvsuja0kooqq+ztHvy1/yUbuB1Jdiyptf6CafFgNrEUy5CmfsgjdXXtuvjzGHAsy97aNtk6irCy2PKg3xz6/bUUezYlA2nOLpNkYCP2tZLFEe3tu0IXBH+wTGdaac4RUpDii4Cn5ccOP3YhUwMJXDVzbVVXophKlYRiNxpJRPVV25sEctoWQvhoFZq9hje04xA81g5OrRasXXIVv60PdqTtC1lC1hjKJ/N05LRoR8r8ZgJ/Bp6VksaC2v5zG8weJDxLqT3ANY1YXQPoHV3rLIjCqx9zfPxa7aVSNz6ka3z45ZvUk4+y3erqA2s92N6IKifPdLDrkwl8wNA3uGoXmY+ycHT7zjosL6Aoye81zjwSKpCNmXbIlbfZdujDU4iJyZZHGm3bi4HQET2cj7fbJd4VM+8OjB61jdyuIPG+8KoI3H1yOadiSt2rWD1XdqsbTAZHcqFXCS3A4AGnIvHVsc9Rl3WM0b+IWN9S3Wrbavv4m5tg8vJha8sQbDUze0AiEhbz2AeE+5WtASQuuOM9S3VNanOIlbfZdvaBtYcsPjvsi6QhcBEKs8yKFiYkYMlDfVV1TovRrM68xKrbZPvUewtCyyr7V/JK3iym+sVIOoGzTAGYFljfVMSYLs2pdlIo63qVttW362x/yDKgbac96iU6wHg4QA65jnpCWqSR8Aae+vwc3LGdTVyPQC4hGpuv3Vmp/Us+FldTJJu6mWWvMRq2+q7NfYrRDmQV/zy7QLhtRbFtTxEmcMl9HNj9KxJ0N9o31J9bUtl6pp8j2I/x8BBba8cyE1yvQLg9Z5Gz6ca66u69RU76zi4xQWrbavv4v6exQHqDjPWN1XP7QDg0ifbR5nY9+rlMaFL7wBbZCdLZWNdq22r76JvbYOj8uwG5XYAELiRYG1F0CDW4Mv0awb7qjqMBoz9vq/RVkf1yKb1Cmr1XXyszyLUhVQu5CK5HAA03rp4a53MpYA94xC1CUYdmpGqxWizFtmUbYtYfZft/7EQiOqeR054PJV2oJKyChzVdGj9tI9V9OKENQH0xlqYDm1oc+K3JPB40UnTu1c3UGmraqZXABz8NiyfAroCWOVBRiGssyE1M3U6RMYbyaxD/eONOpJUly3ZtMj4yHeLDsVPo3APmpTMryx/noxyxEFdPBWZHQA4NgJK+l2tb8Wj1rLU9S1LxC9wf/yiTUuehY/WiWFNlde+iGycVds2fHr4XDPv1RbKDS3heHhNcek/cSaNl+L1azKW5wdd4oqu8FJ8l4gk21BbALWJp/wCZb2TMSlYaRwIy6I4tQmxLPqyKKd5Zn+k60o+U1sJ0KlpmquB/OUpBCUsjGUP6qjmrdbeN1DStIYP7dS6aRjTHqOca+HGyd1c8dlxbBquQS0sjWgMLDE8xqeJu2k5zUgt2+rQ3xlYV1roFgV2hMVxG0Ul2b4z08oGaGhxXK/V6zp7pVzaPQ3e7jcZENVbRnpCu5oz4aosj67XGMcBvcxSm02pWZ39wWbgu2AYMD/jQEe9aMg37eXRNRKmoe7F640bt6dRX8ujv2/Uk251DoC0fiBjRLrM52uH/whQVckqhoemFMCrs8iBtm3gdFo/kfSrtkklrIgPGrbVWHTVRD71ThiOtotj6z9SCuAObZNKuyIOj03BaQ2FZfbATjHCXviRPGOyEEOdSMYAb3ncSC2d6ni5nben6LsKZJr8tehgd78U/MlL5X41v7L8VNsBncC8ZXCWfsSyhYfeP5StByuZXbIbOYl9j1WjvRs/qb4LG/mW1T61ITgVzE1KfAHlb8qKfyw7EF0OeCyQKp/1KyN7xjKcciF4qPGuBmUVcc/1JFJrInjsAfQQ00NmoWT5mu7cPyFzpIdX6JgCNsrdoU4E4NMHeC3/jarMRJz7dHIl93/hMxC87RQBl5dovPrXuzlEV+O7OzDO6/GShgOd+SrgM5v/9gHXuClNX5G47hNxT99aTAvw0SJY2wPre8Sy6JFz0mMTjmbd6MwwHtV60jfExiTd2vBTd6gM9wTiWIhuT7MWgd9gYL0n0LwjrxN4M6qt90NiXWCVP7a2VIwSOKrRoU+sDqdQX5xyGe1pp2Xg+geHGOT/GiVO7OPgyIbtBDGvOvir5wRFelgmLgPyikc7duG7PrDKvu3Y7lzH4xJiPQon0jfUIrmlEfhOhqzGog8Hml+Tl8i2OAyOOOXFI7Fd+GpFCuurqNbcc1kZbqXE3net8EDXzXJs0YDzwBWwVSOcBT7KkLlsyaYmtl0hLhna9jT1oFGZJl6axOMKsIKJwfxZkUYV+VUn+T4GZ8JgLXAiSPNqJt2ysZZsyjb/l1k0I9Yi1tzrZVnbvUbcehCVvRG/jgPJqHU2Rwt0bLfkU+v27Aw2Bu2OyujMrm6CXmC/BhvP8Vklsba9NfdcDoC5xhb5prF+4apHifp1snIwqIu4I9ADvvWBuky6dGttfkGig0f4AGi5QvWP9TzkEXTleY8BhVTF2vbW3HM5ANRwFulnqVz0ulEC3whPIUjXCPTvupl4y5p7LjfB7yam3bXC33TdDFs9KALWtrfmnssB8I6xwTanm6CuQZAeFIGozTc3umzNPZcD4EWjE7pBHGXUEaqXLwJq83YHB2reWnOvpqf9T45kzQWaCSwyh8rbtc8i1CxTBNTWQG1uEeVc/qNA3ORpItsjNIBl2Qqt/qW5Idugz/Wtf3RqxQWtsKAhX0ErMczAjoYYg0QRIE46G68AFC/97JFGWGYSJ+tQJWr+X7CzMlt/AGpzi4yFm/kHtj2eA8iJO4DlAJAOjQiMJUBDcaytmxvqSsdQoJurDcAAsByoly8pKxuvgiciPIndL+oLVnEb37VkybZAV11hIOgLFgFdhLI6AN4EitXD4CHiNJnPxIKu1amkJ/9qJ6vcaVXgVl+OAeslDRVfy3T+HhCXHGX7glOA1pe3yGdU1pIuuwLr2Sku/czKySewC7gSfAosMonKpwIldCyh7IFAbeshyrXYtmMRtBaC0G0ennXS8Sz/HwZ0yewi7FsSHARuB14HHqo6RA08AnhdIbvwz3IDH5T4hwLrCQIV3USxvwMMB7WHeh3usW9VcDh4DnjKrR1GjP+o3+cieKcu0F0uyroreYtdeiI6C6wB1gRZnKV16T+BS75bwNGXmdAm38fYaLBOBkZ1T/UO+BPQ0vV6Aq52SkP2oE3u9lDsdgCIDAF/ho/veBArmA69sHMcQddUhcIL7aAXxn8BDi482eQEn6UdtkperXEN7wNgF8zc29hU6fdOw4N9Cf6TRfaE5N8afreAVYvM08BtV9rgPkP9LlXN46idtUXEFPwqyio49RAJdmBRnYPb/nB7GFQ1+W/xTH61o+sVQAppBA2nTQQaT66qqDv0yyI5R9yPgY84ubdpQfzU85sNifu7nnxcrwAiFhEc6UmygLp+TsL9oCi84DIcLlVOfoV6pHfyS6n7ASClEL2Oj4v0f0VFZ1kt/KqRr1wFDrrvuhJU9cyv+I6Ockr/u0pqQaNhNEx5Lfg7V8bFUjYDOpvSOH/OgxYxXg27+jESvWBTVdF7FAcQY/PLL40ClMoVQIYiwro0u4zXNiJfgH0rwEFzmFKLYzMfI5tX8X2Vk1+5Mzyt5FdsU204iH+JjX2AGqqqMgTHdAOatRyNwaFZG83QnnJm7yiHUjObWheonjFnrNPYdwZYqP67CmyrK7QOjaWJY6kLsdS7tJOAnrZWTdTVOZNYnpuFY6leATo7gEPnsD0E/G/n/RX5X12hUzL05SfYqmLyT8GvIVklv9orsyuAjEk4ey3Jx6ngBLAIyEJ0htZiUrKnh0Rp2P0CvaunfRWIzv666dY7Dt4yG4XvAnVdNY08q/sL2RsNfkr8Puez+kJD9geXAq8f1kBVh2jl4buBZoyu3DmabGu9/63A+eAD4CnHdbaVxv+QPcaTMLpmgAvA1qBPZ85srwgOAHcB62rOqOgmavtfg36d7fao/3FeU2Z/BMYDq0xBwTlgrThBpNzSQI3v1bivxLFrKQNXjzih5muftYjX0nH4UG5NcDZ4C1jlJRScCDS9JFfJvAu0IG8JiKbt7gJ2BIPAemBBN81v8/3z4GlwN5fPl/lMLNjVjy1cDzy6FZvAY3xiEjEqwHMgxTTNxCozUaCx9bvaUQQPrea9B9gKbAHWBs1ySd2q14GeV4wF92NX08wLIc1IF4IcgVZfXV0YQfcOXwEF9H0wlUDq/QAXwdZ3UXQPkE2LnAgv9WfdBY7/hNKLjYoVv93h+KBRT0d1eKnrpLO5oP81uKK+vNppOrbm8Bmk6BGgIUcBq6Q2HRxi6otb5aSit0OW/Ap9BcgyELJFZqm7NQ5spO02RatFawTFXeCnF3I05NquvEpFddHCGTmKoC5VQaIIkBh6CHOBMSDLkqjuY/ToXB5eluSXWxeG5O/auuEA6BoPbd0ANC5tkTSWerTq1Fn/OotTVawbDoC6VuUMqZu35+p2J93cMGmFGOWtOp/Dt89i2OlRRcIB0Li51Ve2yOaWyk3qWnVafWpCq9y7wwHQuP3eaLw79t6hsUvGL7hT/KINS1p9aqi07DvDAdC4Ba3Jot9OHtJYdfK96NqBWnoIZpFJlspVrRsOgMYt29YT5TpVmjbgNcx8dp3udjY9fGrHbqhTxgiQvNOAVf7R6jsERlpJUH868DoYrS6F+mWIAAlzrUPizUbHHu36S93dgFaytsqN7XKoer3QBWrewjc1/yr2NwtT8kayd2TsGlFB6hzBvzeDLlOUk+qJynv40qbpUK2UESABlwAzgZdo9exNWwWDMoPArV5G0fMF8Jjl2op6Kb8P/cIFNBuJcylf/8MCiiT9SisoPwE0DflFMBVIVgWbAXWXtgee7TKGB2C6mgRpEAHPQDdQX+5dHACafvAKKGucdMBtzAEwsdwtkR77cA+wgNiSOK/xtV6UKavcHJJ/wU1X1jPbgr1y/JarQD/UaRrBoo5qs1ClCX1aTHZyFsbKaiNcAVq0HAn0NkXOa1GsiF9r6nNI/hYtE64ALQKkr7kKaDjzKbCltksgusHeigNgdgm45koxHAAxw89BsB5FnwHLxKySV7FPMazfW9bNe5AWEQhdoBYBqn1NQmllg/2B3horqojbQSH5i9o8FeDFleAw4LWOEKrc5Cs0HVmBEAcXih4BEq1oB4EOyJD8RU+cKvEj4YYB6y+uo8Is+oX771cptsGXkkSAxNsITDCncPsKJlJ1k5KEK9CsYgRIwMWA1ticA7ISdXl+BharYkyDTyWMAMm4MbgXpC33Y2BQCUMUKPeECJCc2wO9A+A5UiRdNwG9GxwkRKD4ESBZ+4J/Bo8DvRmWVFRHdY8Hqxff43IyDE+CM2g3ElgrW28DtLbPOqA/0BPl2osqWq78E/AW0OoNmsrwJA+0esavpeBskBCBEIEQgRCBEIEQgRCBEIEQgRCBEIEQgRCBEIEQgRCBEIEQgRCBEIEQgRCBEAHvCPwfn1PtdEFwp08AAAAASUVORK5CYII=' },
};
