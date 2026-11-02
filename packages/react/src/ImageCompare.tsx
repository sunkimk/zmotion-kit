"use client";
import { memo, useEffect, useId, useRef, useState } from "react";
import { motion, useMotionValue, useMotionValueEvent, useSpring, useTransform, animate } from "motion/react";
import { sfx } from "./sfx";
import "./ImageCompare.css";

type Props = {
  start?: number;
  orientation?: "horizontal" | "vertical";
  handle?: "circle" | "bar" | "line";
  showLabels?: boolean;
  theme?: "light" | "dark";
  sound?: boolean;
};

const clamp = (v: number) => Math.min(100, Math.max(0, v));
/** 拖出边界时的橡皮筋：越往外越拉不动，最多再走 R% */
const RUBBER = 4;
const rubber = (v: number) => {
  if (v < 0) return -RUBBER * (1 - Math.exp(v / RUBBER / 2.5));
  if (v > 100) return 100 + RUBBER * (1 - Math.exp(-(v - 100) / RUBBER / 2.5));
  return v;
};

/**
 * 揭开用的是两层反向平移（外层移走、内层移回来），全程只改 transform，
 * 不重绘图片；分割线跟手带一点柔和的弹簧。
 */
export default function ImageCompare({
  start = 50,
  orientation = "horizontal",
  handle = "circle",
  showLabels = true,
  theme = "light",
  sound = true,
}: Props) {
  const horizontal = orientation !== "vertical";
  const frameRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLSpanElement>(null);
  const prevStart = useRef(start);
  const [active, setActive] = useState(false);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  const target = useMotionValue(clamp(start));
  const pos = useSpring(target, { stiffness: 420, damping: 34, mass: 0.6 });
  const shown = useTransform(pos, (p) => clamp(p));
  const outer = useTransform(shown, (p) => `${p - 100}%`);
  const inner = useTransform(shown, (p) => `${100 - p}%`);
  const at = useTransform(pos, (p) => `${p}%`);
  const beforeOpacity = useTransform(pos, [6, 24], [0, 1]);
  const afterOpacity = useTransform(pos, [76, 94], [1, 0]);

  // 读屏数值直接写到 DOM，拖动时不触发 React 渲染
  useMotionValueEvent(target, "change", (v) => {
    const el = handleRef.current;
    if (!el) return;
    const n = String(Math.round(clamp(v)));
    if (el.getAttribute("aria-valuenow") !== n) {
      el.setAttribute("aria-valuenow", n);
      el.setAttribute("aria-valuetext", `修图前占 ${n}%`);
    }
  });

  useEffect(() => {
    // 进场时轻轻晃一下，提示可以拖
    const s = clamp(start);
    const a = s > 85 ? -1 : 1;
    const c = animate(target, [s, clamp(s + 8 * a), clamp(s - 4 * a), s], { duration: 1.4, delay: 0.6, ease: "easeInOut", times: [0, 0.38, 0.72, 1] });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (prevStart.current === start) return;
    prevStart.current = start;
    target.stop();
    target.set(clamp(start));
  }, [start, target]);

  const drag = useRef<(() => void) | null>(null);
  useEffect(() => () => drag.current?.(), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    target.stop();
    // 只在按下时读一次布局；拖动中不再测量
    const r = frameRef.current!.getBoundingClientRect();
    const toPct = (ev: PointerEvent | React.PointerEvent) =>
      horizontal ? ((ev.clientX - r.left) / r.width) * 100 : ((ev.clientY - r.top) / r.height) * 100;
    const id = e.pointerId;
    let edge = clamp(target.get()) % 100 === 0;

    const set = (raw: number) => {
      target.set(rubber(raw));
      const atEdge = raw <= 0 || raw >= 100;
      if (atEdge && !edge && sound) sfx.tick();
      edge = atEdge;
    };
    const move = (ev: PointerEvent) => ev.pointerId === id && set(toPct(ev));
    const end = (ev?: PointerEvent) => {
      if (ev && ev.pointerId !== id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      drag.current = null;
      setActive(false);
      // 松手：橡皮筋弹回边界
      target.set(clamp(target.get()));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    drag.current = () => end();

    setActive(true);
    set(toPct(e));
    if (sound) sfx.tap();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 5;
    const map: Record<string, number> = { ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step, Home: -100, End: 100 };
    if (!(e.key in map)) return;
    e.preventDefault();
    target.stop();
    target.set(clamp(target.get() + map[e.key]));
    if (sound) sfx.tick();
  };

  const axis = horizontal ? "x" : "y";

  return (
    <div className="image-compare" data-theme={theme} data-orientation={horizontal ? "h" : "v"}>
      <div
        ref={frameRef}
        className={`image-compare__frame${active ? " is-active" : ""}`}
        style={{ touchAction: horizontal ? "pan-y" : "pan-x" }}
        onPointerDown={onPointerDown}
      >
        <div className="image-compare__layer is-after">
          <Scene uid={`${uid}a`} />
        </div>
        <motion.div className="image-compare__layer is-before" style={{ [axis]: outer }}>
          <motion.div className="image-compare__layer is-inner" style={{ [axis]: inner }}>
            <Scene uid={`${uid}b`} />
            <span className="image-compare__haze" />
          </motion.div>
        </motion.div>

        {showLabels && (
          <>
            <motion.span className="image-compare__label is-before" style={{ opacity: beforeOpacity }}>
              修图前
            </motion.span>
            <motion.span className="image-compare__label is-after" style={{ opacity: afterOpacity }}>
              修图后
            </motion.span>
          </>
        )}

        <motion.div className={`image-compare__divider is-${handle}`} style={horizontal ? { left: at } : { top: at }}>
          <span className="image-compare__line" />
          <motion.span
            ref={handleRef}
            className="image-compare__handle"
            role="slider"
            tabIndex={0}
            aria-label="拖动对比修图前后"
            aria-orientation={horizontal ? "horizontal" : "vertical"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clamp(start))}
            onKeyDown={onKeyDown}
            animate={{ scale: active ? 1.1 : 1 }}
            transition={{ duration: 0.25, ease: [0.28, 1.3, 0.36, 1] }}
          >
            {handle === "circle" && (
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
              </svg>
            )}
            {handle === "bar" && (
              <span className="image-compare__grip" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            )}
          </motion.span>
        </motion.div>
      </div>
    </div>
  );
}

const Scene = memo(function Scene({ uid }: { uid: string }) {
  const id = (n: string) => `${uid}-${n}`;
  const url = (n: string) => `url(#${id(n)})`;
  return (
    <svg className="image-compare__scene" viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id={id("sky")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24307e" />
          <stop offset="0.38" stopColor="#8f4bb8" />
          <stop offset="0.6" stopColor="#ef6f8a" />
          <stop offset="0.78" stopColor="#ff9b5c" />
          <stop offset="1" stopColor="#ffd27a" />
        </linearGradient>
        <radialGradient id={id("glow")}>
          <stop offset="0" stopColor="#fff3c4" stopOpacity="0.95" />
          <stop offset="0.3" stopColor="#ffc46b" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff8a5b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id("far")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b267c9" />
          <stop offset="1" stopColor="#e88aa8" />
        </linearGradient>
        <linearGradient id={id("mid")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b2f91" />
          <stop offset="1" stopColor="#8a4aa6" />
        </linearGradient>
        <linearGradient id={id("lake")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb170" />
          <stop offset="0.4" stopColor="#b3549e" />
          <stop offset="1" stopColor="#22296b" />
        </linearGradient>
        <linearGradient id={id("hill")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c6b5a" />
          <stop offset="1" stopColor="#0b2f33" />
        </linearGradient>
      </defs>

      <rect width="800" height="500" fill={url("sky")} />
      {[
        [80, 40], [160, 90], [250, 30], [340, 70], [120, 140], [700, 50], [640, 110], [470, 40], [760, 120],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 3 ? 1.2 : 1.8} fill="#fff" opacity={0.7} />
      ))}
      <circle cx="560" cy="300" r="190" fill={url("glow")} />
      <circle cx="560" cy="300" r="48" fill="#fff4cf" />
      <g fill="#fff" opacity="0.28">
        <ellipse cx="190" cy="190" rx="110" ry="14" />
        <ellipse cx="260" cy="176" rx="70" ry="11" />
        <ellipse cx="660" cy="200" rx="90" ry="10" />
      </g>
      <path d="M300 150q9-9 18 0q9-9 18 0M350 128q6-6 12 0q6-6 12 0M268 170q5-5 10 0q5-5 10 0" fill="none" stroke="#3a1f5c" strokeWidth="2.4" strokeLinecap="round" />

      <path d="M0 300L70 246L140 280L230 196L320 268L410 214L500 262L600 186L700 248L800 214V340H0Z" fill={url("far")} />
      <path d="M0 336L70 292L150 322L230 276L320 334L400 302L480 338L570 290L660 334L740 302L800 322V362H0Z" fill={url("mid")} />

      <rect y="358" width="800" height="142" fill={url("lake")} />
      <g fill="#ffe7a6">
        <rect x="508" y="366" width="104" height="4" rx="2" opacity="0.85" />
        <rect x="522" y="380" width="76" height="4" rx="2" opacity="0.7" />
        <rect x="532" y="396" width="56" height="3" rx="1.5" opacity="0.55" />
        <rect x="540" y="412" width="40" height="3" rx="1.5" opacity="0.4" />
        <rect x="546" y="428" width="28" height="2" rx="1" opacity="0.3" />
      </g>

      <path d="M0 500V372Q110 346 220 392Q300 428 350 500Z" fill={url("hill")} />
      <path d="M800 500V392Q700 376 630 424Q590 456 572 500Z" fill={url("hill")} />
      <g fill="#0a2a24">
        {[
          [40, 360, 1], [78, 352, 1.3], [118, 366, 0.9], [160, 372, 1.15], [205, 388, 0.85], [728, 382, 1.2], [770, 376, 0.95],
        ].map(([x, y, s], i) => (
          <path key={i} d={`M${x} ${y - 70 * s}L${x + 18 * s} ${y}H${x - 18 * s}Z`} />
        ))}
      </g>
    </svg>
  );
});
