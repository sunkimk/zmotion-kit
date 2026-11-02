// 灵动岛（React Native 版）：黑色胶囊在空闲、播放音乐、来电、计时、通话之间弹性变形，宽高、圆角和里面的内容一起过渡；
// 轻点切到下一个状态，长按展开成完整播放器，来电可以接听或挂断。自动轮播会给手动操作让路（手动操作后先停 6 秒）。
//
// 原生端说明：
// - App 画不到系统真正的灵动岛上，这里是一个普通视图：宽度撑满父容器、岛居中，高度跟着岛变；
//   宿主放在哪儿就在哪儿，通常绝对定位在屏幕顶部，展开时盖在内容上面。
// - 网页演示里的锁屏（壁纸、时间日期、手电筒 / 相机、状态栏、Home 条）不画。
// - 受控：传 mode + onModeChange 由宿主驱动状态；不传 mode 则组件自己管。autoCycle 打开时按网页节奏自动轮播（受控时通过 onModeChange 通知宿主）。
//
// 动画：变形用网页同一条 motion 弹簧 { duration, bounce }，按 motion 的 findSpring 换算成 stiffness / damping 后交给 withSpring（mass 显式为 1）。
// 内容层按目标尺寸排好，left 跟着岛的当前宽度逐帧居中（网页 left: calc(50% - w/2)）。
// 不依赖 react-native-svg：图标是 lucide 同款路径预先栅格化的白色蒙版 PNG，用 tintColor 上色。
// 网页内容切换时的 blur 滤镜 RN 没有通用实现，这里只保留透明度和缩放。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, Text, View, useColorScheme, type ImageSourcePropType, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  type LayoutAnimation,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

export type DynamicIslandMode = "idle" | "music" | "call" | "timer" | "oncall" | "expanded";

/** 岛里显示的文案和数据（默认是网页演示的示例数据） */
export type DynamicIslandContent = {
  title: string;
  artist: string;
  callerName: string;
  callerLabel: string;
  callerAvatar: string;
  /** 计时器起始秒数（倒数） */
  timerSeconds: number;
  /** 播放器进度条两侧的时间 */
  elapsed: string;
  remaining: string;
};

export type DynamicIslandProps = {
  /** 变形时的回弹程度，0 为不回弹（0–0.6） */
  bounce?: number;
  /** 一次变形大约用多久（秒，0.25–1.2），越小越干脆 */
  duration?: number;
  /** 不操作时每隔几秒自动切到下一个状态；手动点过之后会先停 6 秒 */
  autoCycle?: boolean;
  /** 声波、计时数字和进度条的颜色 */
  accent?: string;
  /** 受控：当前状态；不传则组件内部自己管理 */
  mode?: DynamicIslandMode;
  /** 状态改变（轻点、长按、接听挂断、自动轮播）时回调 */
  onModeChange?: (mode: DynamicIslandMode) => void;
  /** 歌名、来电人、计时起点等，只传要改的字段 */
  content?: Partial<DynamicIslandContent>;
  /** 来电点了接听（岛随后切到通话中） */
  onAccept?: () => void;
  /** 来电点了挂断（岛随后回到空闲） */
  onDecline?: () => void;
  /** 播放器里点了播放 / 暂停 */
  onPlayingChange?: (playing: boolean) => void;
  /** 播放器里点了上一首 */
  onPrevious?: () => void;
  /** 播放器里点了下一首 */
  onNext?: () => void;
};

type Mode = DynamicIslandMode;

const DEFAULT_CONTENT: DynamicIslandContent = {
  title: "晚风与海",
  artist: "Zmotion Radio",
  callerName: "妈妈",
  callerLabel: "手机来电",
  callerAvatar: "👩🏻",
  timerSeconds: 299,
  elapsed: "1:24",
  remaining: "-2:21",
};

const SIZE: Record<Mode, { w: number; h: number; r: number }> = {
  idle: { w: 126, h: 37, r: 19 },
  music: { w: 210, h: 37, r: 19 },
  timer: { w: 210, h: 37, r: 19 },
  oncall: { w: 196, h: 37, r: 19 },
  call: { w: 360, h: 74, r: 37 },
  expanded: { w: 360, h: 186, r: 46 },
};
const NEXT: Record<Mode, Mode> = { idle: "music", music: "call", call: "timer", timer: "idle", oncall: "idle", expanded: "music" };
const AUTO_DELAY: Record<Mode, number> = { idle: 1600, music: 2600, call: 3200, timer: 3000, oncall: 3000, expanded: 4200 };
/** 手动操作后，自动轮播至少歇这么久，不和人抢 */
const USER_HOLD = 6000;
const LABEL: Record<Mode, (c: DynamicIslandContent) => string> = {
  idle: () => "灵动岛，轻点切换状态，长按展开",
  music: (c) => `正在播放：${c.title}`,
  call: (c) => `来电：${c.callerName}`,
  timer: () => "计时器",
  oncall: () => "通话中",
  expanded: () => "播放器",
};

const GREEN = "#30d158";

/** motion 的 { type: "spring", duration, bounce }：duration 是「停稳时间」，按 motion-dom 的 findSpring 换算成物理参数 */
function findSpring(durationSec: number, bounce: number) {
  const safeMin = 0.001;
  const ratio = Math.max(1 - bounce, 0.05);
  const duration = Math.min(10, Math.max(0.01, durationSec));
  const angular = (f: number, r: number) => f * Math.sqrt(1 - r * r);
  let envelope: (f: number) => number;
  let derivative: (f: number) => number;
  if (ratio < 1) {
    envelope = (f) => {
      const decay = f * ratio;
      const delta = decay * duration;
      return safeMin - (decay / angular(f, ratio)) * Math.exp(-delta);
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
  return { stiffness, damping, mass: 1 };
}

/** CSS cubic-bezier(x1, y1, x2, y2) 在进度 x 处的值（二分求 t），UI 线程可用 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number) {
  "worklet";
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    const u = 1 - t;
    const bx = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
    if (bx < x) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  const u = 1 - t;
  return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
}

export function DynamicIsland({
  bounce = 0.3,
  duration = 0.55,
  autoCycle = true,
  accent = "#FF9F0A",
  mode: modeProp,
  onModeChange,
  content: contentProp,
  onAccept,
  onDecline,
  onPlayingChange,
  onPrevious,
  onNext,
}: DynamicIslandProps) {
  const dark = useColorScheme() === "dark";
  const reduce = useReducedMotion();
  const c: DynamicIslandContent = { ...DEFAULT_CONTENT, ...contentProp };

  const controlled = modeProp !== undefined;
  const [inner, setInner] = useState<Mode>("idle");
  const mode: Mode = controlled ? modeProp : inner;
  const [pressing, setPressing] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [rootW, setRootW] = useState(390);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const userAt = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  /** user = false 是自动轮播：不算「刚被人操作过」 */
  const go = (next: Mode, user = true) => {
    if (user) userAt.current = Date.now();
    if (!controlled) setInner(next);
    onModeChange?.(next);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const poke = () => {
    userAt.current = Date.now();
  };

  // 自动轮播：在当前状态停 AUTO_DELAY 后切到下一个；刚被人操作过就顺延到满 6 秒
  useEffect(() => {
    if (!autoCycle || pressing) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      t = setTimeout(() => {
        const quiet = Date.now() - userAt.current;
        if (quiet < USER_HOLD) return schedule(Math.max(500, USER_HOLD - quiet));
        goRef.current(NEXT[modeRef.current], false);
      }, ms);
    };
    schedule(AUTO_DELAY[mode]);
    return () => clearTimeout(t);
  }, [autoCycle, mode, pressing]);

  useEffect(() => () => clearTimeout(pressTimer.current), []);

  /* ---------- 轻点 / 长按（岛背后一层独占手势，按钮在它上面各管各的） ---------- */
  const pressIn = () => {
    userAt.current = Date.now();
    longPressed.current = false;
    setPressing(true);
    clearTimeout(pressTimer.current);
    // 按住 450ms 算长按：展开播放器（已展开则收回音乐）
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      setPressing(false);
      goRef.current(modeRef.current === "expanded" ? "music" : "expanded");
    }, 450);
  };
  const pressOut = () => {
    clearTimeout(pressTimer.current);
    setPressing(false);
  };
  const tap = () => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    goRef.current(NEXT[modeRef.current]);
  };

  const gesture = Gesture.Tap()
    .maxDuration(60000)
    .shouldCancelWhenOutside(true)
    .runOnJS(true)
    .onBegin(() => pressIn())
    .onEnd((_e, success) => {
      if (success) tap();
    })
    .onFinalize(() => pressOut());

  /* ---------- 岛的外形：宽高圆角走 motion 弹簧，按下时放大 1.06 ---------- */
  const s = SIZE[mode];
  const w = Math.max(0, Math.min(s.w, rootW - 20));
  const spring = useMemo(() => findSpring(duration, reduce ? 0 : bounce), [duration, bounce, reduce]);

  const aw = useSharedValue(w);
  const ah = useSharedValue(s.h);
  const ar = useSharedValue(s.r);
  const scale = useSharedValue(1);

  useEffect(() => {
    // motion 的 duration 弹簧不继承被打断动画的速度：先停掉旧动画，再从当前值出发
    cancelAnimation(aw);
    cancelAnimation(ah);
    cancelAnimation(ar);
    aw.value = withSpring(w, { ...spring, velocity: 0 });
    ah.value = withSpring(s.h, { ...spring, velocity: 0 });
    ar.value = withSpring(s.r, { ...spring, velocity: 0 });
  }, [w, s.h, s.r, spring, aw, ah, ar]);

  useEffect(() => {
    scale.value = withSpring(pressing ? 1.06 : 1, pressing ? { stiffness: 120, damping: 20, mass: 1 } : { stiffness: 500, damping: 22, mass: 1 });
  }, [pressing, scale]);

  const islandStyle = useAnimatedStyle(() => {
    const W = Math.max(0, aw.value);
    const H = Math.max(0, ah.value);
    return {
      width: W,
      height: H,
      borderRadius: Math.max(0, Math.min(ar.value, W / 2, H / 2)),
      transform: [{ scale: scale.value }],
    };
  });

  /* ---------- 声波的时钟：只在播放且看得见声波时走（相当于 animation-play-state） ---------- */
  const waveT = useSharedValue(0);
  const frame = useFrameCallback((f) => {
    "worklet";
    waveT.value += (f.timeSincePreviousFrame ?? 16) / 1000;
  }, false);
  const waveVisible = mode === "music" || mode === "expanded";
  useEffect(() => {
    frame.setActive(playing && waveVisible);
  }, [frame, playing, waveVisible]);

  /* ---------- 内容进出场：新内容延迟一点淡入放大，旧内容很快淡出 ---------- */
  const transitions = useMemo(() => {
    const enterEase = Easing.bezier(0.2, 0.8, 0.3, 1);
    const exitEase = Easing.bezier(0, 0, 0.58, 1);
    const enterMs = duration * 600;
    const delayMs = duration * 180;
    const exitMs = Math.min(160, duration * 400);
    const entering = (_v: EntryAnimationsValues): LayoutAnimation => {
      "worklet";
      return {
        initialValues: { opacity: 0, transform: [{ scale: 0.86 }] },
        animations: {
          opacity: withDelay(delayMs, withTiming(1, { duration: enterMs, easing: enterEase })),
          transform: [{ scale: withDelay(delayMs, withTiming(1, { duration: enterMs, easing: enterEase })) }],
        },
      };
    };
    const exiting = (_v: ExitAnimationsValues): LayoutAnimation => {
      "worklet";
      return {
        initialValues: { opacity: 1, transform: [{ scale: 1 }] },
        animations: {
          opacity: withTiming(0, { duration: exitMs, easing: exitEase }),
          transform: [{ scale: withTiming(0.9, { duration: exitMs, easing: exitEase }) }],
        },
      };
    };
    return { entering, exiting };
  }, [duration]);

  const togglePlay = () => {
    poke();
    const next = !playing;
    setPlaying(next);
    onPlayingChange?.(next);
  };

  let body: ReactNode = null;
  if (mode === "music")
    body = (
      <View pointerEvents="none" style={[styles.row, styles.musicRow]}>
        <Art size={25} radius={7} />
        <Wave t={waveT} accent={accent} />
      </View>
    );
  else if (mode === "timer") body = <Clock phone={false} from={c.timerSeconds} dir={-1} accent={accent} />;
  else if (mode === "oncall") body = <Clock phone from={0} dir={1} accent={accent} />;
  else if (mode === "call")
    body = (
      <View pointerEvents="box-none" style={[styles.row, styles.callRow]}>
        <View pointerEvents="none" style={styles.avatar}>
          <Text style={styles.avatarText}>{c.callerAvatar}</Text>
        </View>
        <View pointerEvents="none" style={styles.caller}>
          <Text numberOfLines={1} style={styles.callerLabel}>
            {c.callerLabel}
          </Text>
          <Text numberOfLines={1} style={styles.callerName}>
            {c.callerName}
          </Text>
        </View>
        <PressScale
          label="挂断"
          to={0.85}
          poke={poke}
          onPress={() => {
            onDecline?.();
            go("idle");
          }}
          style={[styles.callBtn, { backgroundColor: "#ff3b30" }]}
        >
          <Icon source={ICONS.phoneOff} size={20} color="#fff" />
        </PressScale>
        <PressScale
          label="接听"
          to={0.85}
          poke={poke}
          onPress={() => {
            onAccept?.();
            go("oncall");
          }}
          style={[styles.callBtn, { backgroundColor: GREEN }]}
        >
          <Icon source={ICONS.phone} size={20} color="#fff" />
        </PressScale>
      </View>
    );
  else if (mode === "expanded")
    body = (
      <View pointerEvents="box-none" style={styles.player}>
        <View pointerEvents="none" style={styles.track}>
          <Art size={58} radius={14} />
          <View style={styles.meta}>
            <Text numberOfLines={1} style={styles.metaTitle}>
              {c.title}
            </Text>
            <Text numberOfLines={1} style={styles.metaSub}>
              {c.artist}
            </Text>
          </View>
          <Wave t={waveT} accent={accent} />
        </View>
        <View pointerEvents="none" style={styles.progress}>
          <Text style={styles.progressText}>{c.elapsed}</Text>
          <Progress playing={playing} />
          <Text style={styles.progressText}>{c.remaining}</Text>
        </View>
        <View pointerEvents="box-none" style={styles.controls}>
          <PressScale label="上一首" to={0.82} poke={poke} onPress={() => onPrevious?.()} style={styles.ctrlBtn}>
            <Icon source={ICONS.skipBack} size={24} color="#fff" />
          </PressScale>
          <PressScale label={playing ? "暂停" : "播放"} to={0.82} poke={poke} onPress={togglePlay} style={styles.ctrlBtn}>
            <PlayIcon playing={playing} />
          </PressScale>
          <PressScale label="下一首" to={0.82} poke={poke} onPress={() => onNext?.()} style={styles.ctrlBtn}>
            <Icon source={ICONS.skipForward} size={24} color="#fff" />
          </PressScale>
        </View>
      </View>
    );

  // 带按钮的状态把无障碍焦点交给里面的按钮；其余状态整个岛是一个按钮
  const hasButtons = mode === "call" || mode === "expanded";

  return (
    <View style={styles.root} onLayout={(e: LayoutChangeEvent) => setRootW(e.nativeEvent.layout.width)}>
      <Animated.View
        accessible={!hasButtons}
        accessibilityRole="button"
        accessibilityLabel={LABEL[mode](c)}
        accessibilityActions={[
          { name: "activate" },
          { name: "expand", label: "展开" },
          { name: "collapse", label: "收起" },
        ]}
        onAccessibilityAction={(e) => {
          const n = e.nativeEvent.actionName;
          if (n === "activate") go(NEXT[mode]);
          else if (n === "expand") go("expanded");
          else if (n === "collapse") go("idle");
        }}
        style={[styles.island, dark && styles.islandRing, islandStyle]}
      >
        {/* 手势层：只有它接岛本身的轻点 / 长按；内容层不吃触摸，按钮除外 */}
        <GestureDetector gesture={gesture}>
          <View style={StyleSheet.absoluteFill} />
        </GestureDetector>
        <Layer key={mode} w={w} h={s.h} aw={aw} entering={transitions.entering} exiting={transitions.exiting}>
          {body}
        </Layer>
      </Animated.View>
    </View>
  );
}

/** 一种状态的内容：按目标尺寸排好，left 跟着岛的当前宽度居中 */
function Layer({
  w,
  h,
  aw,
  entering,
  exiting,
  children,
}: {
  w: number;
  h: number;
  aw: SharedValue<number>;
  entering: (v: EntryAnimationsValues) => LayoutAnimation;
  exiting: (v: ExitAnimationsValues) => LayoutAnimation;
  children: ReactNode;
}) {
  const st = useAnimatedStyle(() => ({ left: (aw.value - w) / 2 }));
  return (
    <Animated.View pointerEvents="box-none" entering={entering} exiting={exiting} style={[styles.layer, { width: w, height: h }, st]}>
      {children}
    </Animated.View>
  );
}

function Icon({ source, size, color }: { source: ImageSourcePropType; size: number; color: string }) {
  return <Image source={source} style={{ width: size, height: size, tintColor: color }} />;
}

/** 封面：conic-gradient(from 210deg, #ff9a62, #ff3d7f, #7b5cff, #3ec5ff, #ff9a62)；RN 没有 conic，用两层斜向线性渐变近似 */
function Art({ size, radius }: { size: number; radius: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        overflow: "hidden",
        backgroundImage: "linear-gradient(210deg, #ff9a62 0%, #ff3d7f 30%, #7b5cff 62%, #3ec5ff 100%)",
        boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.2)",
      }}
    />
  );
}

/* ---------- 声波：5 根竖条 scaleY 0.25 ↔ 1，0.9s ease-in-out 往返，依次错开 0.17s ---------- */
const WAVE_H = [0.5, 0.9, 0.65, 1, 0.55];

function Wave({ t, accent }: { t: SharedValue<number>; accent: string }) {
  return (
    <View style={styles.wave}>
      {WAVE_H.map((h, i) => (
        <WaveBar key={i} i={i} h={h} t={t} accent={accent} />
      ))}
    </View>
  );
}

function WaveBar({ i, h, t, accent }: { i: number; h: number; t: SharedValue<number>; accent: string }) {
  const st = useAnimatedStyle(() => {
    const period = 0.9;
    const x = (t.value + i * 0.17) / period;
    const cycle = Math.floor(x);
    let p = x - cycle;
    // alternate：奇数轮倒着播，缓动也跟着倒过来
    if (cycle % 2 !== 0) p = 1 - p;
    return { transform: [{ scaleY: 0.25 + 0.75 * cubicBezier(0.42, 0, 0.58, 1, p) }] };
  });
  return <Animated.View style={[styles.waveBar, { height: 16 * h, backgroundColor: accent }, st]} />;
}

/* ---------- 计时 / 通话：每秒一跳，数字上下滚动换位（spring 500 / 34） ---------- */
function Clock({ phone, from, dir, accent }: { phone: boolean; from: number; dir: 1 | -1; accent: string }) {
  const [t, setT] = useState(from);
  useEffect(() => {
    const id = setInterval(() => setT((v) => Math.max(0, v + dir)), 1000);
    return () => clearInterval(id);
  }, [dir]);
  const text = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  const tint = phone ? GREEN : accent;
  const up = dir < 0 ? -10 : 10;
  const roll = useMemo(() => {
    const sp = { stiffness: 500, damping: 34, mass: 1 };
    const entering = (_v: EntryAnimationsValues): LayoutAnimation => {
      "worklet";
      return {
        initialValues: { opacity: 0, transform: [{ translateY: up }] },
        animations: { opacity: withSpring(1, sp), transform: [{ translateY: withSpring(0, sp) }] },
      };
    };
    const exiting = (_v: ExitAnimationsValues): LayoutAnimation => {
      "worklet";
      return {
        initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
        animations: { opacity: withSpring(0, sp), transform: [{ translateY: withSpring(-up, sp) }] },
      };
    };
    return { entering, exiting };
  }, [up]);
  return (
    <View pointerEvents="none" style={[styles.row, styles.clockRow]}>
      <View style={[styles.clockIcon, { backgroundColor: phone ? "rgba(48,209,88,0.22)" : withAlpha(accent, 0.25) }]}>
        <Icon source={phone ? ICONS.phoneFill : ICONS.timer} size={phone ? 16 : 18} color={tint} />
      </View>
      <View style={styles.digits}>
        <Animated.Text key={text} entering={roll.entering} exiting={roll.exiting} style={[styles.digitsText, { color: tint }]}>
          {text}
        </Animated.Text>
      </View>
    </View>
  );
}

/* ---------- 播放器进度条：播放时 12s 线性走到 42%，暂停时 0.3s 回到 30%（与网页一致） ---------- */
function Progress({ playing }: { playing: boolean }) {
  const p = useSharedValue(0.3);
  useEffect(() => {
    p.value = withTiming(playing ? 0.42 : 0.3, { duration: playing ? 12000 : 300, easing: Easing.linear });
  }, [playing, p]);
  const st = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));
  return (
    <View style={styles.bar}>
      <Animated.View style={[styles.barFill, st]} />
    </View>
  );
}

/* ---------- 播放 / 暂停图标互换：旧的缩小淡出、新的放大淡入（spring 600 / 26） ---------- */
const SWAP_SPRING = { stiffness: 600, damping: 26, mass: 1 };
const swapIn = (_v: EntryAnimationsValues): LayoutAnimation => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.4 }] },
    animations: { opacity: withSpring(1, SWAP_SPRING), transform: [{ scale: withSpring(1, SWAP_SPRING) }] },
  };
};
const swapOut = (_v: ExitAnimationsValues): LayoutAnimation => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: { opacity: withSpring(0, SWAP_SPRING), transform: [{ scale: withSpring(0.4, SWAP_SPRING) }] },
  };
};

function PlayIcon({ playing }: { playing: boolean }) {
  const first = useRef(true);
  useEffect(() => {
    first.current = false;
  }, []);
  return (
    <View style={styles.playBox}>
      <Animated.View key={playing ? "pause" : "play"} entering={first.current ? undefined : swapIn} exiting={swapOut} style={styles.playIcon}>
        <Icon source={playing ? ICONS.pause : ICONS.play} size={30} color="#fff" />
      </Animated.View>
    </View>
  );
}

/* ---------- 岛里的小按钮：按下缩小（motion whileTap 默认弹簧 500 / 25） ---------- */
function PressScale({
  label,
  to,
  poke,
  onPress,
  style,
  children,
}: {
  label: string;
  to: number;
  poke: () => void;
  onPress: () => void;
  style: object | object[];
  children: ReactNode;
}) {
  const s = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const sp = { stiffness: 500, damping: 25, mass: 1 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPressIn={() => {
        poke();
        s.value = withSpring(to, sp);
      }}
      onPressOut={() => {
        s.value = withSpring(1, sp);
      }}
      onPress={() => {
        poke();
        onPress();
      }}
    >
      <Animated.View style={[style, st]}>{children}</Animated.View>
    </Pressable>
  );
}

/** 十六进制颜色加透明度（color-mix(in srgb, c x%, transparent)） */
function withAlpha(hex: string, a: number) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const styles = StyleSheet.create({
  root: {
    alignSelf: "stretch",
    alignItems: "center",
  },
  island: {
    overflow: "hidden",
    backgroundColor: "#000",
  },
  islandRing: {
    boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
  },
  layer: {
    position: "absolute",
    top: 0,
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  musicRow: {
    paddingLeft: 7,
    paddingRight: 12,
  },
  wave: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2.5,
    height: 16,
  },
  waveBar: {
    width: 3,
    borderRadius: 2,
  },
  callRow: {
    gap: 12,
    paddingHorizontal: 15,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    backgroundImage: "linear-gradient(135deg, #ffd1dc, #ff8fab)",
  },
  avatarText: {
    fontSize: 26,
  },
  caller: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  callerLabel: {
    fontSize: 12,
    color: "rgba(255,255,255,0.55)",
  },
  callerName: {
    fontSize: 18,
    fontWeight: "600",
    color: "#fff",
  },
  callBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  clockRow: {
    paddingLeft: 12,
    paddingRight: 16,
  },
  clockIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  digits: {
    minWidth: 54,
    height: 24,
  },
  digitsText: {
    position: "absolute",
    right: 0,
    top: 0,
    lineHeight: 24,
    fontSize: 17,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  player: {
    flex: 1,
    justifyContent: "space-between",
    paddingTop: 20,
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
  track: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  meta: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  metaTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#fff",
  },
  metaSub: {
    fontSize: 13,
    color: "rgba(255,255,255,0.55)",
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  progressText: {
    fontSize: 11,
    color: "rgba(255,255,255,0.5)",
    fontVariant: ["tabular-nums"],
  },
  bar: {
    flex: 1,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.18)",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 34,
  },
  ctrlBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  playBox: {
    width: 30,
    height: 30,
  },
  playIcon: {
    position: "absolute",
    left: 0,
    top: 0,
  },
});

/* ---------- 图标：lucide 同款路径栅格化的白色蒙版（96×96），tintColor 上色 ---------- */
const ICONS = {
  phone: { uri: 'data:image/png;base64,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' },
  phoneFill: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAAEMUlEQVR42u2cS2hUVxjHfzdKLGJCwSQrnYkVLHkovloIitJYYzcdRCiMoHRTXLgIWAihdCFYLOjCbUu10NKWxBJCkVqNpSlCSzdWBcdorY+oqRQnhTpJShIy87mIMY9xknvPOXPPuXT+Zzdc/tz/+c7jm+9xPSHaKKMkoCRAC4sL/B4nSTMNVFNe4Ilx0lynl07uW1Ug+SMmHZIVv8hKh8QEWyP/p4RkJCgyknBFQGuAuZ9th1YXBCQUX39SghUreDMushgpKjS20xCNPLB5jB7Ten2o4Fj4h9C0BeLc1b4VcrwS9qE6/cpJA5daGUl7S2iHEb5mewLqjfA12NsDYwWdhiAYZ4ktCywywldubwmNR92dHou6gMhbIBN1AYNRF/BPyQKWBTyMuoD+qAu4VxJgBdPOnEeGZdp8Y7xkywJCygDfoM3/xNcM8KVsCrhigO8nmwJ+1WbLctqmgJS2Q3fablwox29aXEN8YDs/0KvFdSD8+Z8r4LwG0/t04kB+YEApsDsie22F1+dG484pzEEfr9HhSo6sS4HjMn0u+EI8y5n9zfLAq3AjV12xwATdwSeB4y6lWb9WYNlJiytLCOAmrwbmucM6/nMl0X1KgWc1R92xQDUPFWLMObZquiLGLJBW2gdlfKGZYzOWqUfqJad0I3e5kKmfHGcVs8VtrghoUhQwITvcEID8oCjhiWywlamfjU1cUtxWj9nKn/YLnn5XcuwAaviRFTbvgSnUckM5THWfneFYYb7sfD8nlHnj/MJG2xaAZfSxUpk7w57ix4nmr48Y5qAGdyU9tC3wTIw2zjPAaMFjZowBemgnHuQmnjk6RQ9dUlGAOSbfyIRubd7CAmokrSnhD2l6AW/STG2en8siIbrIyglZOovzkDJTa3AByCeij9vS8pxvr9ZkJIILWCopMYEeWS9Io4xosWRm7gW/PscaeWJEQk6+kpvaLB1+fKG52E03Hm5gRm2e/zq57/gInElNJlWq1w8r/dUsDpr9uRLk1WNdYLsTAv6a8ne9gC0oL/Mz6x0Q8Lw2zwvcQ1PNReockOCpdnCkeZM7RLoF5RHbuBHtHppHbLcXUDfTBJTmDS5Gu4vpX1pcuBfKtI6y/RxBXCm3UcVuvqTS3jHqGZjANXSHX7Wufg/k4xav82l0l9AUEnxOVTQtMIkzNIRfbGO2GfQxSd5mICRnrkjdrN9Tx8eMFl1AunjtuMN8SJ1yZNsvrhe3n7ifd9isVDjiF73+Q4s6o0nOKqYLF4oNxYOGVdRHvZySUcMClMIqOqjmXd5TKGDAR9NpiAm5bfKZDBpYPgqhRXNjseySk4qFbS8M7oazhPKxjrdopimgHzvEPs4UyxdS8wMa2cIG1tK4YOV8jm9pzy/s9Bz5NIlHLatYRS0rqWI5VVRSzhLKyc7/+Qev9G2VkoD/uYCnoBHf5WURonIAAAAASUVORK5CYII=' },
  phoneOff: { uri: 'data:image/png;base64,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' },
  timer: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAAEVUlEQVR42u1bMWsUQRT+7rikCG6EQMqgpshB7tBCzkhAhKuEFIdFSJWQLqfJD7DSNoR0iYJFyoDEys7qiEjEmAimUDibKCGVcGg2hGBOP4tYmLuZ25ndt5u7dd92w+7M982+mffmvTcporMljYTA+UpGsK8BzGIEjsdbLjbxGHtio1LquUOXpuLyjtS4KUrN/idcsHj/EMMyf0FqDcxZwQcuYLa9FvEN6y9Gkl1IlMBmBF8oJVnEf2UP4zi0gD8uZQlSlDRkc7hhYMjeYVnOkKUSZy4hkBBICMTmPHAqPcgiiywuoRcOHAAuXBzgK6qoooqjdiXQhVsooohCyz7r2EIFFbzGSTsdaApc4jfayDcusSAxdtAO0pzgDv3KB04wfX4EUpxklUGlykmmzoPAVW5QSjZ4NVoC3VxknZJS5yK7oyIwyG2GIdscjIJAid8ZlnxnKeywygyeGFvvGly4ABw46DP85jfu42l4duChwSzucoVTvE7nzJcOr3OKK9w16OFhWCr0yGPgfS4w79lLngvcl6NgDn/GYzefZsa4rwynPSzIjDSBEn9pB6ux7MOepllmTdvnL9PlbLpx6neeNfb7Nob9XGuxIw1KEejW7vvHvBfYHbvHY61d6JYhsKhVnVERX3ZUq0qLEgSuaZyGfebEcgs5zb5U9/aRvD3ODc3sy8E/pVDTuHmpYAQmNbo/Kgr/VJHUa2EyCIG0ZrcOtnQHOM91rnOeAw3LWW1h0v4JTGg2ziDwx/7JpTXmytSb6oR/AjtK7e8PAL/Enw3pvoEzdqGmPHj6JFBQzkdZED5Jzp95o6wcs+CPwJK9RlrDJ9cNVt2SHwJdykDJtDD8RgLgtDII02VPoKg0Xhlh+I0qBGaURq2o61l/uioq2lZR9xU9K+E5ujTJpsdNsbtVQzQeJ7I3innIC8/+T44pjzzN8sZWhXp4ojgsSsPX+fzNB88T9tipUFYRoq2IKs8JxvFC81VFEYTO2uUHVK+/igi+eiQBAh8jgq8eyZLAZUXbZyv4Y77hq0e6ZEfAUYapbJLez3zDB1zUmtp6gxJwIVE/ZAJfPZoTLYGRQPAFCIQh5vAF0qzGM2BcDWQH31gDwiKw3FB8Yzv7gQkcNLX0WVE4Wz90iLuW8PsMELXME39VtA3hvQWIlxjGLG4CeGtd6DpkiKgFgaqiLWdFANjDA58rM2eIqIUKqV6/Hdl+dducgC7F1IMfTX/nC65ERGC3yZWp46K6ykL3B46wpfCP8pHAzys8sS1dkYjekKm8/6lICEwZovE4Usoe6mGRfrI61EcXVjF9xMIq8oEts8yZWGArjNCi9yMaWgwjuOuV9BMN7oYTXm/1iIfXw0lw6POV4gmOjk8xxSDJ1/Fp1hgkumNQatDxxR4xKLeJQcGTScVcm5ectWnR339WdtmGha//YelxDIq/Y1B+H4sLEDG4gtIWl4Bs7UDbXcNKscMvwiX3iRMCAeUPqUCpL//RfYsAAAAASUVORK5CYII=' },
  skipBack: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAAC5UlEQVR42u2bvW/TQBiHfwGkZEAMiLX5oFKWIsSfgMTYJB1YMrJXqsQAnZp2ZA1MTEgdUgkJq0XJkKX/BC0stFXVMCFUyUgEQsOPwUJKnG/7PvyKe71ZOeeeu+fsO/u9FCE7rsEBOAAH4AAcgANwAA5AKUARHnz48FA0Xp8cNtHGF/TQQwdtPEduRgmGjyIv+S8uWSSMHQU22Gc4+mwwN7nU6ClvqLhnqPJp1viDk+I7H88P4A8V9Y1Uf5WfOT36XJ8XIBy6K5/nPueLcvIAMtyaIk44vnEpWQCzxQnHbnIA8jzg4nE12gc2HmRpbOMTKhFKXkfV/pN4FR+xg0zE0g/tAhRwgCbuxrjCfXsAaWzhOJI4g3EnfCLF0blF6BeKxKljWcmVUuZ7oIB9NBVV3/h0OhBnTd8f3NB8x6nrann9PRDccZYhckWWQU3BHceaQgbE0dcDhsTRA2BQHB0KGRVHdQ8YF0clgBVx1ClkSRw1AFm8stfy8QGqeI1bct+NPkUjCdWPuh6ooqFonRB7PRAFIIsPFltfwYLmRTLkidoDOZxa/aoQuweqyfoosnhlHgGyAVaSBbD4GPiteR2tfQxQukJfpQMcSQc4lD6IxT/IzvFWdg8AORzhpuTJ3Dme4I/sZI932JCsUBAVvMFtmQoF8R4P0JSdL3SBMko4lZ3w1MIKdvBT4hjA0KvFlyhJGwODcWZPJnWTAksyqf5OXEAdZXkKDcpUMSuTjnmlUZn0pRrokslYqoEhmfQuTQzIZCJbRa1MFrJVtMpkanUbyNSNfZ0eZuZO68xaLETKVRyMjt2sxTOsoYSTGFc4tp+12MI9bEe+Mx3aVSiuTP3RRHxZqcd7yUv+rrE7d/V9ZpOYfj+vTH1WZG+A2Ej2FpTpMvnjW388gL1NQHnu8mpM2++Nc38yAFikR58+PaPVD44lPmOLF+zyFztsc3PaDiaCY2ajcDv5HIADcAAOwAE4AAfw3wD8Bf5CIRpCJVgnAAAAAElFTkSuQmCC' },
  skipForward: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAAC50lEQVR42u2bv2/TQBTHv6mCmomJDSUhRcrSgvgTkNhImw5dgK0TA1ICA3RqgI2/o0OKELKakg5Z+lfQshQQtEwVVDKogajtY4iCFMdxHPvu3T1xz6Plu/v4fezzj3cZguyYgQNwAA7AATgAB+AAHIA2gCKeoYMj9NDDN3SwhgL7GMvw4MOHh3LIXhq/FalJ5xSMc2pSicC2lenkX98nVA7uH3/gCv2kcXFKDZplAvCGevbiAjwKOffDcUAVFgB/qFc/HsASxYstuqYdIBgxAPL0neLGKa1TzjaADZouDuiuTQD5ifaHRUubTBMARueBe4kmtyo+oIFZGyay2wlbyuEl9lExD3AzRWtzaKOFklmAKylbrGIP63wyZWj02UJFfEQdO0paCo4nw/M0eh1tbHHIpPNxeplDJl0KqZPJkELDMmm8M/G8kVWxhwZyMhVKK5NxhTTLxP1Sr1wmToWSyWSRQlpkMvddSJFMZhSaRiYrFQrKVJCbgX74eIjXMjPQj8to4onkDPT7fRCahQkZsAcA8HEDX2UqNBDplWSFAOACpZEcCMoAMIP70v/Q3JEOMC/7GgDOcEnyNZDg9NkGcCwd4L10gF3pE9kcvki+iN+MDF9UBn5hIQRATAYusDr9+bcJoI63SQ7LWjH4H1jFttxymzZuJR2+eYBPWMQSDmUWPP3GC8yn/ZOWNShODZ/TN5M1JE5N0T9MAwopEcdcBt6hrkIcMwAKxeFXSLE43BlQLg4ngBZxuBTSJg5PBjSKox9AszhRCvVSt9nVL05UBo5xNVWL23isX5yoDOwjzT/HRSxzDj8MYDexOM+xwCVOVPl9MWHha8me0uPNqUuPK3bVThcCJe9R0aWGfcXfoGpMjVoMazkSAYBqshdA9LPgRy5Bydm9BKV/LWyG5OGMNhjWbShYBDS4qa5Rh47oD3XpkHboKeUZBz9A8Mgnn7zR4VPI12m4lXwOwAE4AAfgAByAA/hvAP4C6vS3RorSO/IAAAAASUVORK5CYII=' },
  play: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAAC5klEQVR42u2cu2uTYRSHn4RahDoJcZK2xEFsDYJrnQI61ixCvGyilIKtijjYtS0u/gEWdCk02KVxrWgXnQoOajM4iEoztV7wAi0kOQ4dxCTNd03ec/A73/qSvE/O+X7v5ZyTlGDb0iQACUACkAAkABGsL+D4YYrkGSVDg23esMYTPjslEP/PkJSkLs1Wk0XJCq4e/0PH5afsZzsyKwO6AaakIZ1tUy7pBRj3nP6evZTTGgEGOwRPs9VlQTLaAEoSzL7JtPTpARhuozzeVpGzvQHwXsiKoRa7E6xSJqthJc6H/uzzVJhjwPVCVpVo1mV5TXkeKXfpj/wrvWKK165CqD+GbxljnYdkLO9G01znPdOBN4+e5h1C8V5bVLjJM8vngRFWWYlTXl0caApUmI1LXnsdQn+tyl2WLAPEJK9uz8RjrLMQTV5dH+rTXIsmr25DKAZ51XKtElpeNd0LFcLsXrWEUGh51QcQUF51Xi0GkFetd6O+5VVnCAWQV+0AAGVusGkZAL5ylbLl/MBhVpi07AGABhdZtgwAv8jx0XKK6RD3bXsAGhxr9oGtJF+aovUsZd46wKjtdwBqHEgy9U5tyzrAhnWA59YXsiyfLHtguXn6tjzwg1xrZYwdDwgT7Qp70mamf4cSMRQ8uQqeifbTt+GBp+T2m75+gArnKHQqatMM8J1bnPK6dNf6DjR4zL3WnY8VANOXu1WucMZ/6k+XB3Z5wDy/6WLha3fl8jYf6HLlbpLkCyuXWj3gWy51ApguNahyOYhc6vJACLnUBBBKLrUAmC45iySXrj3Q4BEzUeQyPMAOB20Xvm7rkMvwAG8jyeU8x+Mo7YsCsEb4DPsIM/GoPRGq1welFqJmfaNXDRB+Bi3abkFBjsoX201ASMHn9JW2YSHIpGcrkOpGOAS50LEVcU57K+JeQ1a7ZtC6LLlsBvVOcPxrQxTJc5IjwBbveEGpNWvSS0sl/yuRACQACUAC8F8D/AGY8XecaXrwBgAAAABJRU5ErkJggg==' },
  pause: { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAQAAABIkb+zAAABH0lEQVR42u3bsQ2DQAyFYUNBlUzCHkzCPtcwDRJjsAArHC1ymiAlSAh8wiiQ3+6f8ynHhRTOVK5duQAAAAAAgFMApQTpJYqudJRegpSn5cyle7rQRifdU5M2WrjnfPS+j9+ppbqV0UflmAGNWqtxzTECyp1f+vcBKN1yFr39ENcJN1UutVuO+Raqkm63yi1nUdnm63SUR8LgUZ5OOWZA6h+GzCmHVwkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgeMCYlDu65ZgBQ9LgwS3HDGiTBrduOWLd5PvxNaw/WIS7wSri5ZdB5zMctNe4OjJqr2H7zB6W8+7tPTJ+iQEAAADgzoAXOJQ3sgX2CDkAAAAASUVORK5CYII=' },
} satisfies Record<string, ImageSourcePropType>;
