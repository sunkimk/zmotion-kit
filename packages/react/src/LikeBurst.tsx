"use client";
import { useRef, useState } from "react";
import { motion, AnimatePresence, animate, useMotionValue, useReducedMotion } from "motion/react";
import { sfx } from "./sfx";
import "./LikeBurst.css";

type Props = {
  color?: string;
  particles?: number;
  spread?: number;
  bounce?: number;
  showCount?: boolean;
  theme?: "light" | "dark";
  sound?: boolean;
};

const HEART = "M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.6 4.5c2.1 0 3.6 1.2 5.4 3.1 1.8-1.9 3.3-3.1 5.4-3.1 3.7 0 5.7 3.9 4.2 7.3C19.5 16.4 12 21 12 21z";
/** 组件内部尺寸都按 em 写（根字号随容器缩放），参数里的 px 以 16px 为基准换算 */
const em = (px: number) => `${(px / 16).toFixed(3)}em`;
const press = { duration: 0.09, ease: [0.3, 0, 0.5, 1] } as const;
const pop = { duration: 0.26, ease: [0.28, 1.3, 0.36, 1] } as const;

export default function LikeBurst({
  color = "#FF3B5C",
  particles = 12,
  spread = 56,
  bounce = 0.5,
  showCount = true,
  theme = "light",
  sound = true,
}: Props) {
  const reduce = useReducedMotion();
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState(128);
  const [burst, setBurst] = useState(0);
  const likedRef = useRef(false);
  // 爱心自己的缩放：按下压扁，松开带着速度弹回（点亮时速度更大，会冲过 1 再回来）
  const heart = useMotionValue(1);

  const toggle = () => {
    const next = !likedRef.current;
    likedRef.current = next;
    setLiked(next);
    setCount((c) => c + (next ? 1 : -1));
    if (next && !reduce) setBurst((b) => b + 1);
    animate(heart, 1, {
      type: "spring",
      stiffness: 520,
      damping: next ? 34 - bounce * 26 : 30,
      velocity: next ? 6 + bounce * 10 : 2,
    });
    if (sound) (next ? sfx.pop : sfx.tap)();
  };

  const n = Math.round(particles);

  return (
    <div className="like-burst" data-theme={theme} data-liked={liked || undefined} style={{ "--like": color } as React.CSSProperties}>
      <motion.button
        type="button"
        className="like-burst__btn"
        aria-pressed={liked}
        aria-label={liked ? "取消点赞" : "点赞"}
        whileTap={{ scale: 0.96, transition: press }}
        transition={pop}
        onTapStart={() => animate(heart, 0.78, press)}
        onTapCancel={() => animate(heart, 1, { type: "spring", stiffness: 500, damping: 30 })}
        onTap={toggle}
      >
        <span className="like-burst__icon">
          <AnimatePresence>
            {liked && burst > 0 && (
              <motion.span
                key={`ring-${burst}`}
                className="like-burst__ring"
                initial={{ scale: 0.45, opacity: 1, borderWidth: em(9) }}
                animate={{ scale: 1.4, opacity: [1, 1, 0], borderWidth: em(0) }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={{ duration: 0.42, ease: [0.2, 0.7, 0.3, 1], opacity: { duration: 0.42, times: [0, 0.55, 1] } }}
              />
            )}
          </AnimatePresence>
          {liked &&
            burst > 0 &&
            Array.from({ length: n }).flatMap((_, i) => {
              // 每个方向一大一小两颗，小的略偏一点角度、飞得更近，颜色浅一档
              const a = (i / n) * Math.PI * 2 - Math.PI / 2;
              const b = a + 0.32;
              const dots = [
                { a, d: spread, s: 7, alt: false },
                { a: b, d: spread * 0.72, s: 5, alt: true },
              ];
              return dots.map((p, j) => (
                <motion.span
                  key={`${burst}-${i}-${j}`}
                  className="like-burst__dot"
                  data-alt={p.alt || undefined}
                  style={{ width: em(p.s), height: em(p.s), marginLeft: em(-p.s / 2), marginTop: em(-p.s / 2) }}
                  initial={{ x: em(Math.cos(p.a) * p.d * 0.45), y: em(Math.sin(p.a) * p.d * 0.45), scale: 0, opacity: 1 }}
                  animate={{ x: em(Math.cos(p.a) * p.d), y: em(Math.sin(p.a) * p.d), scale: [0, 1, 0], opacity: 1 }}
                  transition={{
                    duration: 0.7,
                    delay: 0.08 + (j ? 0.03 : 0),
                    ease: [0.15, 0.8, 0.3, 1],
                    scale: { duration: 0.7, delay: 0.08 + (j ? 0.03 : 0), times: [0, 0.25, 1], ease: "easeOut" },
                  }}
                />
              ));
            })}
          <motion.svg viewBox="0 0 24 24" className="like-burst__heart" style={{ scale: heart }}>
            <path d={HEART} />
          </motion.svg>
        </span>
        {showCount && <Count value={count} up={liked} />}
      </motion.button>
    </div>
  );
}

/** 只滚动变化的那几位：点赞时新数字从下往上进，取消时反过来 */
function Count({ value, up }: { value: number; up: boolean }) {
  const chars = String(value).split("");
  return (
    <span className="like-burst__count" aria-hidden>
      {chars.map((ch, i) => {
        const slot = chars.length - i; // 从个位往左数，位数变化时其它位不跟着动
        return (
          <span key={slot} className="like-burst__slot">
            <AnimatePresence mode="popLayout" initial={false} custom={up}>
              <motion.span
                key={ch}
                custom={up}
                variants={{
                  enter: (u: boolean) => ({ y: u ? "70%" : "-70%", opacity: 0 }),
                  center: { y: "0%", opacity: 1 },
                  exit: (u: boolean) => ({ y: u ? "-70%" : "70%", opacity: 0 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.26, ease: [0.28, 1.3, 0.36, 1], opacity: { duration: 0.16 } }}
              >
                {ch}
              </motion.span>
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
}
