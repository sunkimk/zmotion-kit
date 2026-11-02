// 底部标签栏（React Native 版）：点一下标签，指示器沿着标签栏弹性滑过去；图标按下时一缩、松手后带着初速度往上一跳；
// 连点、来回点都能随时接住。指示器有胶囊 / 下划线 / 圆点三种，切换样式时也平滑过渡；未读角标弹出、收起。
//
// 多端（按组件自己的宽度，onLayout 量，和网页断点一致）：< 600 手机底部悬浮栏；600–899 iPad 底部居中的悬浮栏（图标和文字横排）；
// ≥ 900 桌面左侧侧边栏（220，顶部应用名，图标和文字横排；关掉文字时收成 76 的图标栏）。
//
// 原生端说明：
// - 网页演示里的假状态栏、示例页面内容不属于标签栏，不画；标签由宿主传（tabs：标题 + 图标 + 角标），
//   选中项受控用 selectedIndex + onSelect（不传 selectedIndex 就组件自己管），每次点按都回调 onSelect。
// - 只要栏：不传 renderPage，组件绝对定位铺满父容器（box-none，只有栏本身接触摸）；桌面侧栏时宿主自己给内容让出 sidebarWidth。
// - 要连页面切换动画一起：传 renderPage(index, { form, bottomInset })，组件负责摆页面、按切换方向左右（桌面上下）滑入滑出、给栏让位。
//
// 动画：指示器是栏里的一块绝对定位色块，量出每个标签的位置后用 withSpring（stiffness, damping = 1.24√k, mass 1）滑过去；
// 图标的松手回弹 / 选中弹跳要「从当前值带指定初速度」起步，Reanimated 的 withSpring 会把背离目标的初速度清零，
// 这里用一个和 motion 一致的物理弹簧（解析解）。默认图标是 lucide 同款路径预先栅格化的白色蒙版 PNG，用 tintColor 上色。
// RN 没有背景模糊（不引 expo-blur），悬浮栏底色比网页更实一些。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, StyleSheet, Text, View, useColorScheme, type ImageSourcePropType, type LayoutChangeEvent, type LayoutRectangle } from "react-native";
import Animated, {
  Easing,
  defineAnimation,
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type AnimationObject,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  type LayoutAnimation,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

export type TabBarForm = "phone" | "ipad" | "desktop";

export type TabBarItem = {
  /** 稳定的 key，默认用 title */
  key?: string;
  title: string;
  /** 白色蒙版 PNG 图标（tintColor 上色）；activeIconSource 是选中时的（比如更粗的描边），不传同 iconSource */
  iconSource?: ImageSourcePropType;
  activeIconSource?: ImageSourcePropType;
  /** 自定义图标节点 / 渲染函数（优先于 iconSource） */
  icon?: ReactNode | ((p: { color: string; size: number; active: boolean }) => ReactNode);
  /** 角标数字，0 / 不传不显示 */
  badge?: number;
};

export type TabBarProps = {
  /** 选中标签的标记样式，切换样式时也会平滑过渡 */
  indicator?: "pill" | "underline" | "dot";
  /** 选中标签和指示器的颜色 */
  color?: string;
  /** 图标下方（iPad / 桌面为右侧）是否显示标签文字 */
  showLabels?: boolean;
  /** 指示器滑动和图标弹跳的力度，越大越快、越利落（120–900） */
  stiffness?: number;
  /** 标签，默认网页的四个（首页 / 发现 / 消息 / 我的） */
  tabs?: TabBarItem[];
  /** 受控：选中下标；不传则组件内部自己管理 */
  selectedIndex?: number;
  /** 每次点按标签（包括再点一次当前标签）回调下标 */
  onSelect?: (index: number) => void;
  /** 桌面侧边栏顶部的应用名，null 不显示 */
  brand?: { title: string; mark: string } | null;
  /** 传了就连页面一起管：按下标返回页面；bottomInset 是页面底部要给悬浮栏让出的高度 */
  renderPage?: (index: number, info: { form: TabBarForm; bottomInset: number }) => ReactNode;
};

/** 桌面侧边栏的宽度（只用栏、自己摆内容时，给内容让出这么宽） */
export const sidebarWidth = (showLabels: boolean) => (showLabels ? 220 : 76);

const formOf = (w: number): TabBarForm => (w >= 900 ? "desktop" : w >= 600 ? "ipad" : "phone");

/* ---------- 颜色（style.css 浅色 / 深色） ---------- */
const PALETTE = {
  light: {
    card: "#ffffff",
    fg: "#111111",
    muted: "#8e8e93",
    line: "rgba(0,0,0,0.06)",
    bar: "rgba(255,255,255,0.94)",
    barEdge: "rgba(0,0,0,0.06)",
  },
  dark: {
    card: "#1c1c1e",
    fg: "#f5f5f7",
    muted: "#7c7c82",
    line: "rgba(255,255,255,0.07)",
    bar: "rgba(36,36,40,0.94)",
    barEdge: "rgba(255,255,255,0.08)",
  },
} as const;

function rgbOf(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** color-mix(in srgb, a (1-t), b t) */
function mix(a: string, b: string, t: number) {
  const [r1, g1, b1] = rgbOf(a);
  const [r2, g2, b2] = rgbOf(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${f(r1, r2)},${f(g1, g2)},${f(b1, b2)})`;
}
function withAlpha(hex: string, a: number) {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---------- 和 motion 一致的物理弹簧：显式初速度、不裁剪方向 ---------- */
interface PhysSpring extends AnimationObject<number> {
  from: number;
  v0: number;
  velocity: number;
  begin: number;
}

function physSpring(toValue: number, k: number, c: number, v0: number): number {
  "worklet";
  return defineAnimation<PhysSpring>(toValue, () => {
    "worklet";
    const onStart = (a: PhysSpring, value: number, now: number) => {
      a.from = value;
      a.current = value;
      a.begin = now;
      a.v0 = v0;
      a.velocity = v0;
    };
    const onFrame = (a: PhysSpring, now: number): boolean => {
      const t = (now - a.begin) / 1000;
      const zeta = c / (2 * Math.sqrt(k));
      const w0 = Math.sqrt(k);
      const delta = toValue - a.from;
      let e: number;
      let de: number;
      if (zeta < 1) {
        const al = zeta * w0;
        const wd = w0 * Math.sqrt(1 - zeta * zeta);
        const A = (-a.v0 + al * delta) / wd;
        const env = Math.exp(-al * t);
        const s = Math.sin(wd * t);
        const co = Math.cos(wd * t);
        e = env * (delta * co + A * s);
        de = env * ((-al * delta + A * wd) * co + (-al * A - delta * wd) * s);
      } else if (zeta === 1) {
        const B = -a.v0 + w0 * delta;
        const env = Math.exp(-w0 * t);
        e = env * (delta + B * t);
        de = env * (B - w0 * (delta + B * t));
      } else {
        const wd = w0 * Math.sqrt(zeta * zeta - 1);
        const slow = zeta * w0 - wd;
        const fast = zeta * w0 + wd;
        const C1 = (fast * delta - a.v0) / (fast - slow);
        const C2 = delta - C1;
        e = C1 * Math.exp(-slow * t) + C2 * Math.exp(-fast * t);
        de = -slow * C1 * Math.exp(-slow * t) - fast * C2 * Math.exp(-fast * t);
      }
      const x = toValue - e;
      const v = -de;
      // motion 的静止判定：变化量 < 5 时用细粒度阈值
      const granular = Math.abs(delta) < 5;
      const done = t > 0.02 && Math.abs(v) <= (granular ? 0.01 : 2) && Math.abs(toValue - x) <= (granular ? 0.005 : 0.5);
      a.current = done ? toValue : x;
      a.velocity = done ? 0 : v;
      return done;
    };
    return {
      onStart,
      onFrame,
      toValue,
      current: toValue,
      from: toValue,
      v0: 0,
      velocity: 0,
      begin: 0,
      reduceMotion: false,
    } as unknown as PhysSpring;
  }) as unknown as number;
}

const PRESS_EASE = Easing.bezier(0.33, 0.55, 0.2, 1);
const COLOR_EASE = Easing.bezier(0.25, 0.1, 0.25, 1);
const SIDE_EASE = Easing.bezier(0.33, 0.55, 0.2, 1);
const PAGE_SPRING = { stiffness: 380, damping: 38, mass: 1 };
const LABEL_SPRING = { stiffness: 420, damping: 36, mass: 1 };
const BADGE_SPRING = { stiffness: 560, damping: 22, mass: 1 };

export function TabBar({
  indicator = "pill",
  color = "#5B5BF6",
  showLabels = true,
  stiffness = 420,
  tabs,
  selectedIndex,
  onSelect,
  brand = { title: "狐狸日常", mark: "狐" },
  renderPage,
}: TabBarProps) {
  const dark = useColorScheme() === "dark";
  const pal = dark ? PALETTE.dark : PALETTE.light;
  const reduce = useReducedMotion();
  const items = tabs ?? DEFAULT_TABS;

  const [width, setWidth] = useState(390);
  const form = formOf(width);
  const vertical = form === "desktop";

  const controlled = selectedIndex !== undefined;
  const [inner, setInner] = useState(0);
  const raw = controlled ? selectedIndex : inner;
  const active = items.length ? Math.min(Math.max(0, raw), items.length - 1) : 0;

  // 页面切换方向：离场 / 进场动画在 UI 线程读这两个共享值，所以离场的页面也能拿到新方向。
  // 故意在渲染时写：离场动画在这次提交时就要读到新方向，等 effect 就晚了（宿主改 selectedIndex 时同样生效）
  const dirSV = useSharedValue(1);
  const vertSV = useSharedValue(vertical ? 1 : 0);
  const lastActive = useRef(active);
  if (lastActive.current !== active) {
    dirSV.value = active > lastActive.current ? 1 : -1;
    lastActive.current = active;
  }
  useEffect(() => {
    vertSV.value = vertical ? 1 : 0;
  }, [vertical, vertSV]);

  const select = (i: number) => {
    onSelect?.(i);
    if (i === active) return;
    if (!controlled) setInner(i);
  };

  const activeColor = dark ? mix(color, "#ffffff", 0.28) : color;
  const side = sidebarWidth(showLabels);

  // 桌面侧边栏宽度：0.4s cubic-bezier(0.33, 0.55, 0.2, 1)
  const sideW = useSharedValue(side);
  useEffect(() => {
    sideW.value = withTiming(side, { duration: 400, easing: SIDE_EASE });
  }, [side, sideW]);

  /* ---------- 指示器：量出每个标签的位置，色块弹簧滑过去 ---------- */
  const [layouts, setLayouts] = useState<(LayoutRectangle | undefined)[]>([]);
  const onTabLayout = (i: number, l: LayoutRectangle) =>
    setLayouts((prev) => {
      const p = prev[i];
      if (p && p.x === l.x && p.y === l.y && p.width === l.width && p.height === l.height) return prev;
      const next = prev.slice();
      next[i] = l;
      return next;
    });

  const ix = useSharedValue(0);
  const iy = useSharedValue(0);
  const iw = useSharedValue(0);
  const ih = useSharedValue(0);
  const ir = useSharedValue(0);
  const placed = useRef(false);
  const L = layouts[active];
  const target = L ? indicatorRect(L, indicator, form) : null;

  useEffect(() => {
    if (!target) return;
    if (!placed.current) {
      placed.current = true;
      ix.value = target.x;
      iy.value = target.y;
      iw.value = target.w;
      ih.value = target.h;
      ir.value = target.r;
      return;
    }
    // 指示器：阻尼比约 0.62，到位时轻轻过冲一点再停
    const sp = { stiffness, damping: 1.24 * Math.sqrt(stiffness), mass: 1 };
    ix.value = withSpring(target.x, sp);
    iy.value = withSpring(target.y, sp);
    iw.value = withSpring(target.w, sp);
    ih.value = withSpring(target.h, sp);
    ir.value = withSpring(target.r, sp);
  }, [target?.x, target?.y, target?.w, target?.h, target?.r, stiffness, ix, iy, iw, ih, ir]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: ix.value }, { translateY: iy.value }],
    width: Math.max(0, iw.value),
    height: Math.max(0, ih.value),
    borderRadius: Math.max(0, ir.value),
  }));
  const indicatorColor = indicator === "pill" ? withAlpha(color, dark ? 0.26 : 0.14) : color;

  /* ---------- 标签栏 ---------- */
  const tabsNode = (
    <View style={vertical ? styles.colTabs : styles.rowTabs} accessibilityRole="tablist" accessibilityLabel="主导航">
      <Animated.View pointerEvents="none" style={[styles.indicator, { backgroundColor: indicatorColor, opacity: target ? 1 : 0 }, indicatorStyle]} />
      {items.map((t, i) => (
        <TabButton
          key={t.key ?? t.title}
          item={t}
          index={i}
          on={i === active}
          form={form}
          showLabel={showLabels}
          lineKind={indicator !== "pill"}
          activeColor={activeColor}
          muted={pal.muted}
          card={pal.card}
          stiffness={stiffness}
          reduce={reduce}
          onSelect={select}
          onLayout={onTabLayout}
        />
      ))}
    </View>
  );

  const sideStyle = useAnimatedStyle(() => ({ width: sideW.value }));
  const pagesStyle = useAnimatedStyle(() => ({ left: vertSV.value ? sideW.value : 0 }));

  let bar: ReactNode;
  if (form === "desktop") {
    bar = (
      <Animated.View style={[styles.sidebar, { backgroundColor: pal.card, borderRightColor: pal.line }, sideStyle]}>
        {brand ? <Brand brand={brand} color={color} fg={pal.fg} show={showLabels} /> : null}
        {tabsNode}
      </Animated.View>
    );
  } else {
    const pad = form === "ipad";
    bar = (
      <View
        style={[
          styles.bar,
          pad ? { left: (width - 480) / 2, width: 480, bottom: 22 } : { left: 14, right: 14, bottom: 18 },
          { backgroundColor: pal.bar, boxShadow: `inset 0 0 0 0.5px ${pal.barEdge}, 0 10px 30px rgba(0,0,0,0.12)` },
        ]}
      >
        {tabsNode}
      </View>
    );
  }

  /* ---------- 页面容器（可选） ---------- */
  let pages: ReactNode = null;
  if (renderPage) {
    const tabH = form === "phone" ? (showLabels ? 56 : 48) : showLabels ? 50 : 48;
    const bottomInset = form === "desktop" ? 0 : tabH + 12 + (form === "ipad" ? 22 : 18) + 8;
    pages = (
      <Animated.View style={[styles.pages, pagesStyle]}>
        <Page key={active} dirSV={dirSV} vertSV={vertSV} reduce={reduce}>
          {renderPage(active, { form, bottomInset })}
        </Page>
      </Animated.View>
    );
  }

  return (
    <View
      pointerEvents="box-none"
      style={renderPage ? styles.container : StyleSheet.absoluteFill}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
    >
      {pages}
      {bar}
    </View>
  );
}

/** 指示器在标签容器里的目标位置（与 style.css 一致） */
function indicatorRect(L: LayoutRectangle, kind: string, form: TabBarForm) {
  const desktop = form === "desktop";
  const cx = L.x + L.width / 2;
  const cy = L.y + L.height / 2;
  if (kind === "underline")
    return desktop
      ? { x: L.x - 12, y: cy - 10, w: 3, h: 20, r: 2 } // 侧栏：贴着栏左边的竖条
      : { x: cx - 11, y: L.y + L.height - 4 - 3, w: 22, h: 3, r: 2 };
  if (kind === "dot")
    return desktop
      ? { x: L.x + 3, y: cy - 3, w: 6, h: 6, r: 3 } // 侧栏：挪到图标左侧
      : { x: cx - 3, y: L.y + L.height - 4 - 6, w: 6, h: 6, r: 3 };
  // 胶囊：横栏左右各缩 4、圆角 22；侧栏铺满整格、圆角 12
  return desktop ? { x: L.x, y: L.y, w: L.width, h: L.height, r: 12 } : { x: L.x + 4, y: L.y, w: L.width - 8, h: L.height, r: 22 };
}

/* ---------- 页面：进场 x/y 从 ±44 用 spring 380 / 38 归位、透明度 0.2s；离场往反方向 44、透明度 0.12s 先淡掉 ---------- */
function Page({ dirSV, vertSV, reduce, children }: { dirSV: SharedValue<number>; vertSV: SharedValue<number>; reduce: boolean; children: ReactNode }) {
  const first = useRef(true);
  useEffect(() => {
    first.current = false;
  }, []);
  const k = reduce ? 0 : 44;
  const entering = (_v: EntryAnimationsValues): LayoutAnimation => {
    "worklet";
    const d = dirSV.value * k;
    const v = vertSV.value === 1;
    return {
      initialValues: { opacity: 0, transform: [{ translateX: v ? 0 : d }, { translateY: v ? d : 0 }] },
      animations: {
        opacity: withTiming(1, { duration: 200, easing: PRESS_EASE }),
        transform: [{ translateX: withSpring(0, PAGE_SPRING) }, { translateY: withSpring(0, PAGE_SPRING) }],
      },
    };
  };
  const exiting = (_v: ExitAnimationsValues): LayoutAnimation => {
    "worklet";
    const d = -dirSV.value * k;
    const v = vertSV.value === 1;
    return {
      initialValues: { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }] },
      animations: {
        opacity: withTiming(0, { duration: 120 }),
        transform: [{ translateX: withSpring(v ? 0 : d, PAGE_SPRING) }, { translateY: withSpring(v ? d : 0, PAGE_SPRING) }],
      },
    };
  };
  return (
    <Animated.View entering={first.current ? undefined : entering} exiting={exiting} style={StyleSheet.absoluteFill}>
      {children}
    </Animated.View>
  );
}

/* ---------- 桌面侧栏顶部的应用名 ---------- */
function Brand({ brand, color, fg, show }: { brand: { title: string; mark: string }; color: string; fg: string; show: boolean }) {
  const o = useSharedValue(show ? 1 : 0);
  useEffect(() => {
    o.value = withTiming(show ? 1 : 0, { duration: 200, easing: COLOR_EASE });
  }, [show, o]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <View style={styles.brand} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={[styles.brandMark, { backgroundImage: `linear-gradient(140deg, ${color}, ${mix(color, "#ff9a62", 0.45)})` }]}>
        <Text style={styles.brandMarkText}>{brand.mark}</Text>
      </View>
      <Animated.Text numberOfLines={1} style={[styles.brandTitle, { color: fg }, st]}>
        {brand.title}
      </Animated.Text>
    </View>
  );
}

/* ---------- 单个标签：按下 90ms 缩到 0.86，松手从当前状态带初速度弹回；选中时图标往上一跳 ---------- */
function TabButton({
  item,
  index,
  on,
  form,
  showLabel,
  lineKind,
  activeColor,
  muted,
  card,
  stiffness,
  reduce,
  onSelect,
  onLayout,
}: {
  item: TabBarItem;
  index: number;
  on: boolean;
  form: TabBarForm;
  showLabel: boolean;
  lineKind: boolean;
  activeColor: string;
  muted: string;
  card: string;
  stiffness: number;
  reduce: boolean;
  onSelect: (i: number) => void;
  onLayout: (i: number, l: LayoutRectangle) => void;
}) {
  const scale = useSharedValue(1);
  const y = useSharedValue(0);
  const lit = useSharedValue(on ? 1 : 0);
  const lp = useSharedValue(showLabel ? 1 : 0);
  const [labelW, setLabelW] = useState(0);
  const k = stiffness * 1.2;
  const c = 0.85 * Math.sqrt(k);

  useEffect(() => {
    lit.value = withTiming(on ? 1 : 0, { duration: 200, easing: COLOR_EASE });
  }, [on, lit]);
  useEffect(() => {
    lp.value = withSpring(showLabel ? 1 : 0, LABEL_SPRING);
  }, [showLabel, lp]);

  const tap = Gesture.Tap()
    .maxDuration(60000)
    .shouldCancelWhenOutside(true)
    .onBegin(() => {
      "worklet";
      scale.value = withTiming(0.86, { duration: 90, easing: PRESS_EASE });
    })
    .onEnd((_e, success) => {
      "worklet";
      if (!success) return;
      // 选中时图标往上一跳：给一个向上的初速度，交给弹簧收回
      if (!reduce) y.value = physSpring(0, k, c, -240);
      runOnJS(onSelect)(index);
    })
    .onFinalize(() => {
      "worklet";
      // 松手 / 滑出 / 被打断：从当前缩放弹回，缩得够深才给初速度 3
      scale.value = physSpring(1, k, c, scale.value < 0.95 ? 3 : 0);
    });

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }, { scale: scale.value }] }));
  const tintStyle = useAnimatedStyle(() => ({ tintColor: interpolateColor(lit.value, [0, 1], [muted, activeColor]) }));
  const textStyle = useAnimatedStyle(() => ({ color: interpolateColor(lit.value, [0, 1], [muted, activeColor]) }));

  const phone = form === "phone";
  const desktop = form === "desktop";
  const size = desktop ? 20 : 23;
  const gap = phone ? 2 : desktop ? 12 : 8;
  const fontSize = phone ? 11 : desktop ? 14 : 13;
  const lineHeight = phone ? 14 : desktop ? 20 : 18;
  // 文字收起 / 展开：图标在上时收高度，横排时收宽度
  const labelStyle = useAnimatedStyle(() =>
    phone
      ? { height: lineHeight * lp.value, marginTop: gap * lp.value, opacity: Math.min(1, Math.max(0, lp.value)) }
      : { width: labelW * Math.max(0, lp.value), marginLeft: gap * lp.value, opacity: Math.min(1, Math.max(0, lp.value)) },
  );

  let icon: ReactNode = null;
  if (typeof item.icon === "function") icon = item.icon({ color: on ? activeColor : muted, size, active: on });
  else if (item.icon != null) icon = item.icon;
  else if (item.iconSource) {
    const src = on ? (item.activeIconSource ?? item.iconSource) : item.iconSource;
    icon = <Animated.Image source={src} style={[{ width: size, height: size }, tintStyle]} />;
  }

  const minHeight = phone ? (showLabel ? 56 : 48) : desktop ? 44 : showLabel ? 50 : 48;
  const badge = item.badge ?? 0;

  return (
    <GestureDetector gesture={tap}>
      <View
        accessible
        accessibilityRole="tab"
        accessibilityLabel={badge > 0 ? `${item.title}，${badge} 条未读` : item.title}
        accessibilityState={{ selected: on }}
        onAccessibilityTap={() => onSelect(index)}
        onLayout={(e) => onLayout(index, e.nativeEvent.layout)}
        style={[
          styles.tab,
          phone ? styles.tabPhone : styles.tabRow,
          { minHeight },
          phone && { paddingBottom: lineKind ? 12 : 6 },
          form === "ipad" && { paddingHorizontal: 6, paddingBottom: lineKind ? 12 : 0 },
          desktop && (showLabel ? styles.tabDesktop : styles.tabDesktopCompact),
        ]}
      >
        <Animated.View style={[styles.icon, { width: size, height: size }, iconStyle]}>
          {icon}
          <Badge count={badge} card={card} right={form === "ipad" ? -7 : -9} />
        </Animated.View>
        <Animated.View style={[styles.labelBox, labelStyle]}>
          <Animated.Text numberOfLines={1} style={[styles.label, { fontSize, lineHeight }, textStyle]}>
            {item.title}
          </Animated.Text>
        </Animated.View>
        {/* 量文字的自然宽度（横排时文字收宽度要用） */}
        {!phone && (
          <Text
            style={[styles.label, styles.measure, { fontSize, lineHeight }]}
            onLayout={(e) => setLabelW(Math.ceil(e.nativeEvent.layout.width))}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {item.title}
          </Text>
        )}
      </View>
    </GestureDetector>
  );
}

/* ---------- 角标：出现 / 收起弹簧 560 / 22；收起时保留最后的数字 ---------- */
function Badge({ count, card, right }: { count: number; card: string; right: number }) {
  const s = useSharedValue(count > 0 ? 1 : 0);
  const last = useRef(count);
  if (count > 0) last.current = count;
  useEffect(() => {
    s.value = withSpring(count > 0 ? 1 : 0, BADGE_SPRING);
  }, [count, s]);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: Math.max(0, s.value) }] }));
  return (
    <Animated.View pointerEvents="none" style={[styles.badge, { right, boxShadow: `0 0 0 2px ${card}` }, st]}>
      <Text style={styles.badgeText}>{last.current}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: "hidden",
  },
  pages: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
  },
  bar: {
    position: "absolute",
    padding: 6,
    borderRadius: 28,
  },
  sidebar: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    paddingTop: 80,
    paddingHorizontal: 12,
    paddingBottom: 16,
    borderRightWidth: 1,
    overflow: "hidden",
  },
  rowTabs: {
    flexDirection: "row",
  },
  colTabs: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 4,
  },
  indicator: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  tab: {
    alignItems: "center",
    justifyContent: "center",
  },
  tabPhone: {
    flex: 1,
    flexDirection: "column",
    paddingTop: 6,
  },
  tabRow: {
    flex: 1,
    flexDirection: "row",
  },
  tabDesktop: {
    flex: 0,
    justifyContent: "flex-start",
    paddingHorizontal: 14,
  },
  tabDesktopCompact: {
    flex: 0,
    justifyContent: "center",
    paddingHorizontal: 0,
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
  },
  labelBox: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontWeight: "600",
  },
  measure: {
    position: "absolute",
    opacity: 0,
    left: 0,
    top: 0,
  },
  badge: {
    position: "absolute",
    top: -5,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: "#ff3b30",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 10.5,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  brand: {
    position: "absolute",
    top: 0,
    left: 0,
    height: 72,
    paddingHorizontal: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  brandMark: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkText: {
    color: "#fff",
    fontSize: 15,
  },
  brandTitle: {
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.16,
  },
});

/* ---------- 默认图标：lucide 同款路径栅格化的白色蒙版（96×96，描边 1.9 / 选中 2.3），tintColor 上色 ---------- */
const ICONS = {
  house: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAADhUlEQVR42u2czUsVURiHf6PXQktd+YGZCV1I8G6iTNwlfq0EF6K7VmVB3UW00IU7V4rgH6AtCzWEtmFCO9OCu7mCkIFXI1AXcouE/Pq1CpyZc+dD58w50Tln9Xrfc+d9dHxmnPdcLeLfHkUwAAbgQiMh6X2L0YZONKMawC6yeI9lnEo5EqOfCT7hBp3jCx+zOPqjRV9+kh9ZaCzzpu4AXczTa+TZpTPAEI/oN444pCeAxXEGHeO0dAMo5QLDjAWW6gRQy1VhmSdc5zpPhK+tslYXgBRzwhJfsY4geI2vha/nmNIBoFvonVOO2LJGeCp0UrdqALF3DtjvyuzngQwnXcw7E8JTY4etwvxW7gjzJy7ipOi9s8bGgmsauRa1k85bfk0B7yyy0nNdJRcLOKkmToBmbgrLmGYiwK3ejHDtJpvjAgjmHa8ZoZNkesdrRuYkud7xmhE5SbZ3vGYkTpLvHclOisM7Up0Ul3ekOSk+70hyUpzekeKkeL0jwUlxeydyJ3n9nSXHO95Omi7gpFRYgDbuC70zLK34v3NY6KR9toUBaBKWH6V3wjtpn7eCApQwE4N3wjspw5JgAM9i8k54Jz0NAlAkeEgiyzthnZRjkT9Au2vZjETveDvppauWdmeWu0PT6Yjn8QjHSpovx3iIN46vdfi3mJod/Y8XUNfIdB895Q9QbYs28E1pC2wbX21xlT/AJVv0Q3kXL2+LLps2qwHQtk9chj70oAHlPnk/sYV3eIsDvQAGMIW6wNkP8B3PMa/PKTSKuRDlA0Ad5jCqC8AAxs61bgwDOgCUYerca6dQph6gL+TJYz+R+tQD9ChcHYmFbtii38j65KdstwMN6gGu2qIs7vrkf8adM1G5uZUwAAbAABgAA2AADIABMAAGwAAYAANgAAyAAdAE4NAWVSivsMKjOiHAni1Kol5p+fVIelQnBLA/GrQwqRRgEpZHdUKAJUc8iFlFP4V6zGLQpzpYdCNt4jqcHfONgh3jJlw5E/3Cuk9ZQfMrkHR894FtNLo+kSnYZJGmriPtrtai6In1Km5raMwM7rm3nVgUP/P/5N6VoHjsoQW5oBeyHHrdwlJcfq+o/MJX4hW0IKPRydOCFYT+QHSCaW4p/8XdYtprx5hFv1uN++hAClWObTj2i101KgHksRtoc1Sw/EPsIYslfPD+KLtl/q+EATAABsAA/NcAfwDNrljbASWDfAAAAABJRU5ErkJggg==' },
  houseOn: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAADnUlEQVR42u2cz0sUYRjHv5OSXhTNzELRDpIagpcMgtRWL4Z2cMFTHfLU1bRD/4DiIZBu9g+IJy8ZKLjlruweuoWBBXoICiM3NzVBNvXbIYjcd+bd+fXOTPI+c5t933eez87s5x3meWcN4v+Oc9AA4UapspEv4A6u4RKAb/iIFeQUHYcqtrt8zWP+G8dMsF/Fsfwf8ipTtIokm6IOEOcuZbHLoSgDjBVcOGZxzLFoApRyhnZjhqVRA6jkIp3EIiujBNDINTqNNTZGBaCTW3QTW7wRBYA4DyxT3OE855m1/PzAu5O8pv+EJ5bpzbGaIFjBOYmTxsMDkHtnksbflgYnVTlJjXfyHBHajzCvwkkqvJNjzLRPjDn/neS/dzbZatmvlZsSJ3UGBTAk8U6GtdK+tcz46yTn6Y9L7nfmWF60f7m/TlLlHdnmq5OceWfJkXdkm29OUusd2eaTk1R7R7b54iT13lHspCC8o9RJ3rwzYdM7cidNeHFScN5x66QluZOC9I4SJwXrHQVOshpuUOKdtAfvyJ2Uljhp0AnAPf5S5h23TsqbI5gN08KfSr3j1kn7bLEHkLH8Dh4qTb64k9J2AOIBecedk4aKA6wE5h03TlopBlBn+pgko8g7zu+TTlh3ul1hiakHhlADeYlebAdeO9pGLxaEvQa65TWyNqHLDh7gMJTy1yHuY0fYe10OUCN0WMZeaBW8PSwL+2rkAGVChx+hFiHFo5fpOvHZrRN3IIYGVBRptY/PeIN3UQMYwBTaHbR/j6d4FZVLqATTWHCUPtCOBUyjJBpn4BlGXfUbBfA4/DMw4DL9PwgD4QNMhdjbB4AOh9e++FvoCBeg1/MZjIULUO8ZoCFcC4nT1gekJO270Vp0hJBXbKXwSPLpCwFAL/rTABpAA2gADaABNIAG0AAaQANoAA2gATTAmQDICy2qQs1PPHpeDpAVOvR5ffQEL4/N+oR9WTnAOsSy5mxICBWYNSn7FmRoFLyOewVfTGr135GwKLd2CaXxdaxKkrLfvgp9JukT9diSAQDJwmJ+pCKFnmIWeh5p6QjZiWfAQBq3Ipp+BrfBYgBAM96iOoLp53ATG3Ymsg0M4yhy6R9hWEzfaiZOoF/ZG9huv/1+JODoje5mycryoCPNZjdLjw3GmZS8qRdEnDDJuGypp9mPuHBq60IbLuK8ZQsDTbgM4Cs+gTYuB3vt88hiHaunpy2TwfQfY2gADaABNICX+A3LLESywsAD1gAAAABJRU5ErkJggg==' },
  compass: { uri: 'data:image/png;base64,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' },
  compassOn: { uri: 'data:image/png;base64,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' },
  message: { uri: 'data:image/png;base64,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' },
  messageOn: { uri: 'data:image/png;base64,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' },
  user: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAAC90lEQVR42u2bvU7jQBDH/zGni1LQRCmgRhE8AFRprrwKRTQWp7zCFZHyGncND4EQhaGC8oR0EtLR0ZCCOikiilBAThZDcRI6b4zjWXvWH8xsNcqO1z+bXc8XDUK1xYMCKIACKIACZJBPIldtoYdd7GAT6wAeMcEdbvAbTwJrUb7Doz4F9Exx8kwB9cnLd8V8b39AY1olYxqUE6BLV5RWrqhbNgCf5sSROfllAhjRC3HlhUZlARiRrYzKAOAnPP0J3dItTRLegl80QDf2bz+kUzqg9tusNh3QKYWxe6FbLEDcyXNOW7Fzt+g89kQqEGAQ8+yHiRbDmPcwKArAW/pshbS/0mp/CWGc5eucBaC/9CyHqeyGS3b9YgAC4zbOUluaeyEoAqBluGzhO1s3fjuHhpvXsr0P+3igh2ZED3Cf2vYeQURvouc+oNkz9GOWtTl71z3AtqH/Ylmbs3fcA2xGtCkeWNYPmCZczQnAekSbse1nCVfTrEQaeYxoHbZ9J+FqTgAmEW0DbZZ1GxsJV3MCMDb0Lyxrc/ade4A/hn7Isv5m6Dfu80KVdyWecBHR1/Ajte1PrEX0iww5u4/sTlc+oKl8SAlqxAb1Z9UJ6muQVql8YqsGqcUaJHdrkF6vQYHj36Fa6RJTQUW+BkmVWfew7aLM2tB+IQVQAAVQAO0XyqUv6DPT9m9OHzgBl4ErmVwMub4grlg6ebJuM1cs3GzpwIUr7EBHPnQUDjXdBO+CwX56d9rHMRrv/DbFDAvm8ddExyhy/H80HuIk32M0XQKLO3JIeEn0BXFHppSjVBKXO6yTvnJpdO6wTLtLFjL4b8Gi8CHbF8QdFn1EssU8/nZmF/880b4grlj0EXnCfUFcYfcRecJ9QVxh9xF5wn1BXGH3EXnifUHCfUSrAaKx7kIcYJGwuqZVFEABFEAB3APMEzQJYa63GuAyQZMQ7nop4oHrN//82r45j9FMyFovTV6ohe/4CuASRyL/UJtpPa0TK4ACKIACfGyAV96IjzGgftaaAAAAAElFTkSuQmCC' },
  userOn: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAADAElEQVR42u1av2/TQBT+4lSgDl2TSmmlbFWIgjqzhhGJtVkY4K/If5AoHToXwcDaCbV7t65YRKEqE0OHkrGWKgWJvg4doPK5fu/O72zDfbed/d75S+y79+NrEOqNCIFAIBAIBAJlYk3Jbxu72MEmNgAkuMIFYvysB4E+3uAVnhmufMMJPmFR8HpU5BjSKeXhlIZFrlmcqy4dExfH1K0agT26Jgmuaa9KBCZkg0lVCLwnWxxWgcCUXDApm8CIXOH4LTSc8oEuvmIj8+ol5lgCaGGArcy7EjzHj7LOgayN84Zm1HtwZ4/26SZzUy3pFXqZ8UBH1DHe36GjDIthOQRMp+4tjR+1GdOt8XQugUDf+FuOc+3GRru+fwJT48vDsTS9SFP/BBaGT7fDsuwYPueFbwJtw684Y1vvG6zbdk9im5HtGuY+sq0/MD0qppQ7hmPrnG19jkuGR1UCm6mZuch+zvCoSiAdQCxF9kuGx1BWeQxJaqYlsm8xPKoSuErNDET2A4ZHVQLfUzNb6LGte4bw+sIvgS+Gubds63eGudh3PlCRUMJ+FzpJzazjgGV5gHWGN/V/oPbhdO0Tmn8gpZQl9TOdpP4/L6tUoLBVVmG3MqVFEOiw3sVd+wLvpEoNjpG4wTEKLaaCCdwfbd6bfG7nQAXarA2qeaO7EQRPgUAgEAjUWi/0Z7t8IrT8Vcz2uqZwYEnhdsCp6YKksAwxdIM2KSyCPG1dkBRiHZHP9FEl0fGjC1JMNX3pgtT+BX/lE6VyCy+c5hSwVsL9+2lBBa+CS4jS4awj0ijiSodT0VerjC4d1mV3vUaGnIJV40NTFyQdVjoizWae/FuwaP7p6oKkw0JHFKnqgqSw0BFFqrogKSx0RJGyLkgKsY4oUtYFSSHWEeURSKfqK1UCK8YThLpQIBAIBAKBgD8CCQqSR8JWzpm4EThjzBQJ+Xo5AW6T4gfBbUxNtWDaar18l9t/uYxpW/XxLdbj1IWaeI0XAM7wGb89fJei9UKfOBAIBAKBQMAJd5xRpE7RXildAAAAAElFTkSuQmCC' },
} satisfies Record<string, ImageSourcePropType>;

const DEFAULT_TABS: TabBarItem[] = [
  { key: "home", title: "首页", iconSource: ICONS.house, activeIconSource: ICONS.houseOn },
  { key: "discover", title: "发现", iconSource: ICONS.compass, activeIconSource: ICONS.compassOn },
  { key: "inbox", title: "消息", iconSource: ICONS.message, activeIconSource: ICONS.messageOn, badge: 3 },
  { key: "me", title: "我的", iconSource: ICONS.user, activeIconSource: ICONS.userOn },
];
