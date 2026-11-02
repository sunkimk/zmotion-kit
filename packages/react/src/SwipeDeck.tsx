"use client";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { motion, animate, motionValue, useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { sfx } from "./sfx";
import { useEnd } from "./adaptive";
import "./SwipeDeck.css";

type Props = {
  threshold?: number;
  rotation?: number;
  depth?: number;
  stamps?: boolean;
  theme?: "light" | "dark";
  sound?: boolean;
};

type Place = { title: string; sub: string; rating: string; dist: string; a: string; b: string; sun: [number, number]; hills: [string, string] };

const CARDS: Place[] = [
  { title: "京都", sub: "日本 · 秋叶季", rating: "4.9", dist: "1,820 km", a: "#FFB38A", b: "#D6336C", sun: [210, 120], hills: ["#B8235A", "#7A1340"] },
  { title: "雷克雅未克", sub: "冰岛 · 极光", rating: "4.8", dist: "7,900 km", a: "#7FE3E8", b: "#2B3A9A", sun: [90, 96], hills: ["#27408F", "#141F5C"] },
  { title: "大理", sub: "云南 · 苍山洱海", rating: "4.7", dist: "2,100 km", a: "#D4F29A", b: "#13866F", sun: [220, 90], hills: ["#1A8A6C", "#0B5747"] },
  { title: "里斯本", sub: "葡萄牙 · 黄色电车", rating: "4.8", dist: "9,600 km", a: "#FFE08A", b: "#F06A1D", sun: [80, 130], hills: ["#E0621C", "#A8430F"] },
  { title: "开普敦", sub: "南非 · 桌山", rating: "4.6", dist: "11,800 km", a: "#D3C2FF", b: "#5634B8", sun: [200, 110], hills: ["#5A37B8", "#33207A"] },
];

// 叠放：每往后一层缩小 5%、下移 12px
const LAYER_SCALE = 0.05;
const LAYER_Y = 12;
const SETTLE = { type: "spring", stiffness: 420, damping: 34 } as const;
/** 卡片离场的弹簧：手机甩出屏幕、大屏飞进「已喜欢」都用这一条 */
const FLY = { stiffness: 160, damping: 26 } as const;
/** 计数、缩略图落位时的小回弹 */
const POP = { type: "spring", stiffness: 520, damping: 18 } as const;

/** 已喜欢的一张：serial 是牌堆里的序号（卡面按它取），arrived 表示飞行的卡已经落进右栏 */
type Liked = { serial: number; arrived: boolean };
/** 大屏右栏：wide 时喜欢的卡飞进右栏；thumbs 是每一行缩略图的位置，飞行中每帧去量，右栏挪动也能跟上 */
type Dock = { wide: boolean; thumbs: Map<number, HTMLElement> };

export default function SwipeDeck({ threshold = 110, rotation = 14, depth = 3, stamps = true, theme = "light", sound = true }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const topRef = useRef(0);
  const [flying, setFlying] = useState<number[]>([]);
  // 喜欢过的卡（新的在前）；顶部计数就是它的长度，手机端不显示列表但照样记，切到大屏时右栏直接有内容
  const [liked, setLiked] = useState<Liked[]>([]);
  const likes = liked.length;
  // 多端：iPad / 桌面（宽 ≥ 600）按钮挪到牌堆两侧，右边多一栏「已喜欢」，喜欢的卡缩小飞进去（布局在 CSS 容器查询里）
  // 量宽度用一个没有内边距、撑满根元素整宽的探针：根元素左右各有 20px 内边距，直接量根元素时
  // 首次（clientWidth 含内边距）和之后（ResizeObserver 的内容宽）会差 40px
  const probeRef = useRef<HTMLDivElement>(null);
  const end = useEnd(probeRef);
  const wide = end !== "phone";
  const listRef = useRef<HTMLUListElement>(null);
  const dock = useRef<Dock>({ wide, thumbs: new Map() });
  dock.current.wide = wide;

  // pos：牌堆的「当前位置」（可以是小数，弹簧过渡）；lift：拖动顶卡时下面的卡跟着升起的量
  const pos = useMotionValue(0);
  const lift = useMotionValue(0);
  const dragX = useMotionValue(0);

  const layers = Math.max(1, Math.round(depth));
  const serials = [...flying, ...Array.from({ length: layers + 1 }, (_, i) => top + i)];

  /** 顶卡离场：dir 方向，v 是离手速度（px/s） */
  const swipe = (dir: 1 | -1) => {
    const next = topRef.current + 1;
    topRef.current = next;
    setFlying((f) => [...f, next - 1]);
    setTop(next);
    if (dir > 0) {
      // 大屏：先在右栏顶部占一行，卡片飞到这一行的缩略图位置后才算落位；手机没有右栏，直接算落位
      const flies = dock.current.wide;
      const add = () => setLiked((l) => [{ serial: next - 1, arrived: !flies }, ...l]);
      // 大屏要马上量到新行缩略图的位置（飞行起步要按离手速度算），所以同步提交这一行
      if (flies) flushSync(add);
      else add();
      if (flies && listRef.current?.scrollTop) listRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
    // 把拖动时已经升起的量并进 pos，再弹到下一张，画面连续
    pos.jump(pos.get() + lift.get());
    lift.jump(0);
    animate(pos, next, SETTLE);
    animate(dragX, 0, SETTLE);
    if (sound) sfx.whoosh();
  };

  const landed = (serial: number) => {
    setFlying((f) => f.filter((s) => s !== serial));
    setLiked((l) => (l.some((i) => i.serial === serial && !i.arrived) ? l.map((i) => (i.serial === serial ? { ...i, arrived: true } : i)) : l));
  };

  // 按钮：顶卡带着一点上扬甩出去
  const flingRef = useRef<((dir: 1 | -1) => void) | null>(null);

  const likeScale = useTransform(dragX, [0, threshold], [1, 1.14]);
  const nopeScale = useTransform(dragX, [-threshold, 0], [1.14, 1]);
  const likeFill = useTransform(dragX, [threshold * 0.2, threshold], [0, 1]);
  const nopeFill = useTransform(dragX, [-threshold, -threshold * 0.2], [1, 0]);

  return (
    <div className="swipe-deck" data-theme={theme} ref={rootRef}>
      <div className="swipe-deck__probe" ref={probeRef} aria-hidden />
      <StatusBar />
      <header className="swipe-deck__head">
        <span>发现</span>
        <motion.small key={likes} initial={likes ? { scale: 1.25 } : false} animate={{ scale: 1 }} transition={POP}>
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden>
            <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z" />
          </svg>
          {likes}
        </motion.small>
      </header>

      {/* 手机端 body / main 都是 display: contents，排版和原来一样；大屏才变成「牌堆区 + 右栏」两列 */}
      {/* --sd-peek 放在 body 上：牌堆底部露出叠层的高度，大屏两侧按钮也要按它对齐卡片中心 */}
      <div className="swipe-deck__body" style={{ "--sd-peek": `${layers * LAYER_Y + 6}px` } as React.CSSProperties}>
        <div className="swipe-deck__main">
          <div className="swipe-deck__stack">
            {serials.map((serial) => (
              <Card
                key={serial}
                serial={serial}
                isTop={serial === top}
                isFlying={serial < top}
                layers={layers}
                pos={pos}
                lift={lift}
                dragX={dragX}
                rootRef={rootRef}
                threshold={threshold}
                rotation={rotation}
                stamps={stamps}
                sound={sound}
                onSwipe={swipe}
                onLanded={landed}
                dock={dock}
                flingRef={serial === top ? flingRef : undefined}
              />
            ))}
          </div>

          <div className="swipe-deck__actions">
            <motion.button
              type="button"
              aria-label="跳过"
              style={{ scale: nopeScale }}
              whileTap={{ scale: 0.9 }}
              transition={{ type: "spring", stiffness: 600, damping: 30 }}
              onClick={() => flingRef.current?.(-1)}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
              </svg>
              <motion.i style={{ opacity: nopeFill }}>
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                  <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
                </svg>
              </motion.i>
            </motion.button>
            <motion.button
              type="button"
              aria-label="喜欢"
              className="is-like"
              style={{ scale: likeScale }}
              whileTap={{ scale: 0.9 }}
              transition={{ type: "spring", stiffness: 600, damping: 30 }}
              onClick={() => flingRef.current?.(1)}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
                <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z" />
              </svg>
              <motion.i style={{ opacity: likeFill }}>
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
                  <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z" />
                </svg>
              </motion.i>
            </motion.button>
          </div>
        </div>

        {wide && (
          <aside className="swipe-deck__liked" aria-label="已喜欢">
            <div className="swipe-deck__liked-head">
              <span>已喜欢</span>
              <small>{likes}</small>
            </div>
            <ul className="swipe-deck__liked-list" ref={listRef}>
              {likes === 0 && <li className="swipe-deck__liked-empty">右滑喜欢，卡片会收在这里</li>}
              {liked.map((item) => (
                <LikedRow key={item.serial} item={item} thumbs={dock.current.thumbs} />
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}

/** 右栏的一行：新喜欢的一行先撑开高度占位，卡片落进来时缩略图轻轻弹一下 */
function LikedRow({ item, thumbs }: { item: Liked; thumbs: Map<number, HTMLElement> }) {
  const card = CARDS[item.serial % CARDS.length];
  // 挂上时还没落位的是「新飞来的」：要撑开、要弹；手机端喜欢的、切到大屏时已经在的，直接显示
  const fresh = useRef(!item.arrived).current;
  return (
    <motion.li
      className="swipe-deck__liked-row"
      initial={fresh ? { height: 0, opacity: 0 } : false}
      animate={{ height: "auto", opacity: 1 }}
      transition={SETTLE}
    >
      <div className="swipe-deck__liked-inner">
        <span
          className="swipe-deck__liked-thumb"
          ref={(el) => {
            if (!el) return;
            thumbs.set(item.serial, el);
            return () => {
              if (thumbs.get(item.serial) === el) thumbs.delete(item.serial);
            };
          }}
        >
          {item.arrived && (
            <motion.span initial={fresh ? { scale: 0.88 } : false} animate={{ scale: 1 }} transition={POP}>
              <Scene card={card} />
            </motion.span>
          )}
        </span>
        <span className="swipe-deck__liked-text">
          <strong>{card.title}</strong>
          <small>{card.sub}</small>
        </span>
      </div>
    </motion.li>
  );
}

function Card({
  serial,
  isTop,
  isFlying,
  layers,
  pos,
  lift,
  dragX,
  rootRef,
  threshold,
  rotation,
  stamps,
  sound,
  onSwipe,
  onLanded,
  dock,
  flingRef,
}: {
  serial: number;
  isTop: boolean;
  isFlying: boolean;
  layers: number;
  pos: MotionValue<number>;
  lift: MotionValue<number>;
  dragX: MotionValue<number>;
  rootRef: React.RefObject<HTMLDivElement | null>;
  threshold: number;
  rotation: number;
  stamps: boolean;
  sound: boolean;
  onSwipe: (dir: 1 | -1) => void;
  onLanded: (serial: number) => void;
  dock: React.RefObject<Dock>;
  flingRef?: React.RefObject<((dir: 1 | -1) => void) | null>;
}) {
  const card = CARDS[serial % CARDS.length];
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  // 只有飞进右栏时才会变小；平时一直是 1
  const scale = useMotionValue(1);
  const slotRef = useRef<HTMLDivElement>(null);
  // 抓在上半部分往右拖是顺时针，抓在下半部分是逆时针，像真的捏着一张卡
  const grab = useMotionValue(1);
  const rotate = useTransform(() => (x.get() / threshold) * rotation * grab.get());
  const likeOpacity = useTransform(x, [threshold * 0.2, threshold], [0, 1]);
  const nopeOpacity = useTransform(x, [-threshold, -threshold * 0.2], [1, 0]);
  const likeScale = useTransform(x, [threshold * 0.2, threshold], [0.8, 1]);
  const nopeScale = useTransform(x, [-threshold, -threshold * 0.2], [1, 0.8]);

  // 在牌堆里的相对层级：0 是顶卡，负数是已经飞走的
  const rel = useTransform(() => serial - pos.get() - lift.get());
  const poseY = useTransform(rel, (r) => Math.max(0, r) * LAYER_Y);
  const poseScale = useTransform(rel, (r) => 1 - Math.max(0, r) * LAYER_SCALE);
  const poseOpacity = useTransform(rel, (r) => Math.min(1, Math.max(0, layers - r)));

  const drag = useRef<{ id: number; sx: number; sy: number; x0: number; y0: number; k: number; over: boolean } | null>(null);
  const gone = useRef(false);
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);

  useMotionValueEvent(x, "change", (v) => {
    if (!isTop || gone.current) return;
    dragX.set(v);
    lift.set(Math.min(1, Math.abs(v) / threshold) * 0.85);
    const d = drag.current;
    if (d) {
      const over = Math.abs(v) > threshold;
      if (over !== d.over) {
        d.over = over;
        if (sound) sfx.tick();
      }
    }
  });

  const fling = (dir: 1 | -1, vx: number, vy: number) => {
    const w = rootRef.current?.offsetWidth ?? 400;
    const v = dir * Math.max(Math.abs(vx), 1100);
    gone.current = true;
    onSwipe(dir);
    if (dir > 0 && dock.current.wide) {
      flyToDock(vx, vy);
      return;
    }
    animate(x, dir * (w * 1.15 + 120), { type: "spring", velocity: v, stiffness: 160, damping: 26, restDelta: 4 }).then(() => onLanded(serial));
    animate(y, y.get() + vy * 0.18, { type: "spring", velocity: vy, stiffness: 160, damping: 26 });
  };

  /**
   * 大屏喜欢：同一条离场弹簧，但终点换成右栏顶部那一行的缩略图——边飞边缩小、倾斜回正。
   * 终点每帧现量（右栏新行在撑开、前一张还在飞、画布宽度在变都跟得上），所以用 0→1 的进度驱动：
   * px 管横向、缩放和回正，py 管纵向，各自带上离手速度，路线和手机上甩出去一样有惯性。
   */
  const flyToDock = (vx: number, vy: number) => {
    const from = { x: x.get(), y: y.get(), g: grab.get() };
    let to: { x: number; y: number; s: number } | null = null;
    const measure = () => {
      const slot = slotRef.current;
      const thumb = dock.current.thumbs.get(serial);
      if (!slot || !thumb || !thumb.isConnected) return to;
      const r = slot.getBoundingClientRect();
      const t = thumb.getBoundingClientRect();
      if (!r.width || !t.width) return to;
      // 外框可能被缩放：屏幕像素换回组件像素
      const k = r.width / slot.offsetWidth || 1;
      // 按面积缩到和缩略图差不多大（卡片比缩略图细长，落位时缩略图弹一下盖过差别）
      const s = Math.sqrt((t.width * t.height) / (r.width * r.height));
      // 卡片的 transform-origin 是 50% 60%，缩放后卡片中心会往上偏 0.1 个卡高
      const ox = r.left + r.width / 2;
      const oy = r.top + r.height * 0.6;
      to = {
        x: (t.left + t.width / 2 - ox) / k,
        y: (t.top + t.height / 2 - oy) / k + (r.height * 0.1 * s) / k,
        s,
      };
      return to;
    };
    const px = motionValue(0);
    const py = motionValue(0);
    const unX = px.on("change", (p) => {
      const t = measure();
      if (!t) return;
      x.set(from.x + (t.x - from.x) * p);
      scale.set(1 + (t.s - 1) * p);
      grab.set(from.g * (1 - Math.min(1, p)));
    });
    const unY = py.on("change", (p) => {
      const t = measure();
      if (t) y.set(from.y + (t.y - from.y) * p);
    });
    // 离手速度换算成进度速度（px/s ÷ 要走的距离）；按钮触发时没有速度，给个和手机一样的起步劲
    const first = measure();
    const rate = (v: number, d: number) => (Math.abs(d) > 1 ? Math.max(-6, Math.min(6, v / d)) : 0);
    const vpx = first ? Math.max(0, rate(Math.max(Math.abs(vx), 1100), first.x - from.x)) : 2;
    const vpy = first ? rate(vy, first.y - from.y) : 0;
    animate(py, 1, { type: "spring", velocity: vpy, ...FLY, restDelta: 0.002 }).then(() => unY());
    animate(px, 1, { type: "spring", velocity: vpx, ...FLY, restDelta: 0.004 }).then(() => {
      unX();
      onLanded(serial);
    });
  };

  if (flingRef) {
    flingRef.current = (dir) => {
      if (drag.current || gone.current) return;
      grab.set(1);
      fling(dir, 0, -260);
    };
  }

  // 拖动挂在 window 上：指针移出卡片、或者 pointer capture 不可用时也不会卡住
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isTop || gone.current || drag.current || e.button !== 0) return;
    const el = e.currentTarget;
    x.stop();
    y.stop();
    const r = el.getBoundingClientRect();
    // 外框可能被缩放（手机预览），屏幕位移换算回组件自身的像素，卡片才会紧跟手指
    const k = el.offsetWidth ? r.width / el.offsetWidth || 1 : 1;
    grab.set(e.clientY < r.top + r.height / 2 ? 1 : -1);
    const d = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: x.get(), y0: y.get(), k, over: Math.abs(x.get()) > threshold };
    drag.current = d;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.id) return;
      x.set(d.x0 + (ev.clientX - d.sx) / d.k);
      y.set(d.y0 + ((ev.clientY - d.sy) / d.k) * 0.7);
    };
    const off = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      detach.current = null;
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== d.id) return;
      off();
      drag.current = null;
      release();
    };
    detach.current = off;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const release = () => {
    const vx = x.getVelocity();
    const vy = y.getVelocity();
    const dx = x.get();
    // 够远、或者甩得够快（且方向一致）就飞走
    const dir = Math.abs(vx) > 650 ? Math.sign(vx) : Math.abs(dx) > threshold ? Math.sign(dx) : 0;
    if (dir && (Math.sign(dx) === dir || Math.abs(dx) < 8)) {
      fling(dir as 1 | -1, vx, vy);
    } else {
      animate(x, 0, { type: "spring", velocity: vx, stiffness: 520, damping: 30 });
      animate(y, 0, { type: "spring", velocity: vy, stiffness: 520, damping: 30 });
      animate(lift, 0, SETTLE);
    }
  };

  return (
    <motion.div
      ref={slotRef}
      className="swipe-deck__slot"
      style={{ y: poseY, scale: poseScale, opacity: poseOpacity, zIndex: 1000 - serial }}
      aria-hidden={!isTop}
    >
      <motion.div
        className="swipe-deck__card"
        data-top={isTop || undefined}
        data-flying={isFlying || undefined}
        style={{ x, y, rotate, scale }}
        onPointerDown={onPointerDown}
      >
        <Scene card={card} />
        {stamps && (
          <>
            <motion.span className="swipe-deck__stamp is-like" style={{ opacity: likeOpacity, scale: likeScale }}>
              喜欢
            </motion.span>
            <motion.span className="swipe-deck__stamp is-nope" style={{ opacity: nopeOpacity, scale: nopeScale }}>
              跳过
            </motion.span>
          </>
        )}
        <div className="swipe-deck__info">
          <div className="swipe-deck__chips">
            <span>★ {card.rating}</span>
            <span>{card.dist}</span>
          </div>
          <strong>{card.title}</strong>
          <span>{card.sub}</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Scene({ card }: { card: Place }) {
  const id = `sd-${CARDS.indexOf(card)}`;
  const [sx, sy] = card.sun;
  return (
    <svg className="swipe-deck__scene" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={card.a} />
          <stop offset="1" stopColor={card.b} />
        </linearGradient>
        <radialGradient id={`${id}-sun`}>
          <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="0.35" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-scrim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.42" />
        </linearGradient>
      </defs>
      <rect width="300" height="400" fill={`url(#${id}-sky)`} />
      <circle cx={sx} cy={sy} r="90" fill={`url(#${id}-sun)`} />
      <circle cx={sx} cy={sy} r="26" fill="#fff" opacity="0.85" />
      <path d="M0 250L48 214L96 236L150 186L208 230L254 204L300 226V400H0Z" fill={card.hills[0]} opacity="0.55" />
      <path d="M0 292Q60 256 120 280T240 270T300 262V400H0Z" fill={card.hills[0]} opacity="0.85" />
      <path d="M0 330Q80 300 160 322T300 310V400H0Z" fill={card.hills[1]} />
      <rect width="300" height="400" fill={`url(#${id}-scrim)`} />
    </svg>
  );
}

function StatusBar() {
  return (
    <div className="swipe-deck__status" aria-hidden>
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
