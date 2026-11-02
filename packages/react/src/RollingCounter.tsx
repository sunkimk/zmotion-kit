"use client";
import { useEffect, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  animate,
  useMotionValue,
  useSpring,
  useTransform,
  useVelocity,
  useReducedMotion,
  type MotionValue,
} from "motion/react";
import { Minus, Plus } from "lucide-react";
import { sfx } from "./sfx";
import "./RollingCounter.css";

type Props = {
  step?: number;
  min?: number;
  max?: number;
  stiffness?: number;
  blur?: boolean;
  theme?: "light" | "dark";
  sound?: boolean;
};

type SpringCfg = { stiffness: number; damping: number; mass: number };

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const colSpring = { type: "spring", stiffness: 420, damping: 34 } as const;
const press = { duration: 0.09, ease: [0.3, 0, 0.5, 1] } as const;
const pop = { duration: 0.26, ease: [0.28, 1.3, 0.36, 1] } as const;

export default function RollingCounter({
  step = 1,
  min = 0,
  max = 120,
  stiffness = 240,
  blur = true,
  theme = "light",
  sound = true,
}: Props) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const reduce = useReducedMotion();

  const [value, setValue] = useState(() => clamp(9, lo, hi));
  const valueRef = useRef(value);
  const prevAbs = useRef(Math.abs(value));
  const [absDir, setAbsDir] = useState(1);
  const mounted = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const lastTick = useRef(0);
  const shake = useMotionValue(0);
  const shakeMinus = useMotionValue(0);
  const shakePlus = useMotionValue(0);

  useEffect(() => {
    mounted.current = true;
  }, []);

  // 上下限变化时把当前值收回范围内
  useEffect(() => {
    const v = clamp(valueRef.current, lo, hi);
    if (v !== valueRef.current) commit(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lo, hi]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const spring: SpringCfg = {
    stiffness,
    damping: Math.sqrt(stiffness) * (reduce ? 2 : 1.45),
    mass: 1,
  };

  function commit(next: number) {
    const a = Math.abs(next);
    setAbsDir(a >= prevAbs.current ? 1 : -1);
    prevAbs.current = a;
    valueRef.current = next;
    setValue(next);
  }

  const knock = (dir: number) => {
    const btn = dir > 0 ? shakePlus : shakeMinus;
    const k = dir * (reduce ? 0.4 : 1);
    animate(shake, [0, 7 * k, -6 * k, 4 * k, -2 * k, 0], { duration: 0.42, ease: "easeOut" });
    animate(btn, [0, 5 * k, -4 * k, 2 * k, 0], { duration: 0.36, ease: "easeOut" });
    if (sound) sfx.tap();
  };

  /** 走一步，返回是否成功（到达极限则抖动并返回 false） */
  const bump = (dir: number) => {
    const cur = valueRef.current;
    const next = clamp(cur + dir * step, lo, hi);
    if (next === cur) {
      knock(dir);
      return false;
    }
    commit(next);
    // 长按加速到 30 次/秒时不要每步都响，最多 ~16 次/秒，听起来像棘轮而不是蜂鸣
    const now = performance.now();
    if (sound && now - lastTick.current > 60) {
      lastTick.current = now;
      sfx.tick();
    }
    return true;
  };

  const stop = () => window.clearTimeout(timer.current);

  const start = (dir: number) => {
    stop();
    if (!bump(dir)) return;
    let n = 0;
    const loop = (delay: number) => {
      timer.current = window.setTimeout(() => {
        if (!bump(dir)) return;
        n += 1;
        // 越按越快：间隔从 150ms 指数收敛到 32ms
        loop(Math.max(32, 150 * Math.pow(0.88, n)));
      }, delay);
    };
    loop(420);
  };

  // 指针刚松开时浏览器还会补一个 click，按下时已经走过一步，这个 click 要忽略；
  // 只有键盘 / 读屏触发的 click（前面没有指针按下）才走一步
  const lastUp = useRef(0);
  const release = () => {
    lastUp.current = performance.now();
    stop();
  };

  const holdProps = (dir: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      start(dir);
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: stop,
    onClick: () => {
      if (performance.now() - lastUp.current > 400) bump(dir);
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  const abs = Math.abs(value);
  const places = String(Math.max(Math.abs(lo), Math.abs(hi))).length;
  const shown = Array.from({ length: places }, (_, i) => places - 1 - i).filter((p) => p === 0 || abs >= 10 ** p);
  const atMin = value <= lo;
  const atMax = value >= hi;
  const progress = hi === lo ? 1 : (value - lo) / (hi - lo);

  return (
    <div className="rolling-counter" data-theme={theme}>
      <div className="rolling-counter__pill">
        <motion.button
          type="button"
          className="rolling-counter__btn"
          aria-label={`减少 ${step}`}
          aria-disabled={atMin}
          data-off={atMin || undefined}
          style={{ x: shakeMinus }}
          whileTap={atMin ? undefined : { scale: 0.9, transition: press }}
          transition={pop}
          {...holdProps(-1)}
        >
          <Minus strokeWidth={2.6} />
        </motion.button>

        <motion.output className="rolling-counter__value" aria-live="polite" aria-label={`当前数值 ${value}`} style={{ x: shake }}>
          <AnimatePresence initial={false}>
            {value < 0 && (
              <motion.span
                key="sign"
                className="rolling-counter__sign"
                initial={{ width: "0ch", opacity: 0 }}
                animate={{ width: "0.9ch", opacity: 1 }}
                exit={{ width: "0ch", opacity: 0 }}
                transition={colSpring}
              >
                −
              </motion.span>
            )}
            {shown.map((p) => (
              <Column
                key={p}
                place={p}
                value={abs}
                enterFrom={mounted.current ? -absDir : 0}
                spring={spring}
                blur={blur && !reduce}
              />
            ))}
          </AnimatePresence>
        </motion.output>

        <motion.button
          type="button"
          className="rolling-counter__btn"
          aria-label={`增加 ${step}`}
          aria-disabled={atMax}
          data-off={atMax || undefined}
          style={{ x: shakePlus }}
          whileTap={atMax ? undefined : { scale: 0.9, transition: press }}
          transition={pop}
          {...holdProps(1)}
        >
          <Plus strokeWidth={2.6} />
        </motion.button>
      </div>

      <div className="rolling-counter__meta">
        <div className="rolling-counter__track" aria-hidden>
          <motion.span
            className="rolling-counter__fill"
            initial={false}
            animate={{ scaleX: progress }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
          />
        </div>
        <div className="rolling-counter__range">
          <span>{lo}</span>
          <span>{hi}</span>
        </div>
      </div>
    </div>
  );
}

function Column({
  place,
  value,
  enterFrom,
  spring,
  blur,
}: {
  place: number;
  value: number;
  enterFrom: number;
  spring: SpringCfg;
  blur: boolean;
}) {
  const target = Math.floor(value / 10 ** place);
  // 新出现的位从「上一个数字」滚进来
  const mv = useSpring(target + enterFrom, spring);
  useEffect(() => {
    mv.set(target);
  }, [mv, target]);

  const velocity = useVelocity(mv);
  const filter = useTransform(velocity, (v) => `blur(${Math.min(Math.abs(v) * 0.2, 4).toFixed(2)}px)`);

  return (
    <motion.span
      className="rolling-counter__col"
      initial={{ width: "0ch", opacity: 0 }}
      animate={{ width: "1ch", opacity: 1 }}
      exit={{ width: "0ch", opacity: 0 }}
      transition={colSpring}
    >
      <motion.span className="rolling-counter__reel" style={{ filter: blur ? filter : "none" }}>
        {DIGITS.map((d) => (
          <Digit key={d} digit={d} mv={mv} />
        ))}
      </motion.span>
    </motion.span>
  );
}

function Digit({ digit, mv }: { digit: number; mv: MotionValue<number> }) {
  // 每个数字按与当前值的环形距离摆放：比当前大的在下方，小的在上方
  const y = useTransform(mv, (latest) => {
    const pv = ((latest % 10) + 10) % 10;
    let offset = (10 + digit - pv) % 10;
    if (offset > 5) offset -= 10;
    return `${offset * 100}%`;
  });
  return (
    <motion.span className="rolling-counter__digit" style={{ y }}>
      {digit}
    </motion.span>
  );
}
