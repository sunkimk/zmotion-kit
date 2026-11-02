"use client";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, animate, useMotionValue, useTransform, useReducedMotion, type MotionValue } from "motion/react";
import { sfx } from "./sfx";
import "./LiquidToggle.css";

type Props = {
  color?: string;
  stretch?: number;
  size?: number;
  duration?: number;
  bounce?: number;
  theme?: "light" | "dark";
  sound?: boolean;
};

function geometry(size: number) {
  const W = size;
  const H = Math.round(size * 0.58);
  const pad = Math.max(2, Math.round(H * 0.08));
  const d = H - pad * 2; // 滑块直径
  const T = W - pad * 2; // 轨道内宽
  return { W, H, pad, d, T, travel: T - d, wide: d * 0.24 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Geo = ReturnType<typeof geometry>;

/** 由左右两条边推导出滑块的位置 / 宽度等；后沿越过前沿时保留最小宽度（被挤扁） */
function useEdges(
  xl: MotionValue<number>,
  xr: MotionValue<number>,
  geo: React.RefObject<Geo>,
  fn: (left: number, right: number, width: number, g: Geo) => number,
) {
  return useTransform([xl, xr], ([a, b]: number[]) => {
    const g = geo.current;
    const minW = g.d * 0.62;
    const R = clamp(b, minW, g.T);
    const L = clamp(a, 0, g.T - minW);
    const w = Math.max(R - L, minW);
    return fn(Math.min(L, R - minW), R, w, g);
  });
}

export default function LiquidToggle({
  color = "#34C759",
  stretch = 0.6,
  size = 96,
  duration = 0.5,
  bounce = 0.35,
  theme = "light",
  sound = true,
}: Props) {
  const reduce = useReducedMotion();
  const g = geometry(size);
  const geo = useRef(g);
  geo.current = g;

  const [on, setOn] = useState(false);
  const onRef = useRef(on);

  // 滑块左右两条边各自做弹簧，前沿快、后沿慢 → 被拉长；后沿冲过头 → 被挤扁
  const xl = useMotionValue(0);
  const xr = useMotionValue(g.d);
  // 颜色有多「满」：切换时跟着前沿一起走，拖动时跟着滑块位置走；按住不动时不变，不会在滑块周围泛出一圈色
  const level = useMotionValue(0);

  useEffect(() => {
    const { travel, T, d } = geo.current;
    xl.jump(onRef.current ? travel : 0);
    xr.jump(onRef.current ? T : d);
    level.jump(onRef.current ? 1 : 0);
  }, [size, xl, xr, level]);

  const knobX = useEdges(xl, xr, geo, (L) => L);
  const knobW = useEdges(xl, xr, geo, (_, __, w) => w);
  const knobScaleY = useEdges(xl, xr, geo, (_, __, w, { d }) => (w >= d ? 1 - Math.min((w - d) / d, 1) * 0.2 : 1 + ((d - w) / d) * 0.4));
  const fillW = useEdges(xl, xr, geo, (_, R, __, { pad }) => R + pad * 2);

  const s = reduce ? 0 : stretch;
  const b = reduce ? 0 : bounce;

  const settle = (next: boolean) => {
    const { travel, T, d } = geo.current;
    const Lt = next ? travel : 0;
    const Rt = next ? T : d;
    const right = Rt >= xr.get();
    const [lead, leadT, trail, trailT] = right ? [xr, Rt, xl, Lt] : [xl, Lt, xr, Rt];
    animate(lead, leadT, { type: "spring", duration, bounce: b });
    animate(level, next ? 1 : 0, {
      type: "spring",
      duration: duration * 0.9,
      bounce: 0,
    });
    animate(trail, trailT, {
      type: "spring",
      duration: duration * (1 + s * 0.7),
      bounce: Math.min(0.9, b * (1 + s * 0.5)),
      delay: s * duration * 0.2,
    });
  };

  const commit = (next: boolean) => {
    onRef.current = next;
    setOn(next);
    settle(next);
    if (sound) (next ? sfx.pop : sfx.tap)();
  };

  /* ---------- 按压 / 拖拽 ---------- */
  type DragState = {
    startX: number;
    lastX: number;
    lastT: number;
    v: number;
    k: number;
    dragged: boolean;
    id: number;
  };
  const drag = useRef<DragState | null>(null);
  const lastUp = useRef(0);
  const quick = { type: "spring", stiffness: 520, damping: 34 } as const;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // 大舞台里整体被 CSS zoom 放大，指针位移要换算回组件自身的像素
    const k = e.currentTarget.getBoundingClientRect().width / geo.current.W || 1;
    drag.current = {
      startX: e.clientX,
      lastX: e.clientX,
      lastT: e.timeStamp,
      v: 0,
      k,
      dragged: false,
      id: e.pointerId,
    };
    // 按住时滑块向内变宽
    const { travel, d, wide } = geo.current;
    if (onRef.current) animate(xl, travel - wide, quick);
    else animate(xr, d + wide, quick);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const st = drag.current;
    if (!st || st.id !== e.pointerId) return;
    // 指针速度（px/s），做一点平滑，松手时用来判断「甩」
    const dt = Math.max(1, e.timeStamp - st.lastT);
    st.v = st.v * 0.6 + ((e.clientX - st.lastX) / st.k / dt) * 1000 * 0.4;
    const dir = Math.sign(e.clientX - st.lastX);
    st.lastX = e.clientX;
    st.lastT = e.timeStamp;
    const dx = (e.clientX - st.startX) / st.k;
    if (!st.dragged && Math.abs(dx) < 4) return;
    st.dragged = true;
    const { T, d, wide } = geo.current;
    const kw = d + wide;
    const hi = T - kw;
    const base = onRef.current ? hi : 0;
    // 拖过头时橡皮筋：越拉越难，最多再挤进去 rubberMax，滑块被压在墙上变窄
    const rubberMax = d * 0.22;
    const rubber = (o: number) => rubberMax * (1 - 1 / (o / (rubberMax * 2) + 1));
    let p = base + dx;
    level.set(clamp(p / hi, 0, 1));
    if (p < 0) p = -rubber(-p);
    else if (p > hi) p = hi + rubber(p - hi);
    const k = 900;
    const trailK = k * (1 - 0.8 * s) + 60;
    const leadSpring = {
      type: "spring",
      stiffness: k,
      damping: 2 * Math.sqrt(k) * 0.9,
    } as const;
    const trailSpring = {
      type: "spring",
      stiffness: trailK,
      damping: 2 * Math.sqrt(trailK) * 0.75,
    } as const;
    if (dir >= 0) {
      animate(xr, p + kw, leadSpring);
      animate(xl, p, trailSpring);
    } else {
      animate(xl, p, leadSpring);
      animate(xr, p + kw, trailSpring);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const st = drag.current;
    if (!st || st.id !== e.pointerId) return;
    drag.current = null;
    lastUp.current = performance.now();
    if (!st.dragged) return commit(!onRef.current);
    // 按松手时的位置 + 速度往前「投」一段再判断，甩一下就能切换
    const { T, d, wide } = geo.current;
    const kw = d + wide;
    const center = (xl.get() + xr.get()) / 2 + clamp(st.v * 0.12, -T, T);
    const next = center > kw / 2 + (T - kw) / 2;
    if (next !== onRef.current) commit(next);
    else settle(next);
  };

  const onPointerCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    settle(onRef.current);
  };

  return (
    <div className="liquid-toggle" data-theme={theme} style={{ "--lt-color": color } as React.CSSProperties}>
      <div className="liquid-toggle__body">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="液态开关"
          className="liquid-toggle__track"
          style={
            {
              width: g.W,
              height: g.H,
              "--lt-pad": `${g.pad}px`,
            } as React.CSSProperties
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onClick={() => {
            // 指针松开后浏览器补发的 click 已经在 pointerup 里处理过；只响应键盘 / 读屏
            if (performance.now() - lastUp.current > 400) commit(!onRef.current);
          }}
        >
          <motion.span className="liquid-toggle__fill" style={{ width: fillW, opacity: level }} />
          <motion.span className="liquid-toggle__knob" style={{ x: knobX, width: knobW, height: g.d, scaleY: knobScaleY }} />
        </button>

        <div className="liquid-toggle__caption" aria-hidden>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={on ? "on" : "off"}
              initial={{ y: on ? 10 : -10, opacity: 0, filter: "blur(3px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={{ y: on ? -10 : 10, opacity: 0, filter: "blur(3px)" }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
            >
              {on ? "已开启" : "已关闭"}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
