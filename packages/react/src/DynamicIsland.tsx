"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Phone, PhoneOff, Timer, SkipBack, SkipForward, Play, Pause, Signal, Wifi, BatteryFull, Flashlight, Camera } from "lucide-react";
import { sfx } from "./sfx";
import { endOf } from "./adaptive";
import "./DynamicIsland.css";

type Props = {
  bounce?: number;
  duration?: number;
  autoCycle?: boolean;
  accent?: string;
  theme?: "light" | "dark";
  sound?: boolean;
};

type Mode = "idle" | "music" | "call" | "timer" | "oncall" | "expanded";

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
const LABEL: Record<Mode, string> = {
  idle: "灵动岛，轻点切换状态，长按展开",
  music: "正在播放：晚风与海",
  call: "来电：妈妈",
  timer: "计时器",
  oncall: "通话中",
  expanded: "播放器",
};

export default function DynamicIsland({
  bounce = 0.3,
  duration = 0.55,
  autoCycle = true,
  accent = "#FF9F0A",
  theme = "light",
  sound = true,
}: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [pressing, setPressing] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [rootW, setRootW] = useState(390);
  const rootRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef(0);
  const longPressed = useRef(false);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRootW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const userAt = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  /** user=false 是自动轮播：不出声，免得每隔两秒响一下 */
  const go = (next: Mode, user = true) => {
    if (user) userAt.current = Date.now();
    setMode(next);
    if (!sound || !user) return;
    if (next === "call") sfx.pop();
    else if (next === "expanded") sfx.whoosh();
    else sfx.tap();
  };

  useEffect(() => {
    if (!autoCycle || pressing) return;
    let t = 0;
    const schedule = (ms: number) => {
      t = window.setTimeout(() => {
        const quiet = Date.now() - userAt.current;
        // 刚被人操作过、或预览被暂停（卡片滚出视野）时先不切
        if (quiet < USER_HOLD || document.documentElement.hasAttribute("data-paused")) return schedule(Math.max(500, USER_HOLD - quiet));
        go(NEXT[modeRef.current], false);
      }, ms);
    };
    schedule(AUTO_DELAY[mode]);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCycle, mode, pressing]);

  useEffect(() => () => clearTimeout(pressTimer.current), []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    userAt.current = Date.now();
    longPressed.current = false;
    setPressing(true);
    clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      setPressing(false);
      go(mode === "expanded" ? "music" : "expanded");
    }, 450);
  };
  const endPress = () => {
    clearTimeout(pressTimer.current);
    setPressing(false);
  };
  const onClick = () => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    go(NEXT[mode]);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go(NEXT[mode]);
    } else if (e.key === "ArrowDown") go("expanded");
    else if (e.key === "Escape" || e.key === "ArrowUp") go("idle");
  };

  // 多端适配：岛的尺寸和变形各端一致；iPad / 桌面（≥ 600）只换锁屏排版（见 style.css）
  const phone = endOf(rootW) === "phone";
  const s = SIZE[mode];
  const w = Math.min(s.w, rootW - 20);
  // 状态栏两端离岛太近就先藏起来；iPad 的状态栏铺满整宽，离得远，一般不用藏
  const wide = ((phone ? Math.min(rootW, 430) : rootW) - w) / 2 < 84;
  const spring = { type: "spring", bounce, duration } as const;

  return (
    <div ref={rootRef} className="dynamic-island" data-theme={theme} style={{ "--di": accent } as React.CSSProperties}>
      <div className="dynamic-island__wall" aria-hidden>
        <i className="is-a" />
        <i className="is-b" />
        <i className="is-c" />
      </div>

      <motion.div className="dynamic-island__status" animate={{ opacity: wide ? 0 : 1 }} transition={{ duration: 0.2 }} aria-hidden>
        <span>9:41</span>
        <span className="dynamic-island__sys">
          <Signal size={15} strokeWidth={2.6} />
          <Wifi size={15} strokeWidth={2.6} />
          <BatteryFull size={20} strokeWidth={2} />
        </span>
      </motion.div>

      <motion.div
        className="dynamic-island__island"
        role="button"
        tabIndex={0}
        aria-label={LABEL[mode]}
        initial={false}
        animate={{ width: w, height: s.h, borderRadius: s.r, scale: pressing ? 1.06 : 1 }}
        transition={{ ...spring, scale: { type: "spring", stiffness: pressing ? 120 : 500, damping: pressing ? 20 : 22 } }}
        onPointerDown={onPointerDown}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <AnimatePresence initial={false}>
          <motion.div
            key={mode}
            className="dynamic-island__content"
            style={{ width: w, height: s.h, left: `calc(50% - ${w / 2}px)` }}
            initial={{ opacity: 0, scale: 0.86, filter: "blur(8px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)", transition: { duration: duration * 0.6, delay: duration * 0.18, ease: [0.2, 0.8, 0.3, 1] } }}
            exit={{ opacity: 0, scale: 0.9, filter: "blur(6px)", transition: { duration: Math.min(0.16, duration * 0.4) } }}
          >
            <Content mode={mode} playing={playing} setPlaying={setPlaying} go={go} sound={sound} poke={() => (userAt.current = Date.now())} />
          </motion.div>
        </AnimatePresence>
      </motion.div>

      <div className="dynamic-island__lock" aria-hidden>
        <small>10月29日 星期四</small>
        <strong>9:41</strong>
      </div>

      {/* iPad 锁屏没有手电筒，只留相机（CSS 按宽度隐藏，跨断点不重建节点） */}
      <div className="dynamic-island__quick" aria-hidden>
        <span className="is-torch">
          <Flashlight size={22} />
        </span>
        <span className="is-camera">
          <Camera size={22} />
        </span>
      </div>
      <span className="dynamic-island__home" aria-hidden />
    </div>
  );
}

function Content({
  mode,
  playing,
  setPlaying,
  go,
  sound,
  poke,
}: {
  mode: Mode;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  go: (m: Mode) => void;
  sound: boolean;
  poke: () => void;
}) {
  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    poke();
  };

  if (mode === "idle") return null;

  if (mode === "music")
    return (
      <div className="dynamic-island__row">
        <span className="dynamic-island__art is-sm" />
        <Wave playing={playing} />
      </div>
    );

  if (mode === "timer") return <Clock icon="timer" from={299} dir={-1} />;
  if (mode === "oncall") return <Clock icon="phone" from={0} dir={1} />;

  if (mode === "call")
    return (
      <div className="dynamic-island__row is-call">
        <span className="dynamic-island__avatar">👩🏻</span>
        <div className="dynamic-island__caller">
          <small>手机来电</small>
          <b>妈妈</b>
        </div>
        <motion.button
          className="dynamic-island__btn is-decline"
          aria-label="挂断"
          whileTap={{ scale: 0.85 }}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            go("idle");
          }}
        >
          <PhoneOff size={20} />
        </motion.button>
        <motion.button
          className="dynamic-island__btn is-accept"
          aria-label="接听"
          whileTap={{ scale: 0.85 }}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            if (sound) sfx.success();
            go("oncall");
          }}
        >
          <Phone size={20} />
        </motion.button>
      </div>
    );

  // expanded：完整播放器
  return (
    <div className="dynamic-island__player">
      <div className="dynamic-island__track">
        <span className="dynamic-island__art is-lg" />
        <div className="dynamic-island__meta">
          <b>晚风与海</b>
          <small>Zmotion Radio</small>
        </div>
        <Wave playing={playing} />
      </div>
      <div className="dynamic-island__progress">
        <small>1:24</small>
        <span><motion.i initial={{ width: "30%" }} animate={{ width: playing ? "42%" : "30%" }} transition={{ duration: playing ? 12 : 0.3, ease: "linear" }} /></span>
        <small>-2:21</small>
      </div>
      <div className="dynamic-island__controls">
        <motion.button aria-label="上一首" whileTap={{ scale: 0.82 }} onPointerDown={stop} onClick={stop}>
          <SkipBack size={24} fill="currentColor" />
        </motion.button>
        <motion.button
          aria-label={playing ? "暂停" : "播放"}
          className="is-main"
          whileTap={{ scale: 0.82 }}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            if (sound) sfx.tap();
            poke();
            setPlaying(!playing);
          }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={playing ? "pause" : "play"}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              transition={{ type: "spring", stiffness: 600, damping: 26 }}
            >
              {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
            </motion.span>
          </AnimatePresence>
        </motion.button>
        <motion.button aria-label="下一首" whileTap={{ scale: 0.82 }} onPointerDown={stop} onClick={stop}>
          <SkipForward size={24} fill="currentColor" />
        </motion.button>
      </div>
    </div>
  );
}

function Wave({ playing }: { playing: boolean }) {
  return (
    <span className={`dynamic-island__wave${playing ? "" : " is-paused"}`}>
      {[0.5, 0.9, 0.65, 1, 0.55].map((h, i) => (
        <i key={i} style={{ height: `${h * 100}%`, animationDelay: `${i * -0.17}s` }} />
      ))}
    </span>
  );
}

function Clock({ icon, from, dir }: { icon: "timer" | "phone"; from: number; dir: 1 | -1 }) {
  const [t, setT] = useState(from);
  useEffect(() => {
    const id = window.setInterval(() => setT((v) => Math.max(0, v + dir)), 1000);
    return () => clearInterval(id);
  }, [dir]);
  const text = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  return (
    <div className={`dynamic-island__row is-clock${icon === "phone" ? " is-phone" : ""}`}>
      <span className="dynamic-island__clock-icon">{icon === "timer" ? <Timer size={18} strokeWidth={2.4} /> : <Phone size={16} fill="currentColor" />}</span>
      <span className="dynamic-island__digits">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={text}
            initial={{ y: dir < 0 ? -10 : 10, opacity: 0, filter: "blur(2px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            exit={{ y: dir < 0 ? 10 : -10, opacity: 0, filter: "blur(2px)" }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
          >
            {text}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}
