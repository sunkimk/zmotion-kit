"use client";
import { useEffect, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
  useTransform,
  useMotionTemplate,
  useReducedMotion,
} from "motion/react";
import { ArrowRight, Check } from "lucide-react";
import { sfx } from "./sfx";
import "./MagneticButton.css";

type Props = {
  strength?: number;
  radius?: number;
  stiffness?: number;
  parallax?: number;
  color?: string;
  theme?: "light" | "dark";
  sound?: boolean;
};

const smooth = (t: number) => t * t * (3 - 2 * t);
/** 软限幅：小位移原样通过，越往外越难拉，永远不超过 max */
const soft = (v: number, max: number) => max * Math.tanh(v / max);
const pop = { duration: 0.26, ease: [0.28, 1.3, 0.36, 1] } as const;
const press = { duration: 0.09, ease: [0.3, 0, 0.5, 1] } as const;

/** 根据背景色选择黑/白文字，保证浅色按钮也可读 */
function readableText(hex: string) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return "#fff";
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? "#111" : "#fff";
}

export default function MagneticButton({
  strength = 0.4,
  radius = 90,
  stiffness = 220,
  parallax = 1.6,
  color = "#5B5BF6",
  theme = "light",
  sound = true,
}: Props) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const inField = useRef(false);
  const reduce = useReducedMotion();
  const [done, setDone] = useState(0); // 每次点击 +1，用来重启「已开始」的计时
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  // 原始目标位移（未经弹簧）
  const tx = useMotionValue(0);
  const ty = useMotionValue(0);
  const field = useMotionValue(0);
  const hx = useMotionValue(50);
  const hy = useMotionValue(50);

  // 阻尼比 ≈ 0.68：被吸过去时有一点点过冲，松开后利落回位，不会晃个不停
  const mass = 0.7;
  const spring = { stiffness, damping: 2 * Math.sqrt(stiffness * mass) * 0.68, mass };
  const x = useSpring(tx, spring);
  const y = useSpring(ty, spring);
  const power = useSpring(field, { stiffness: 300, damping: 30 });

  // 文字相对按钮再多走 (parallax - 1) 倍，但被软限幅在按钮里，箭头再多一点
  const lx = useTransform(x, (v) => soft(v * (parallax - 1), 14));
  const ly = useTransform(y, (v) => soft(v * (parallax - 1), 6));
  const ax = useTransform(x, (v) => soft(v * (parallax - 1) * 0.5, 4));
  const fieldScale = useTransform(power, [0, 1], [0.86, 1]);
  const shine = useMotionTemplate`radial-gradient(120px circle at ${hx}% ${hy}%, rgb(255 255 255 / 0.32), transparent 70%)`;

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(0), 1500);
    return () => clearTimeout(t);
  }, [done]);

  const reset = () => {
    tx.set(0);
    ty.set(0);
    field.set(0);
    inField.current = false;
  };

  const onMove = (e: React.PointerEvent) => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    // 指针到胶囊形按钮边缘的距离（按钮内部为 0）
    const half = r.height / 2;
    const qx = Math.max(Math.abs(dx) - (r.width / 2 - half), 0);
    const d = Math.max(Math.hypot(qx, dy) - half, 0);
    const f = d >= radius ? 0 : smooth(1 - d / radius);
    const k = reduce ? strength * 0.25 : strength;

    tx.set(dx * k * f);
    ty.set(dy * k * f);
    field.set(f);
    hx.set(((e.clientX - r.left) / r.width) * 100);
    hy.set(((e.clientY - r.top) / r.height) * 100);

    // 只在「进入磁场」那一下响一声
    if (f > 0 && !inField.current && sound) sfx.tick();
    inField.current = f > 0;
  };

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const px = inside ? e.clientX - r.left : r.width / 2;
    const py = inside ? e.clientY - r.top : r.height / 2;
    const id = performance.now();
    setRipples((list) => [...list.slice(-3), { id, x: px, y: py }]);
    if (sound) (done ? sfx.tap : sfx.success)();
    setDone((n) => n + 1);
  };

  return (
    <div
      className="magnetic-button"
      data-theme={theme}
      style={{ "--mb-color": color, "--mb-text": readableText(color), "--mb-radius": `${radius}px` } as React.CSSProperties}
      onPointerMove={onMove}
      onPointerLeave={reset}
      onPointerUp={(e) => e.pointerType !== "mouse" && reset()}
      onPointerCancel={reset}
    >
      <span className="magnetic-button__anchor" ref={anchorRef}>
        {/* 磁场：大小就是「磁场半径」，指针越近越亮 */}
        <motion.span className="magnetic-button__field" aria-hidden style={{ opacity: power, scale: fieldScale }} />
        <motion.button
          type="button"
          className="magnetic-button__btn"
          aria-label={done ? "已开始" : "开始体验"}
          style={{ x, y }}
          whileHover={{ scale: 1.03, transition: pop }}
          whileTap={{ scale: 0.95, transition: press }}
          transition={pop}
          onClick={onClick}
        >
          <motion.span className="magnetic-button__shine" aria-hidden style={{ background: shine, opacity: power }} />
          <AnimatePresence>
            {ripples.map((r) => (
              <motion.span
                key={r.id}
                className="magnetic-button__ripple"
                aria-hidden
                style={{ left: r.x, top: r.y }}
                initial={{ scale: 0, opacity: 0.4 }}
                animate={{ scale: 1, opacity: 0 }}
                transition={{ duration: 0.6, ease: [0.2, 0.7, 0.3, 1] }}
                onAnimationComplete={() => setRipples((list) => list.filter((it) => it.id !== r.id))}
              />
            ))}
          </AnimatePresence>
          <motion.span className="magnetic-button__label" style={{ x: lx, y: ly }}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={done ? "done" : "idle"}
                className="magnetic-button__text"
                initial={{ y: "110%", opacity: 0 }}
                animate={{ y: "0%", opacity: 1 }}
                exit={{ y: "-110%", opacity: 0 }}
                transition={{ type: "spring", duration: 0.38, bounce: 0.2 }}
              >
                {done ? (
                  <>
                    <Check className="magnetic-button__icon" strokeWidth={2.6} />
                    已开始
                  </>
                ) : (
                  <>
                    开始体验
                    <motion.span className="magnetic-button__arrow" style={{ x: ax }}>
                      <ArrowRight className="magnetic-button__icon" strokeWidth={2.4} />
                    </motion.span>
                  </>
                )}
              </motion.span>
            </AnimatePresence>
          </motion.span>
        </motion.button>
      </span>
    </div>
  );
}
