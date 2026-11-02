"use client";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, animate, type MotionValue } from "motion/react";
import { sfx } from "./sfx";
import { useEnd } from "./adaptive";
import "./PullToRefresh.css";

type Props = {
  threshold?: number;
  resistance?: number;
  indicator?: "arc" | "ios" | "arrow";
  color?: string;
  theme?: "light" | "dark";
  sound?: boolean;
};

type Phase = "idle" | "armed" | "refreshing" | "done";
type Media = "sunset" | "snow" | "film" | "vinyl" | "tiles";
type Post = { id: number; name: string; avatar: string; hue: [string, string]; time: string; text: string; media?: Media };

const SEED: Post[] = [
  { id: 1, name: "林小满", avatar: "🌿", hue: ["#BBF7D0", "#34D399"], time: "3 分钟前", text: "今天的晚霞像被谁打翻了一整瓶橘子汽水。", media: "sunset" },
  { id: 2, name: "阿哲", avatar: "🎧", hue: ["#C7D2FE", "#818CF8"], time: "12 分钟前", text: "新歌单整理好了，适合写代码的深夜，一共 42 首。" },
  { id: 3, name: "Momo", avatar: "🐱", hue: ["#FDE68A", "#F59E0B"], time: "半小时前", text: "猫主子第一次见到雪，整只猫当场僵住。", media: "snow" },
  { id: 4, name: "周末去哪儿", avatar: "⛰️", hue: ["#A5F3FC", "#06B6D4"], time: "1 小时前", text: "推荐三条适合新手的城郊徒步路线，全程不超过 8 公里。" },
  { id: 5, name: "设计日报", avatar: "✏️", hue: ["#FBCFE8", "#EC4899"], time: "2 小时前", text: "弹簧动画的刚度和阻尼到底怎么调？一张图讲清楚。" },
  { id: 6, name: "陈一一", avatar: "☕️", hue: ["#FED7AA", "#EA580C"], time: "3 小时前", text: "换了新的手冲壶，这杯耶加雪菲有明显的柑橘味。" },
  { id: 7, name: "小森", avatar: "📷", hue: ["#DDD6FE", "#8B5CF6"], time: "昨天", text: "胶片冲出来了，最喜欢这张逆光。", media: "film" },
];

const INCOMING: Omit<Post, "id" | "time">[] = [
  { name: "今日天气", avatar: "🌤️", hue: ["#BAE6FD", "#38BDF8"], text: "午后转晴，最高 24°，适合出门走走。" },
  { name: "阿哲", avatar: "🎧", hue: ["#C7D2FE", "#818CF8"], text: "刚刚收藏了你的歌单，品味可以。", media: "vinyl" },
  { name: "林小满", avatar: "🌿", hue: ["#BBF7D0", "#34D399"], text: "楼下的桂花开了，整条街都是甜的。" },
  { name: "设计日报", avatar: "✏️", hue: ["#FBCFE8", "#EC4899"], text: "本周最佳微交互合集已上线，第 3 个绝了。", media: "tiles" },
];

/** 刷新时列表停在这个高度，给指示器留位置 */
const HOLD = 64;
/** 回弹：接近临界阻尼，像 iOS 列表一样干脆落位，不来回晃 */
const SPRING = { type: "spring", stiffness: 380, damping: 38, restDelta: 0.2 } as const;
const LABEL: Record<Phase, string> = { idle: "下拉刷新", armed: "松手刷新", refreshing: "正在刷新", done: "已更新 1 条" };
/** 按下后挪动不超过这么多（屏幕像素）算点按，用来在 iPad / 桌面上选中一条动态 */
const TAP_SLOP = 6;
/** 详情切换：和列表回弹同一条弹簧，旧内容淡得更快，连点时不会叠在一起 */
const SWAP = { y: SPRING, opacity: { duration: 0.2, ease: [0.33, 0.55, 0.2, 1] } } as const;

export default function PullToRefresh({
  threshold = 80,
  resistance = 0.55,
  indicator = "arc",
  color = "#0A84FF",
  theme = "light",
  sound = true,
}: Props) {
  const [posts, setPosts] = useState(SEED);
  const [phase, setPhase] = useState<Phase>("idle");
  const [freshId, setFreshId] = useState(0);
  const [refreshed, setRefreshed] = useState(false);
  // iPad / 桌面右侧详情显示哪一条；默认第一条（带配图）。跨断点时保留，回到大屏还是同一条
  const [selected, setSelected] = useState(SEED[0].id);
  const selectedRef = useRef(selected);

  const rootRef = useRef<HTMLDivElement>(null);
  // 多端：手机只有列表；iPad / 桌面左边列表、右边详情（布局在 CSS 容器查询里，这里只管点按选中）
  const end = useEnd(rootRef);
  const split = end !== "phone";
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    lastY: number;
    startRaw: number;
    max: number;
    dim: number;
    k: number;
    /** 按下时手指下面那条动态；挪动过或按下时列表还在滑，就不算点按 */
    tap: number | null;
  } | null>(null);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const timers = useRef<number[]>([]);
  const nextId = useRef(100);
  const live = useRef({ threshold, resistance, sound, phase, split });
  live.current = { threshold, resistance, sound, phase, split };

  const y = useMotionValue(0);
  const progress = useTransform(y, (v) => Math.min(Math.max(v / live.current.threshold, 0), 1));
  const indicatorY = useTransform(y, (v) => Math.max(v, 0) / 2 - HOLD / 2);
  const indicatorOpacity = useTransform(y, [6, 36], [0, 1]);
  const indicatorScale = useTransform(progress, [0, 1], [0.6, 1]);
  // 往上滚进内容后，大标题下方出现一条分隔线
  const headLine = useTransform(y, [-24, 0], [1, 0]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // 拖动画布改宽度（含跨断点）时列表会变矮：已经滚过新的底部就弹回底部，不留空白
  useEffect(() => {
    const vp = viewportRef.current;
    const list = listRef.current;
    if (!vp || !list) return;
    const ro = new ResizeObserver(() => {
      if (drag.current) return;
      const { max } = measure();
      if (y.get() < -max - 1) {
        anim.current?.stop();
        anim.current = animate(y, -max, SPRING);
      }
    });
    ro.observe(vp);
    ro.observe(list);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
  const setPhaseLive = (p: Phase) => {
    live.current.phase = p;
    setPhase(p);
  };

  const measure = () => {
    const vp = viewportRef.current;
    const list = listRef.current;
    if (!vp || !list) return { max: 0, dim: 600 };
    return { max: Math.max(0, list.offsetHeight - vp.clientHeight), dim: Math.max(vp.clientHeight, 520) };
  };
  /** 刷新中列表的「顶」是 HOLD，平时是 0 */
  const top = () => (live.current.phase === "refreshing" ? HOLD : 0);
  // iOS 式橡皮筋：越拉越沉，永远拉不到 dim
  const rubber = (over: number, dim: number) => (1 - 1 / ((over * live.current.resistance) / dim + 1)) * dim;
  const unrubber = (d: number, dim: number) => (dim / live.current.resistance) * (1 / (1 - Math.min(d, dim - 1) / dim) - 1);

  const settle = (max: number) => {
    const v = y.get();
    const t = top();
    if (v > t) anim.current = animate(y, t, SPRING);
    else if (v < -max) anim.current = animate(y, -max, SPRING);
    else
      anim.current = animate(y, v, {
        type: "inertia",
        velocity: y.getVelocity(),
        min: -max,
        max: t,
        power: 0.8,
        timeConstant: 325,
        bounceStiffness: 400,
        bounceDamping: 40,
        restDelta: 0.5,
      });
  };

  const refresh = () => {
    const p = live.current.phase;
    if (p === "refreshing") return;
    setPhaseLive("refreshing");
    if (!drag.current) {
      anim.current?.stop();
      // 点按钮时就算已经滚进内容里，也先回到顶部再刷新
      anim.current = animate(y, HOLD, y.get() < -200 ? { type: "spring", stiffness: 170, damping: 26 } : SPRING);
    }
    later(() => {
      const src = INCOMING[nextId.current % INCOMING.length];
      const id = nextId.current++;
      setPosts((list) => [{ ...src, id, time: "刚刚" }, ...list]);
      setFreshId(id);
      setRefreshed(true);
      setPhaseLive("done");
      if (live.current.sound) sfx.pop();
      // 手指还按着：「顶」从 HOLD 变回 0，换算一下起点，列表不跳
      const d = drag.current;
      if (d) {
        const cur = y.get();
        const raw = cur > 0 ? unrubber(cur, d.dim) : cur;
        d.startRaw = raw - (d.lastY - d.startY) / d.k;
      }
      if (!drag.current && y.get() > 0) {
        anim.current?.stop();
        anim.current = animate(y, 0, { ...SPRING, stiffness: 300, damping: 34, delay: 0.32 });
      }
      later(() => {
        if (live.current.phase === "done") setPhaseLive("idle");
      }, 1300);
    }, 1200);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    // 列表还在惯性滑动时按下只是停住，不选中（和系统列表一样）
    const coasting = Math.abs(y.getVelocity()) > 40;
    const post = (e.target as HTMLElement).closest<HTMLElement>("[data-post]");
    anim.current?.stop();
    const { max, dim } = measure();
    const cur = y.get();
    const t = top();
    let raw = cur;
    if (cur > t) raw = t + unrubber(cur - t, dim);
    else if (cur < -max) raw = -max - unrubber(-max - cur, dim);
    // 预览被缩放时（首页卡片、手机外框），把屏幕像素换回组件像素，列表才跟手
    const vp = e.currentTarget;
    const k = vp.getBoundingClientRect().height / vp.offsetHeight || 1;
    const tap = post && !coasting ? Number(post.dataset.post) : null;
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastY: e.clientY, startRaw: raw, max, dim, k, tap };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    d.lastY = e.clientY;
    if (d.tap !== null && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > TAP_SLOP) d.tap = null;
    const raw = d.startRaw + (e.clientY - d.startY) / d.k;
    const t = top();
    let v = raw;
    if (raw > t) v = t + rubber(raw - t, d.dim);
    else if (raw < -d.max) v = -d.max - rubber(-d.max - raw, d.dim);
    y.set(v);
    const p = live.current.phase;
    if (p === "refreshing") return;
    const armed = v >= live.current.threshold;
    if (armed && p !== "armed") {
      setPhaseLive("armed");
      if (live.current.sound) sfx.tick();
    } else if (!armed && p === "armed") setPhaseLive("idle");
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (live.current.phase === "armed") return refresh();
    settle(d.max);
    // 点按（没怎么挪）：iPad / 桌面切换右侧详情；手机和原来一样什么都不做
    if (d.tap !== null && e.type === "pointerup" && live.current.split) select(d.tap);
  };

  const select = (id: number) => {
    if (id === selectedRef.current) return;
    selectedRef.current = id;
    setSelected(id);
    if (live.current.sound) sfx.tap();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (drag.current) return;
    const { max } = measure();
    anim.current?.stop();
    const t = top();
    y.set(Math.min(t, Math.max(-max, Math.min(y.get(), t) - e.deltaY)));
  };

  // iPad / 桌面上键盘 Tab 到看不见的动态时，浏览器会去滚视口本身：把这段滚动换算到列表的 y 上，视口始终停在 0
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const vp = e.currentTarget;
    const dy = vp.scrollTop;
    if (!dy) return;
    vp.scrollTop = 0;
    if (drag.current) return;
    const { max } = measure();
    anim.current?.stop();
    y.set(Math.min(top(), Math.max(-max, y.get() - dy)));
  };

  const busy = phase === "refreshing";
  const current = posts.find((p) => p.id === selected) ?? posts[0];

  return (
    <div ref={rootRef} className="pull-to-refresh" data-theme={theme} style={{ "--ptr": color } as React.CSSProperties}>
      {/* iPad 的通栏状态栏（手机用列表顶部那条，桌面不显示；都由 CSS 控制） */}
      <StatusBar wide />
      <div className="pull-to-refresh__inner">
        <header className="pull-to-refresh__head">
          <StatusBar />
          <div className="pull-to-refresh__title">
            <div>
              <h2>动态</h2>
              <span className="pull-to-refresh__sub">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.small
                    key={refreshed ? "r" : "h"}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.24, ease: [0.33, 0.55, 0.2, 1] }}
                  >
                    {refreshed ? "刚刚更新" : "你关注的 12 位朋友有新动态"}
                  </motion.small>
                </AnimatePresence>
              </span>
            </div>
            <motion.button
              className={`pull-to-refresh__btn${busy ? " is-busy" : ""}`}
              aria-label="刷新"
              whileTap={{ scale: 0.9 }}
              transition={{ duration: 0.09 }}
              onClick={refresh}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
              </svg>
            </motion.button>
          </div>
          <motion.i className="pull-to-refresh__rule" style={{ opacity: headLine }} />
        </header>

        <div
          ref={viewportRef}
          className="pull-to-refresh__viewport"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onScroll={onScroll}
        >
          <motion.div className="pull-to-refresh__indicator" style={{ y: indicatorY, opacity: indicatorOpacity }} aria-live="polite">
            <motion.span className="pull-to-refresh__icon" style={{ scale: indicatorScale }}>
              <IndicatorIcon kind={indicator} phase={phase} progress={progress} />
            </motion.span>
            <span className="pull-to-refresh__label">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={phase}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2, ease: [0.33, 0.55, 0.2, 1] }}
                >
                  {LABEL[phase]}
                </motion.span>
              </AnimatePresence>
            </span>
          </motion.div>

          <motion.div ref={listRef} className="pull-to-refresh__list" style={{ y }}>
            <AnimatePresence initial={false}>
              {posts.map((p) => (
                <motion.div
                  key={p.id}
                  className="pull-to-refresh__row"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  transition={{ height: { type: "spring", stiffness: 320, damping: 34 }, opacity: { duration: 0.3, delay: 0.12 } }}
                >
                  <motion.article
                    className={`pull-to-refresh__post${p.id === freshId ? " is-fresh" : ""}${p.id === selected ? " is-selected" : ""}`}
                    data-post={p.id}
                    {...(split && {
                      role: "button",
                      tabIndex: 0,
                      "aria-pressed": p.id === selected,
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        select(p.id);
                      },
                    })}
                    initial={p.id >= 100 ? { scale: 0.96, y: -8 } : false}
                    animate={{ scale: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 380, damping: 26, delay: 0.08 }}
                  >
                    <span className="pull-to-refresh__avatar" style={{ background: `linear-gradient(135deg, ${p.hue[0]}, ${p.hue[1]})` }} aria-hidden>
                      {p.avatar}
                    </span>
                    <div className="pull-to-refresh__body">
                      <div className="pull-to-refresh__meta">
                        <strong>{p.name}</strong>
                        <time>{p.time}</time>
                      </div>
                      <p>{p.text}</p>
                      {p.media && <div className="pull-to-refresh__media" data-kind={p.media} />}
                    </div>
                  </motion.article>
                </motion.div>
              ))}
            </AnimatePresence>
            <div className="pull-to-refresh__end">没有更多了</div>
          </motion.div>
        </div>
      </div>

      {/* 右侧详情：只在 iPad / 桌面显示（手机由 CSS 隐藏）；刷新不影响它，换一条时淡入、轻轻上移 */}
      <aside className="pull-to-refresh__detail" aria-label="动态详情">
        <AnimatePresence initial={false}>
          <motion.article
            key={current.id}
            className="pull-to-refresh__full"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8, transition: { y: SPRING, opacity: { duration: 0.12 } } }}
            transition={SWAP}
          >
            <header className="pull-to-refresh__author">
              <span
                className="pull-to-refresh__avatar"
                style={{ background: `linear-gradient(135deg, ${current.hue[0]}, ${current.hue[1]})` }}
                aria-hidden
              >
                {current.avatar}
              </span>
              <div>
                <strong>{current.name}</strong>
                <time>{current.time}</time>
              </div>
            </header>
            <p>{current.text}</p>
            {current.media && <div className="pull-to-refresh__media" data-kind={current.media} />}
          </motion.article>
        </AnimatePresence>
      </aside>
    </div>
  );
}

function StatusBar({ wide = false }: { wide?: boolean }) {
  return (
    <div className={`pull-to-refresh__status${wide ? " pull-to-refresh__status--wide" : ""}`} aria-hidden>
      <span>9:41</span>
      <svg viewBox="0 0 72 12" width="72" height="12" fill="currentColor">
        <rect x="0" y="7.5" width="3" height="4" rx="1" />
        <rect x="4.5" y="5.5" width="3" height="6" rx="1" />
        <rect x="9" y="3" width="3" height="8.5" rx="1" />
        <rect x="13.5" y="0.5" width="3" height="11" rx="1" />
        <path d="M28.6 3.6a8.6 8.6 0 0 1 11.8 0M31 6.3a5 5 0 0 1 7 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="34.5" cy="9.6" r="1.6" />
        <rect x="46.5" y="0.5" width="22" height="11" rx="3.2" fill="none" stroke="currentColor" strokeOpacity="0.4" />
        <rect x="48.5" y="2.5" width="18" height="7" rx="1.8" />
        <path d="M70 4.2v3.6c.8-.3 1.3-1 1.3-1.8s-.5-1.5-1.3-1.8z" opacity="0.45" />
      </svg>
    </div>
  );
}

function IndicatorIcon({ kind, phase, progress }: { kind: string; phase: Phase; progress: MotionValue<number> }) {
  if (phase === "done") return <DoneCheck />;
  if (kind === "ios") return <IosSpinner phase={phase} progress={progress} />;
  if (phase === "refreshing") return <SpinningArc />;
  if (kind === "arrow") return <Arrow armed={phase === "armed"} progress={progress} />;
  return <ProgressArc armed={phase === "armed"} progress={progress} />;
}

const POP = { type: "spring", stiffness: 520, damping: 22 } as const;

function ProgressArc({ armed, progress }: { armed: boolean; progress: MotionValue<number> }) {
  const length = useTransform(progress, [0, 1], [0.03, 0.8]);
  const rotate = useTransform(progress, [0, 1], [-180, 0]);
  return (
    <motion.svg viewBox="0 0 28 28" width="28" height="28" style={{ rotate }} animate={{ scale: armed ? 1.12 : 1 }} transition={POP}>
      <circle cx="14" cy="14" r="10" className="pull-to-refresh__track" />
      <g transform="rotate(-90 14 14)">
        <motion.circle cx="14" cy="14" r="10" className="pull-to-refresh__arc" style={{ pathLength: length }} />
      </g>
    </motion.svg>
  );
}

function SpinningArc() {
  return (
    <motion.svg viewBox="0 0 28 28" width="28" height="28" className="pull-to-refresh__spinning" initial={{ scale: 1.12 }} animate={{ scale: 1 }} transition={POP}>
      <circle cx="14" cy="14" r="10" className="pull-to-refresh__track" />
      <circle cx="14" cy="14" r="10" className="pull-to-refresh__arc" pathLength={1} strokeDasharray="0.7 0.3" />
    </motion.svg>
  );
}

function Arrow({ armed, progress }: { armed: boolean; progress: MotionValue<number> }) {
  const y = useTransform(progress, [0, 1], [-6, 0]);
  return (
    <motion.svg viewBox="0 0 28 28" width="28" height="28" className="pull-to-refresh__arrow" style={{ y }} animate={{ rotate: armed ? 180 : 0 }} transition={POP}>
      <path d="M14 6v15M8 15l6 6 6-6" />
    </motion.svg>
  );
}

function IosSpinner({ phase, progress }: { phase: Phase; progress: MotionValue<number> }) {
  const spinning = phase === "refreshing";
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" className={`pull-to-refresh__ios${spinning ? " is-spinning" : ""}`}>
      {Array.from({ length: 8 }, (_, i) => (
        <Tick key={i} i={i} spinning={spinning} progress={progress} />
      ))}
    </svg>
  );
}

function Tick({ i, spinning, progress }: { i: number; spinning: boolean; progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [i / 8, (i + 1) / 8], [0, 1]);
  return (
    <g transform={`rotate(${i * 45} 14 14)`}>
      <motion.line x1="14" y1="3.5" x2="14" y2="8.5" style={{ opacity: spinning ? 1 - i * 0.11 : opacity }} />
    </g>
  );
}

function DoneCheck() {
  return (
    <motion.svg viewBox="0 0 28 28" width="28" height="28" className="pull-to-refresh__done" initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={POP}>
      <circle cx="14" cy="14" r="11" />
      <motion.path d="M9 14.5l3.2 3.2L19 11" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, delay: 0.06, ease: [0.33, 0.55, 0.2, 1] }} />
    </motion.svg>
  );
}
