// 滑卡选择（Swipe deck）：拖动顶部卡片，它会按你捏住的位置倾斜，显出「喜欢 / 跳过」印章，下面的卡片同时升起；
// 越过阈值或甩得够快就带着离手速度飞出，否则弹回原位。
// 多端：组件宽 < 600 手机布局；600–899 iPad（牌堆限高居中、按钮在两侧、右边一栏「已喜欢」，喜欢的卡边飞边缩小落进去）；
// ≥ 900 桌面（同 iPad，留白更多）。断点按组件自己的宽度（onLayout）。
// 网页演示里的假状态栏和「发现」标题行（含计数）原生端不画——系统状态栏和宿主导航栏已经有了，结果走 onSwipe 交给宿主。
//
// 依赖：react-native-reanimated（≥ 3）+ react-native-gesture-handler（≥ 2）。拖动、甩出、回弹全在 UI 线程。
// 卡面插画在网站版是 SVG 渐变，这里不引入 svg / skia，用 View 拼：天空是旋转后的细色带，太阳光晕是叠起来的半透明圆，
// 山是按 SVG 路径逐段 skewY 的竖条，底部压暗是分段色带。
import { memo, useEffect, useRef, useState, type ComponentRef, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, type LayoutChangeEvent, type LayoutRectangle } from "react-native";
import Animated, {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

export type SwipeDeckProps = {
  /** 甩出阈值（px）：横向拖过这个距离松手才会飞出；甩得够快时不受限制 */
  threshold?: number;
  /** 倾斜角度（°）：拖到阈值时卡片的倾斜角度 */
  rotation?: number;
  /** 叠放层数：牌堆里能看到几张卡 */
  depth?: number;
  /** 显示印章：拖动时是否显示「喜欢 / 跳过」印章 */
  stamps?: boolean;
  /** 每甩走一张卡回调一次 */
  onSwipe?: (card: { title: string }, direction: "like" | "skip") => void;
};

type Place = { title: string; sub: string; rating: string; dist: string; a: string; b: string; sun: [number, number]; hills: [string, string] };

const CARDS: Place[] = [
  { title: "京都", sub: "日本 · 秋叶季", rating: "4.9", dist: "1,820 km", a: "#FFB38A", b: "#D6336C", sun: [210, 120], hills: ["#B8235A", "#7A1340"] },
  { title: "雷克雅未克", sub: "冰岛 · 极光", rating: "4.8", dist: "7,900 km", a: "#7FE3E8", b: "#2B3A9A", sun: [90, 96], hills: ["#27408F", "#141F5C"] },
  { title: "大理", sub: "云南 · 苍山洱海", rating: "4.7", dist: "2,100 km", a: "#D4F29A", b: "#13866F", sun: [220, 90], hills: ["#1A8A6C", "#0B5747"] },
  { title: "里斯本", sub: "葡萄牙 · 黄色电车", rating: "4.8", dist: "9,600 km", a: "#FFE08A", b: "#F06A1D", sun: [80, 130], hills: ["#E0621C", "#A8430F"] },
  { title: "开普敦", sub: "南非 · 桌山", rating: "4.6", dist: "11,800 km", a: "#D3C2FF", b: "#5634B8", sun: [200, 110], hills: ["#5A37B8", "#33207A"] },
];
const placeOf = (serial: number) => CARDS[((serial % CARDS.length) + CARDS.length) % CARDS.length];

// 叠放：每往后一层缩小 5%、下移 12px
const LAYER_SCALE = 0.05;
const LAYER_Y = 12;
// 弹簧和网站版 motion 的 { stiffness, damping, mass } 一一对应（Reanimated 的 withSpring 用同一个物理模型）
const SETTLE = { stiffness: 420, damping: 34, mass: 1 };
/** 卡片离场的弹簧：手机甩出屏幕、大屏飞进「已喜欢」都用这一条 */
const FLY = { stiffness: 160, damping: 26, mass: 1 };
/** 计数、缩略图落位时的小回弹 */
const POP = { stiffness: 520, damping: 18, mass: 1 };
/** 松手没甩出去时的回弹 */
const RETURN = { stiffness: 520, damping: 30, mass: 1 };
/** 按钮按下 */
const PRESS = { stiffness: 600, damping: 30, mass: 1 };

type Palette = { bg: string; fg: string; muted: string; btn: string; btnLine: string; like: string; nope: string; dark: boolean };
const LIGHT: Palette = { bg: "#f4f4f5", fg: "#111111", muted: "#8a8a8e", btn: "#ffffff", btnLine: "rgba(0,0,0,0.04)", like: "#ff3b5c", nope: "#1c1c1e", dark: false };
const DARK: Palette = { bg: "#0c0c0d", fg: "#f5f5f7", muted: "#8a8a8e", btn: "#1c1c1e", btnLine: "rgba(255,255,255,0.08)", like: "#ff3b5c", nope: "#f5f5f7", dark: true };

/** 已喜欢的一张：serial 是牌堆里的序号（卡面按它取），arrived 表示飞行的卡已经落进右栏 */
type Liked = { serial: number; arrived: boolean };
type End = "phone" | "ipad" | "desktop";
const endOf = (w: number): End => (w >= 900 ? "desktop" : w >= 600 ? "ipad" : "phone");

/** UI 线程要用的布局：组件宽度、是否大屏、卡槽位置、右栏顶部缩略图位置（都相对组件根） */
type Geo = { wide: boolean; width: number; ok: boolean; slotX: number; slotY: number; slotW: number; slotH: number; thumbX: number; thumbY: number };

function ramp(v: number, a: number, b: number) {
  "worklet";
  return Math.min(1, Math.max(0, (v - a) / (b - a)));
}

export function SwipeDeck({ threshold = 110, rotation = 12, depth = 3, stamps = true, onSwipe }: SwipeDeckProps) {
  const pal = useColorScheme() === "dark" ? DARK : LIGHT;
  const T = Math.max(1, threshold);
  const layers = Math.max(1, Math.round(depth));
  const peek = layers * LAYER_Y + 6;

  const [size, setSize] = useState({ w: 0, h: 0 });
  const end = endOf(size.w);
  const wide = end !== "phone";
  const desktop = end === "desktop";
  // 矮容器（卡片尺寸）：卡面文字、印章、按钮都收小一号
  const compact = size.h > 0 && size.h <= 486;
  // 去掉标题行后重新分配的留白：上方留一点给牌堆抬起时的阴影，下方给按钮留出手指的位置
  const pad =
    size.h > 0 && size.h <= 460
      ? { t: 14, x: 16, b: 14 }
      : desktop
        ? { t: 32, x: 28, b: 32 }
        : wide
          ? { t: 24, x: 20, b: 24 }
          : { t: 16, x: 20, b: 24 };
  const listPad = desktop ? 10 : 8;

  const [top, setTop] = useState(0);
  const [flying, setFlying] = useState<number[]>([]);
  // 喜欢过的卡（新的在前）；手机端不显示列表但照样记，切到大屏时右栏直接有内容
  const [liked, setLiked] = useState<Liked[]>([]);
  const likes = liked.length;
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const listRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const flingRef = useRef<((dir: 1 | -1) => void) | null>(null);

  // pos：牌堆的「当前位置」（可以是小数，弹簧过渡）；lift：拖动顶卡时下面的卡跟着升起的量
  const pos = useSharedValue(0);
  const lift = useSharedValue(0);
  const dragX = useSharedValue(0);
  /** lift 正在自己回弹（此时不再跟着 x 走，和网站版一致） */
  const liftSettling = useSharedValue(false);
  const geo = useSharedValue<Geo>({ wide: false, width: 400, ok: false, slotX: 0, slotY: 0, slotW: 0, slotH: 0, thumbX: 0, thumbY: 0 });

  // 布局：手机量牌堆区；大屏量 body / 牌堆区 / 右栏 / 列表（相对父级），再拼成相对根的位置
  const [stackBox, setStackBox] = useState({ w: 0, h: 0 });
  const [lay, setLay] = useState<{ body?: LayoutRectangle; main?: LayoutRectangle; panel?: LayoutRectangle; list?: LayoutRectangle }>({});
  const onLay = (k: "body" | "main" | "panel" | "list") => (e: LayoutChangeEvent) => {
    const r = e.nativeEvent.layout;
    setLay((l) => ({ ...l, [k]: r }));
  };

  // 大屏牌堆：保持手机上的卡片比例（含叠层约 350 × 646），宽度取「最大 380 / 两侧留出按钮后的宽 / 按高度换算的宽」里最小的
  const mainW = lay.main?.width ?? 0;
  const mainH = lay.main?.height ?? 0;
  const narrow = mainW > 0 && mainW <= 440;
  const colGap = narrow ? 10 : desktop ? 28 : 16;
  const btnSize = wide ? (narrow ? 52 : compact ? 46 : 60) : compact ? 46 : 60;
  const wideStackW = Math.max(0, Math.min(desktop && !narrow ? 400 : 380, mainW - (narrow ? 124 : desktop ? 176 : 152), (mainH * 350) / 646));
  const wideStackH = (wideStackW * 646) / 350;
  const stackW = wide ? wideStackW : stackBox.w;
  const stackH = wide ? wideStackH : stackBox.h;
  const slotW = stackW;
  const slotH = Math.max(0, stackH - peek);

  useEffect(() => {
    const { body, main, panel, list } = lay;
    const ok = wide && !!body && !!main && !!panel && !!list && slotW > 0;
    const slotX = ok ? body!.x + main!.x + (main!.width - wideStackW) / 2 : 0;
    const slotY = ok ? body!.y + main!.y + (main!.height - wideStackH) / 2 : 0;
    // 新行插在列表最上面：缩略图在列表左上角往里（列表内边距 + 行内边距 10 / 6）
    const thumbX = ok ? body!.x + panel!.x + list!.x + listPad + 10 : 0;
    const thumbY = ok ? body!.y + panel!.y + list!.y + 6 : 0;
    geo.value = { wide, width: size.w || 400, ok, slotX, slotY, slotW, slotH, thumbX, thumbY };
  }, [lay, wide, size.w, slotW, slotH, wideStackW, wideStackH, listPad, geo]);

  /** 顶卡离场（JS 侧只管状态；动画已经在 UI 线程起步了） */
  const swiped = (serial: number, dir: number) => {
    setTop(serial + 1);
    setFlying((f) => [...f, serial]);
    if (dir > 0) {
      // 大屏：先在右栏顶部占一行，卡片飞到这一行的缩略图位置后才算落位；手机没有右栏，直接算落位
      const flies = wideRef.current;
      setLiked((l) => [{ serial, arrived: !flies }, ...l]);
      if (flies) listRef.current?.scrollTo({ y: 0, animated: true });
    }
    onSwipe?.({ title: placeOf(serial).title }, dir > 0 ? "like" : "skip");
  };

  const landed = (serial: number) => {
    setFlying((f) => f.filter((s) => s !== serial));
    setLiked((l) => (l.some((i) => i.serial === serial && !i.arrived) ? l.map((i) => (i.serial === serial ? { ...i, arrived: true } : i)) : l));
  };

  const serials = [...flying, ...Array.from({ length: layers + 1 }, (_, i) => top + i)];

  const stack =
    slotW > 0 && slotH > 0
      ? serials.map((serial) => (
          <Card
            key={serial}
            serial={serial}
            isTop={serial === top}
            layers={layers}
            slotW={slotW}
            slotH={slotH}
            threshold={T}
            rotation={rotation}
            stamps={stamps}
            compact={compact}
            pal={pal}
            pos={pos}
            lift={lift}
            dragX={dragX}
            liftSettling={liftSettling}
            geo={geo}
            onSwiped={swiped}
            onLanded={landed}
            flingRef={serial === top ? flingRef : undefined}
          />
        ))
      : null;

  const skip = <ActionButton like={false} size={btnSize} dragX={dragX} threshold={T} pal={pal} onPress={() => flingRef.current?.(-1)} />;
  const like = <ActionButton like size={btnSize} dragX={dragX} threshold={T} pal={pal} onPress={() => flingRef.current?.(1)} />;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View
        style={[styles.root, { paddingTop: pad.t, paddingHorizontal: pad.x, paddingBottom: pad.b }]} // 不铺底色：背景跟随宿主 App
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
        }}
      >
        {wide ? (
          <View style={[styles.body, { gap: desktop ? 28 : 20 }]} onLayout={onLay("body")}>
            {/* zIndex 让飞向右栏的卡片从右栏上面经过 */}
            <View style={[styles.main, { columnGap: colGap }]} onLayout={onLay("main")}>
              {/* 牌堆底部有露出叠层的一条，按钮往上让出一半，和卡片本身垂直居中 */}
              <View style={{ marginBottom: peek }}>{skip}</View>
              <View style={{ width: wideStackW, height: wideStackH }}>{stack}</View>
              <View style={{ marginBottom: peek }}>{like}</View>
            </View>
            <View
              style={[styles.panel, { width: Math.min(280, Math.max(200, (size.w - pad.x * 2) * 0.28)), backgroundColor: pal.btn, borderColor: pal.btnLine }]}
              onLayout={onLay("panel")}
            >
              <View style={[styles.panelHead, desktop && styles.panelHeadDesktop]}>
                <Text style={[styles.panelTitle, { color: pal.fg }]}>已喜欢</Text>
                <Text style={[styles.panelCount, { color: pal.muted }]}>{likes}</Text>
              </View>
              <ScrollView
                ref={listRef}
                style={styles.list}
                contentContainerStyle={{ paddingHorizontal: listPad, paddingBottom: listPad }}
                onLayout={onLay("list")}
              >
                {likes === 0 && <Text style={[styles.empty, { color: pal.muted }]}>右滑喜欢，卡片会收在这里</Text>}
                {liked.map((item) => (
                  <LikedRow key={item.serial} item={item} pal={pal} />
                ))}
              </ScrollView>
            </View>
          </View>
        ) : (
          <>
            <View
              style={styles.stack}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                setStackBox((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
              }}
            >
              {stack}
            </View>
            <View style={[styles.actions, compact && styles.actionsCompact]}>
              {skip}
              {like}
            </View>
          </>
        )}
      </View>
    </GestureHandlerRootView>
  );
}

// ---------- 卡片 ----------

type CardProps = {
  serial: number;
  isTop: boolean;
  layers: number;
  slotW: number;
  slotH: number;
  threshold: number;
  rotation: number;
  stamps: boolean;
  compact: boolean;
  pal: Palette;
  pos: SharedValue<number>;
  lift: SharedValue<number>;
  dragX: SharedValue<number>;
  liftSettling: SharedValue<boolean>;
  geo: SharedValue<Geo>;
  onSwiped: (serial: number, dir: number) => void;
  onLanded: (serial: number) => void;
  flingRef?: RefObject<((dir: 1 | -1) => void) | null>;
};

function Card({ serial, isTop, layers, slotW, slotH, threshold, rotation, stamps, compact, pal, pos, lift, dragX, liftSettling, geo, onSwiped, onLanded, flingRef }: CardProps) {
  const card = placeOf(serial);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // 只有飞进右栏时才会变小；平时一直是 1
  const scale = useSharedValue(1);
  // 抓在上半部分往右拖是顺时针，抓在下半部分是逆时针，像真的捏着一张卡
  const grab = useSharedValue(1);
  const gone = useSharedValue(false);
  const dragging = useSharedValue(false);
  const start = useSharedValue({ x: 0, y: 0 });

  // 顶卡 x 一变：按钮跟着放大填色、下面的卡跟着升起（回弹时 lift 有自己的弹簧）
  useAnimatedReaction(
    () => x.value,
    (v, prev) => {
      if (prev === null || !isTop || gone.value) return;
      dragX.value = v;
      if (!liftSettling.value) lift.value = Math.min(1, Math.abs(v) / threshold) * 0.85;
    },
    [isTop, threshold],
  );

  /** 离场：dir 方向，vx / vy 是离手速度（px/s） */
  const fling = (dir: number, vx: number, vy: number) => {
    "worklet";
    const g = geo.value;
    const v = dir * Math.max(Math.abs(vx), 1100);
    gone.value = true;
    // 牌堆前进一张：把拖动时已经升起的量并进 pos，再弹到下一张，画面连续
    cancelAnimation(pos);
    cancelAnimation(lift);
    liftSettling.value = false;
    pos.value = pos.value + lift.value;
    lift.value = 0;
    pos.value = withSpring(serial + 1, SETTLE);
    dragX.value = withSpring(0, { ...SETTLE, velocity: vx });
    runOnJS(onSwiped)(serial, dir);

    if (dir > 0 && g.wide && g.ok) {
      // 大屏喜欢：同一条离场弹簧，终点换成右栏顶部那一行的缩略图——边飞边缩小、倾斜回正。
      // 网站版用 0→1 的进度驱动；弹簧是线性的，把同一个进度速度乘到每个量的行程上，效果相同
      const s = Math.sqrt((45 * 60) / (g.slotW * g.slotH));
      // 卡片的 transform-origin 是 50% 60%，缩放后卡片中心会往上偏 0.1 个卡高
      const toX = g.thumbX + 22.5 - (g.slotX + g.slotW / 2);
      const toY = g.thumbY + 30 - (g.slotY + g.slotH * 0.6) + g.slotH * 0.1 * s;
      const from = { x: x.value, y: y.value, g: grab.value, s: scale.value };
      const rate = (vel: number, d: number) => (Math.abs(d) > 1 ? Math.max(-6, Math.min(6, vel / d)) : 0);
      const vpx = Math.max(0, rate(Math.max(Math.abs(vx), 1100), toX - from.x));
      const vpy = rate(vy, toY - from.y);
      x.value = withSpring(toX, { ...FLY, velocity: vpx * (toX - from.x) }, (done) => {
        if (done) runOnJS(onLanded)(serial);
      });
      scale.value = withSpring(s, { ...FLY, velocity: vpx * (s - from.s) });
      grab.value = withSpring(0, { ...FLY, velocity: vpx * (0 - from.g) });
      y.value = withSpring(toY, { ...FLY, velocity: vpy * (toY - from.y) });
      return;
    }
    x.value = withSpring(dir * (g.width * 1.15 + 120), { ...FLY, velocity: v }, (done) => {
      if (done) runOnJS(onLanded)(serial);
    });
    y.value = withSpring(y.value + vy * 0.18, { ...FLY, velocity: vy });
  };

  const release = (vx: number, vy: number) => {
    "worklet";
    const dx = x.value;
    // 够远、或者甩得够快（且方向一致）就飞走
    const dir = Math.abs(vx) > 650 ? Math.sign(vx) : Math.abs(dx) > threshold ? Math.sign(dx) : 0;
    if (dir !== 0 && (Math.sign(dx) === dir || Math.abs(dx) < 8)) {
      fling(dir, vx, vy);
    } else {
      x.value = withSpring(0, { ...RETURN, velocity: vx });
      y.value = withSpring(0, { ...RETURN, velocity: vy });
      // lift = min(1, |x| / 阈值) × 0.85，换算出它离手时的速度
      const liftV = Math.abs(dx) < threshold ? (0.85 / threshold) * vx * Math.sign(dx) : 0;
      liftSettling.value = true;
      lift.value = withSpring(0, { ...SETTLE, velocity: liftV }, () => {
        liftSettling.value = false;
      });
    }
  };

  // 按钮：顶卡带着一点上扬甩出去
  const flingButton = (dir: number) => {
    "worklet";
    if (dragging.value || gone.value) return;
    grab.value = 1;
    fling(dir, 0, -260);
  };
  if (flingRef) flingRef.current = (dir) => runOnUI(flingButton)(dir);

  const pan = Gesture.Pan()
    .enabled(isTop)
    .minDistance(0)
    .onBegin((e) => {
      if (gone.value || dragging.value) return;
      // 按下：停在当前帧（回弹途中也能接住），按抓的位置决定倾斜方向
      cancelAnimation(x);
      cancelAnimation(y);
      cancelAnimation(lift);
      liftSettling.value = false;
      grab.value = e.y < slotH / 2 ? 1 : -1;
      start.value = { x: x.value, y: y.value };
      dragging.value = true;
    })
    .onUpdate((e) => {
      if (!dragging.value) return;
      x.value = start.value.x + e.translationX;
      y.value = start.value.y + e.translationY * 0.7;
    })
    .onFinalize((e) => {
      if (!dragging.value) return;
      dragging.value = false;
      release(e.velocityX, e.velocityY * 0.7);
    });

  // 叠放姿态（相对层级 0 是顶卡，负数是已经飞走的）：以卡槽底边为锚点缩小、下移，最后一层淡入
  const slotStyle = useAnimatedStyle(() => {
    const rel = serial - pos.value - lift.value;
    return {
      opacity: Math.min(1, Math.max(0, layers - rel)),
      transform: [{ translateY: Math.max(0, rel) * LAYER_Y }, { scale: 1 - Math.max(0, rel) * LAYER_SCALE }],
    };
  }, [serial, layers]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { rotate: `${(x.value / threshold) * rotation * grab.value}deg` },
      { scale: scale.value },
    ],
  }), [threshold, rotation]);

  const likeStamp = useAnimatedStyle(() => {
    const o = ramp(x.value, threshold * 0.2, threshold);
    return { opacity: o, transform: [{ rotate: "-12deg" }, { scale: 0.8 + 0.2 * o }] };
  }, [threshold]);
  const nopeStamp = useAnimatedStyle(() => {
    const o = ramp(-x.value, threshold * 0.2, threshold);
    return { opacity: o, transform: [{ rotate: "12deg" }, { scale: 0.8 + 0.2 * o }] };
  }, [threshold]);

  return (
    <Animated.View
      pointerEvents={isTop ? "box-none" : "none"}
      style={[styles.slot, { width: slotW, height: slotH, zIndex: 1000 - serial }, slotStyle]}
    >
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: pal.bg, shadowOpacity: pal.dark ? 0.55 : 0.22 },
            cardStyle,
          ]}
        >
          <View style={[styles.cardClip, pal.dark && styles.cardRing]}>
            <Scene index={serial} w={slotW} h={slotH} />
            {stamps && (
              <>
                <Animated.View style={[styles.stamp, compact && styles.stampCompact, { left: compact ? 14 : 22, borderColor: "#1fbf6b" }, likeStamp]}>
                  <Text style={[styles.stampText, compact && styles.stampTextCompact, { color: "#1fbf6b" }]}>喜欢</Text>
                </Animated.View>
                <Animated.View style={[styles.stamp, compact && styles.stampCompact, { right: compact ? 14 : 22, borderColor: "#ff3b5c" }, nopeStamp]}>
                  <Text style={[styles.stampText, compact && styles.stampTextCompact, { color: "#ff3b5c" }]}>跳过</Text>
                </Animated.View>
              </>
            )}
            <View style={[styles.info, compact && styles.infoCompact]}>
              {!compact && (
                <View style={styles.chips}>
                  <Text style={styles.chip}>★ {card.rating}</Text>
                  <Text style={styles.chip}>{card.dist}</Text>
                </View>
              )}
              <Text style={[styles.title, compact && styles.titleCompact]}>{card.title}</Text>
              <Text style={[styles.sub, compact && styles.subCompact]}>{card.sub}</Text>
            </View>
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

// ---------- 按钮、右栏 ----------

function ActionButton({ like, size, dragX, threshold, pal, onPress }: { like: boolean; size: number; dragX: SharedValue<number>; threshold: number; pal: Palette; onPress: () => void }) {
  const press = useSharedValue(1);
  const tint = like ? pal.like : pal.nope;
  // 拖向哪边，哪个按钮跟着放大、填色
  const wrap = useAnimatedStyle(() => {
    const t = like ? ramp(dragX.value, 0, threshold) : ramp(-dragX.value, 0, threshold);
    return { transform: [{ scale: (1 + 0.14 * t) * press.value }] };
  }, [like, threshold]);
  const fill = useAnimatedStyle(() => ({
    opacity: like ? ramp(dragX.value, threshold * 0.2, threshold) : ramp(-dragX.value, threshold * 0.2, threshold),
  }), [like, threshold]);
  const icon = (color: string) => (like ? <Heart size={24} color={color} /> : <Cross size={22} color={color} />);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={like ? "喜欢" : "跳过"}
      onPressIn={() => (press.value = withSpring(0.9, PRESS))}
      onPressOut={() => (press.value = withSpring(1, PRESS))}
      onPress={onPress}
    >
      <Animated.View
        style={[
          styles.btn,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: pal.btn, borderColor: pal.btnLine, shadowOpacity: pal.dark ? 0.4 : 0.08 },
          wrap,
        ]}
      >
        {icon(tint)}
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, { borderRadius: size / 2, backgroundColor: tint }, fill]}>
          {icon(like ? "#fff" : pal.bg)}
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

/** 右栏的一行：新喜欢的一行先撑开高度占位，卡片落进来时缩略图轻轻弹一下 */
function LikedRow({ item, pal }: { item: Liked; pal: Palette }) {
  const card = placeOf(item.serial);
  // 挂上时还没落位的是「新飞来的」：要撑开、要弹；手机端喜欢的、切到大屏时已经在的，直接显示
  const fresh = useRef(!item.arrived).current;
  const open = useSharedValue(fresh ? 0 : 1);
  useEffect(() => {
    open.value = withSpring(1, SETTLE);
  }, [open]);
  const rowStyle = useAnimatedStyle(() => ({ height: Math.max(0, open.value) * 72, opacity: Math.min(1, Math.max(0, open.value)) }));
  return (
    <Animated.View style={[styles.row, rowStyle]}>
      <View style={styles.rowInner}>
        <View style={[styles.thumb, { backgroundColor: pal.bg }]}>{item.arrived && <ThumbPop fresh={fresh} serial={item.serial} />}</View>
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: pal.fg }]}>{card.title}</Text>
          <Text numberOfLines={1} style={[styles.rowSub, { color: pal.muted }]}>{card.sub}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

function ThumbPop({ fresh, serial }: { fresh: boolean; serial: number }) {
  const s = useSharedValue(fresh ? 0.88 : 1);
  useEffect(() => {
    s.value = withSpring(1, POP);
  }, [s]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Scene index={serial} w={45} h={60} thumb />
    </Animated.View>
  );
}

// ---------- 卡面插画（View 拼出来的 SVG 场景，坐标系 300 × 400，xMidYMid slice） ----------

type Col = { left: number; width: number; top: number; height: number; skew: string };

/** 折线 → 一排竖条：每条用 skewY 让顶边正好落在这一段线上，竖边互相贴合 */
function columns(pts: [number, number][]): Col[] {
  const out: Col[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const w = x2 - x1;
    if (w <= 0) continue;
    const tan = (y2 - y1) / w;
    const W = w + 0.6; // 稍微重叠，盖住接缝
    const top = y1 + (W / 2) * tan; // skewY 以中心为原点
    out.push({ left: x1, width: W, top, height: 410 - top + W * Math.abs(tan), skew: `${(Math.atan(tan) * 180) / Math.PI}deg` });
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

function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mix(a: string, b: string, t: number) {
  const A = hex(a);
  const B = hex(b);
  const k = Math.min(1, Math.max(0, t));
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(",")})`;
}

// 天空：SVG 的 x1=0 y1=0 x2=0.4 y2=1 是按外框比例的渐变，换算到 300 × 400 里，渐变终点 E 和方向角
const GX = 0.4;
const GY = 1;
const LAMBDA = (GX * GX + GY * GY) / ((GX * GX) / 90000 + (GY * GY) / 160000);
const EX = (LAMBDA * GX) / 300;
const EY = (LAMBDA * GY) / 400;
const E_LEN = Math.hypot(EX, EY);
const SKY_ANGLE = (Math.atan2(EX, EY) * 180) / Math.PI;
const T_CENTER = (150 * EX + 200 * EY) / (E_LEN * E_LEN);
const SKY_SIDE = 520; // 旋转后的色带方块边长，盖住整个画面

/** 太阳光晕：0 处白 0.9、0.35 处 0.45、边缘 0；用一圈圈半透明圆叠出同样的径向衰减 */
function sunRings(n: number) {
  const A = (rho: number) => (rho < 0.35 ? 0.9 - (0.45 * rho) / 0.35 : (0.45 * (1 - rho)) / 0.65);
  const rings: { r: number; a: number }[] = [];
  for (let k = n; k >= 1; k--) {
    const inner = A((k - 0.5) / n);
    const outer = k === n ? 0 : A((k + 0.5) / n);
    rings.push({ r: (90 * k) / n, a: 1 - (1 - inner) / (1 - outer) });
  }
  return rings;
}

type SceneParts = { bands: number; rings: { r: number; a: number }[]; hills: [Col[], Col[], Col[]]; scrim: number };
const partsCache: Record<string, SceneParts> = {};
function sceneParts(thumb: boolean): SceneParts {
  const key = thumb ? "thumb" : "full";
  if (partsCache[key]) return partsCache[key];
  const q = thumb ? 4 : 10;
  const h1 = columns([[0, 250], [48, 214], [96, 236], [150, 186], [208, 230], [254, 204], [300, 226]]);
  const h2 = columns([[0, 292], ...quad([0, 292], [60, 256], [120, 280], q), ...quad([120, 280], [180, 304], [240, 270], q), ...quad([240, 270], [300, 236], [300, 262], q)]);
  const h3 = columns([[0, 330], ...quad([0, 330], [80, 300], [160, 322], q), ...quad([160, 322], [240, 344], [300, 310], q)]);
  partsCache[key] = { bands: thumb ? 14 : 44, rings: sunRings(thumb ? 6 : 14), hills: [h1, h2, h3], scrim: thumb ? 6 : 16 };
  return partsCache[key];
}

const Scene = memo(function Scene({ index, w, h, thumb = false }: { index: number; w: number; h: number; thumb?: boolean }) {
  const card = placeOf(index);
  const parts = sceneParts(thumb);
  const k = Math.max(w / 300, h / 400);
  const [sx, sy] = card.sun;
  const bandH = SKY_SIDE / parts.bands;
  const scrimH = 200 / parts.scrim;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={{ position: "absolute", left: (w - 300) / 2, top: (h - 400) / 2, width: 300, height: 400, transform: [{ scale: k }] }}>
        {/* 天空 */}
        <View
          style={{
            position: "absolute",
            left: 150 - SKY_SIDE / 2,
            top: 200 - SKY_SIDE / 2,
            width: SKY_SIDE,
            height: SKY_SIDE,
            transform: [{ rotate: `${-SKY_ANGLE}deg` }],
          }}
        >
          {Array.from({ length: parts.bands }, (_, i) => {
            const t = T_CENTER + ((i + 0.5) * bandH - SKY_SIDE / 2) / E_LEN;
            return <View key={i} style={{ position: "absolute", left: 0, right: 0, top: i * bandH, height: bandH + 0.75, backgroundColor: mix(card.a, card.b, t) }} />;
          })}
        </View>
        {/* 太阳光晕 + 太阳 */}
        {parts.rings.map(({ r, a }) => (
          <View key={r} style={{ position: "absolute", left: sx - r, top: sy - r, width: r * 2, height: r * 2, borderRadius: r, backgroundColor: `rgba(255,255,255,${a})` }} />
        ))}
        <View style={{ position: "absolute", left: sx - 26, top: sy - 26, width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(255,255,255,0.85)" }} />
        {/* 三层山（透明度加在整组上，竖条之间的重叠不会叠深） */}
        {parts.hills.map((cols, i) => (
          <View key={i} needsOffscreenAlphaCompositing style={[StyleSheet.absoluteFill, { opacity: i === 0 ? 0.55 : i === 1 ? 0.85 : 1 }]}>
            {cols.map((c, j) => (
              <View
                key={j}
                style={{
                  position: "absolute",
                  left: c.left,
                  top: c.top,
                  width: c.width,
                  height: c.height,
                  backgroundColor: i === 2 ? card.hills[1] : card.hills[0],
                  transform: [{ skewY: c.skew }],
                }}
              />
            ))}
          </View>
        ))}
        {/* 底部压暗：一半往下从 0 渐变到 0.42 */}
        {Array.from({ length: parts.scrim }, (_, i) => (
          <View
            key={`s${i}`}
            style={{ position: "absolute", left: 0, right: 0, top: 200 + i * scrimH, height: scrimH, backgroundColor: `rgba(0,0,0,${(0.42 * (i + 0.5)) / parts.scrim})` }}
          />
        ))}
      </View>
    </View>
  );
});

// ---------- 图标 ----------

/** 心形：网站版是 SVG 路径，这里用「旋转方块 + 两个圆」拼出同样比例（24 格坐标里：两瓣半径 4.3、底尖约在 19.6） */
function Heart({ size, color }: { size: number; color: string }) {
  const k = size / 24;
  const s = 8.6 * k;
  const off = s / (2 * Math.SQRT2);
  const cx = 12 * k;
  const cy = 13.5 * k;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: "absolute", left: cx - s / 2, top: cy - s / 2, width: s, height: s, backgroundColor: color, transform: [{ rotate: "45deg" }] }} />
      <View style={{ position: "absolute", left: cx - off - s / 2, top: cy - off - s / 2, width: s, height: s, borderRadius: s / 2, backgroundColor: color }} />
      <View style={{ position: "absolute", left: cx + off - s / 2, top: cy - off - s / 2, width: s, height: s, borderRadius: s / 2, backgroundColor: color }} />
    </View>
  );
}

/** 叉号：M6.5 6.5l11 11M17.5 6.5l-11 11，线宽 2.4、圆头 */
function Cross({ size, color }: { size: number; color: string }) {
  const k = size / 24;
  const len = 11 * Math.SQRT2 * k + 2.4 * k;
  const t = 2.4 * k;
  const bar = { position: "absolute" as const, left: (size - len) / 2, top: (size - t) / 2, width: len, height: t, borderRadius: t / 2, backgroundColor: color };
  return (
    <View style={{ width: size, height: size }}>
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
}

// ---------- 样式（来自 style.css） ----------

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", overflow: "hidden" },

  stack: { flex: 1, minHeight: 0, width: "100%", maxWidth: 380 },
  slot: { position: "absolute", left: 0, top: 0, transformOrigin: "50% 100%" },
  card: {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
    borderRadius: 26,
    transformOrigin: "50% 60%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 14 },
    shadowRadius: 12,
    elevation: 8,
  },
  cardClip: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: 26, overflow: "hidden" },
  cardRing: { borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  info: { position: "absolute", left: 22, right: 22, bottom: 22, gap: 4 },
  infoCompact: { left: 16, right: 16, bottom: 14 },
  chips: { flexDirection: "row", gap: 6, marginBottom: 6 },
  chip: {
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.22)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  title: { color: "#fff", fontSize: 30, lineHeight: 34.5, fontWeight: "700", letterSpacing: -0.3, textShadowColor: "rgba(0,0,0,0.18)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 12 },
  titleCompact: { fontSize: 22, lineHeight: 25.3 },
  sub: { color: "#fff", fontSize: 15, opacity: 0.88, textShadowColor: "rgba(0,0,0,0.18)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 12 },
  subCompact: { fontSize: 13 },
  stamp: { position: "absolute", top: 26, paddingVertical: 3, paddingHorizontal: 12, borderWidth: 3, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.92)" },
  stampCompact: { top: 14 },
  stampText: { fontSize: 24, fontWeight: "800", letterSpacing: 2.88 },
  stampTextCompact: { fontSize: 18, letterSpacing: 2.16 },

  actions: { flexDirection: "row", justifyContent: "center", gap: 28, paddingTop: 16 },
  actionsCompact: { gap: 20, paddingTop: 8 },
  btn: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 10,
    elevation: 4,
  },
  center: { alignItems: "center", justifyContent: "center" },

  body: { flex: 1, minHeight: 0, alignSelf: "stretch", flexDirection: "row" },
  main: { flex: 1, minWidth: 0, zIndex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  panel: { alignSelf: "stretch", borderRadius: 22, borderWidth: 1, overflow: "hidden" },
  panelHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", paddingTop: 16, paddingHorizontal: 18, paddingBottom: 8 },
  panelHeadDesktop: { paddingTop: 18, paddingHorizontal: 20, paddingBottom: 10 },
  panelTitle: { fontSize: 15, fontWeight: "600" },
  panelCount: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  list: { flex: 1, minHeight: 0 },
  empty: { paddingVertical: 6, paddingHorizontal: 10, fontSize: 13 },
  row: { overflow: "hidden" },
  rowInner: { height: 72, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6, paddingHorizontal: 10 },
  thumb: { width: 45, height: 60, borderRadius: 10, overflow: "hidden" },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: "600" },
  rowSub: { fontSize: 12 },
});
