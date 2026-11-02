"use client";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { sfx } from "./sfx";
import "./DotLoader.css";

type Variant = "wave" | "orbit" | "pulse" | "bounce";

type Props = {
  variant?: Variant | string;
  count?: number;
  speed?: number;
  dotSize?: number;
  color?: string;
  theme?: "light" | "dark";
  sound?: boolean;
};

const VARIANTS: Variant[] = ["wave", "orbit", "pulse", "bounce"];
/** 完成后停留多久再回到加载 */
const HOLD_MS = 1800;
/** 圆点收拢到中心后，对勾弹出的时刻（与 CSS 里的 transition-delay 对齐） */
const POP_MS = 230;

/**
 * 循环动画全部交给 CSS keyframes（合成线程跑，不占 React）；
 * 「完成」是一组可打断的 CSS transition：圆点收拢到中心 → 中心长成圆章 → 画出对勾，反向同样连续。
 */
export default function DotLoader({
  variant = "wave",
  count = 5,
  speed = 1,
  dotSize = 12,
  color = "#0A84FF",
  theme = "light",
  sound = true,
}: Props) {
  const [done, setDone] = useState(false);
  const timers = useRef<number[]>([]);
  const n = Math.min(12, Math.max(1, Math.round(count)));
  const v = (VARIANTS.includes(variant as Variant) ? variant : "wave") as Variant;
  // 圆章直径是圆点的 k 倍，小圆点时保证对勾仍然看得清
  const k = Math.max(3.6, 44 / Math.max(4, dotSize));

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);

  const toggle = () => {
    clear();
    if (done) {
      setDone(false);
      if (sound) sfx.tap();
      return;
    }
    setDone(true);
    timers.current.push(
      window.setTimeout(() => sound && sfx.success(), POP_MS),
      window.setTimeout(() => setDone(false), HOLD_MS),
    );
  };

  return (
    <div
      className="dot-loader"
      data-theme={theme}
      style={
        {
          "--dl-color": color,
          "--dl-px": `${dotSize}px`,
          "--dl-n": n,
          "--dl-speed": Math.max(0.1, speed),
          "--dl-k": k,
        } as React.CSSProperties
      }
    >
      <button
        type="button"
        className="dot-loader__stage"
        data-variant={v}
        data-done={done || undefined}
        aria-label={done ? "加载完成，点击重新加载" : "正在加载，点击模拟完成"}
        aria-busy={!done}
        onClick={toggle}
      >
        <span className="dot-loader__set" key={`${v}-${n}`}>
          {Array.from({ length: n }, (_, i) => (
            <span key={i} className="dot-loader__slot" style={{ "--i": i, "--t": n > 1 ? i / (n - 1) : 0 } as React.CSSProperties}>
              {v === "orbit" ? (
                <span className="dot-loader__arm">
                  <span className="dot-loader__dot" />
                </span>
              ) : (
                <>
                  {v === "pulse" && <span className="dot-loader__ring" />}
                  {v === "bounce" && <span className="dot-loader__shadow" />}
                  <span className="dot-loader__dot" />
                </>
              )}
            </span>
          ))}
        </span>
        <span className="dot-loader__badge" aria-hidden>
          <svg viewBox="0 0 24 24">
            <path d="M6.5 12.5l3.6 3.6L17.5 8.5" pathLength={1} />
          </svg>
        </span>
      </button>

      <div className="dot-loader__caption" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={done ? "done" : "loading"}
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
          >
            {done ? "加载完成" : "正在加载"}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
