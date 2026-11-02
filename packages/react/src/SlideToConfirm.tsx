"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, useMotionValueEvent, animate } from "motion/react";
import { ChevronsRight, ChevronLeft, CreditCard, Lock, TicketPercent } from "lucide-react";
import { sfx } from "./sfx";
import { useEnd, useFinePointer } from "./adaptive";
import "./SlideToConfirm.css";

type Props = {
  color?: string;
  ratio?: number;
  shimmer?: boolean;
  stiffness?: number;
  theme?: "light" | "dark";
  sound?: boolean;
};

type State = "idle" | "loading" | "success";

const H = 60;
const KNOB = 52;
const PAD = (H - KNOB) / 2;
/** 拉过两端时的橡皮筋：越拉越拉不动，最多再多出十来像素 */
const band = (over: number) => (1 - 1 / ((over * 0.55) / 40 + 1)) * 40;
/** 弹层 / 弹窗进场的弹簧：手机从底部升起、大屏从中间放大，用同一条 */
const SHEET_SPRING = { type: "spring", stiffness: 260, damping: 28 } as const;

export default function SlideToConfirm({
  color = "#16A34A",
  ratio = 0.9,
  shimmer = true,
  stiffness = 420,
  theme = "light",
  sound = true,
}: Props) {
  const [state, setState] = useState<State>("idle");
  const [armed, setArmed] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [max, setMax] = useState(240);
  const [hover, setHover] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // 多端：手机是底部弹层，iPad / 桌面是居中弹窗（布局细节在 CSS 容器查询里）
  const end = useEnd(rootRef);
  const dialog = end !== "phone";
  // 有鼠标时滑块把手才有悬停提示，触屏不需要
  const mouse = useFinePointer();
  const timers = useRef<number[]>([]);
  const touched = useRef(false);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const live = useRef({ ratio, sound, max, state, armed, stiffness });
  live.current = { ratio, sound, max, state, armed, stiffness };

  // x 是手指给的「原始」位置，可以超出 [0, max]；画面上用橡皮筋换算后的 knobX
  const x = useMotionValue(0);
  const knobX = useTransform(x, (v) => {
    const m = live.current.max;
    if (v < 0) return -band(-v) * 0.5;
    if (v > m) return m + band(v - m) * 0.5;
    return v;
  });
  const progress = useTransform(x, (v) => (live.current.max > 0 ? Math.min(Math.max(v / live.current.max, 0), 1) : 0));
  const fillWidth = useTransform(knobX, (v) => Math.max(v, 0) + KNOB + PAD * 2);
  const hintOpacity = useTransform(progress, [0, 0.5], [1, 0]);
  const hintX = useTransform(knobX, (v) => v * 0.3);
  const fillOpacity = useTransform(progress, [0, 1], [0.4, 1]);
  const chevronOpacity = useTransform(progress, [0.6, 0.9], [1, 0]);

  // 弹层进场：手机从底部升起 60px，大屏从中间轻微放大 + 淡入；跨断点换形态时按新形态再进场一次
  const sheetY = useMotionValue(60);
  const sheetScale = useMotionValue(1);
  const sheetOpacity = useMotionValue(0);
  useEffect(() => {
    sheetOpacity.set(0);
    let runs: ReturnType<typeof animate>[];
    if (dialog) {
      sheetY.set(0);
      sheetScale.set(0.94);
      runs = [animate(sheetScale, 1, SHEET_SPRING), animate(sheetOpacity, 1, { duration: 0.22, ease: [0.2, 0, 0, 1] })];
    } else {
      sheetScale.set(1);
      sheetY.set(60);
      runs = [animate(sheetY, 0, SHEET_SPRING), animate(sheetOpacity, 1, SHEET_SPRING)];
    }
    return () => runs.forEach((a) => a.stop());
  }, [dialog, sheetY, sheetScale, sheetOpacity]);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (live.current.state === "idle") setMax(Math.max(0, el.clientWidth - KNOB - PAD * 2));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  useMotionValueEvent(x, "change", (v) => {
    if (live.current.state !== "idle") return;
    const next = v >= live.current.max * live.current.ratio - 0.5;
    if (next !== live.current.armed) {
      live.current.armed = next;
      setArmed(next);
      if (next && live.current.sound) sfx.tick();
    }
  });

  /** 弹回起点：ζ≈0.55，撞到左端时被橡皮筋吃掉，不会穿墙 */
  const springBack = () => {
    const k = live.current.stiffness;
    anim.current?.stop();
    anim.current = animate(x, 0, { type: "spring", stiffness: k, damping: 1.1 * Math.sqrt(k), restDelta: 0.3 });
  };

  const complete = () => {
    if (live.current.state !== "idle") return;
    live.current.state = "loading";
    anim.current?.stop();
    anim.current = animate(x, live.current.max, { type: "spring", stiffness: 700, damping: 44 });
    later(() => {
      setState("loading");
      // 把手要消失了，悬停态一起清掉（重新出现时不该还是放大的）
      setHover(false);
      setArmed(false);
      live.current.armed = false;
      if (live.current.sound) sfx.whoosh();
    }, 140);
    later(() => {
      setState("success");
      if (live.current.sound) sfx.success();
    }, 1500);
    later(() => {
      x.set(0);
      setState("idle");
    }, 3600);
  };

  // 进场后轻轻探一下，告诉人这里能拖
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (touched.current || live.current.state !== "idle") return;
      nudge();
    }, 1100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nudge = () => {
    anim.current?.stop();
    const a = animate(x, Math.min(40, live.current.max * 0.2), { type: "spring", stiffness: 520, damping: 20, restDelta: 2 });
    anim.current = a;
    // 中途被手指打断（stop 也会 resolve）就不再弹回，交给拖动
    a.then(() => {
      if (anim.current === a && live.current.state === "idle") springBack();
    });
  };

  // 拖动：自己处理指针，监听挂在 window 上，手指滑出滑块也不丢
  const onKnobDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (live.current.state !== "idle" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    touched.current = true;
    anim.current?.stop();
    anim.current = null;
    const id = e.pointerId;
    const startX = e.clientX;
    // 屏幕被缩放时（首页卡片、手机外框），把屏幕像素换算回组件像素
    const el = trackRef.current;
    const scale = el ? el.getBoundingClientRect().width / el.offsetWidth || 1 : 1;
    const from = x.get();
    let moved = false;
    setPressed(true);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id || live.current.state !== "idle") return;
      const dx = (ev.clientX - startX) / scale;
      if (Math.abs(dx) > 3) moved = true;
      x.set(from + dx);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setPressed(false);
      if (live.current.state !== "idle") return;
      const m = live.current.max;
      const v = x.get();
      const vel = x.getVelocity();
      // 甩得够快：按 0.12s 后的落点判断，不必真拖到头
      const projected = v + Math.max(0, vel) * 0.12;
      if (v >= m * live.current.ratio - 0.5 || (vel > 600 && projected >= m * live.current.ratio)) complete();
      else if (!moved) nudge();
      else springBack();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // 点轨道空白处：滑块轻轻探一下，提示可以拖
  const onTrackDown = (e: React.PointerEvent) => {
    if (state !== "idle" || (e.target as HTMLElement).closest(".slide-to-confirm__knob")) return;
    touched.current = true;
    nudge();
    if (sound) sfx.tap();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      complete();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const v = Math.min(max, x.get() + max * 0.2);
      animate(x, v, { type: "spring", stiffness: 500, damping: 34 });
      if (v >= max * ratio - 0.5) complete();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      animate(x, Math.max(0, x.get() - max * 0.2), { type: "spring", stiffness: 500, damping: 34 });
    }
  };

  const idle = state === "idle";
  const trackBg = theme === "dark" ? "#26262b" : "#eef0f3";

  return (
    <div ref={rootRef} className="slide-to-confirm" data-theme={theme} style={{ "--stc": color } as React.CSSProperties}>
      <div className="slide-to-confirm__scrim" />
      <div className="slide-to-confirm__inner">
        {/* 背后的订单页 */}
        <div className="slide-to-confirm__page" aria-hidden>
          <StatusBar />
          <div className="slide-to-confirm__nav">
            <ChevronLeft size={22} />
            <span>确认订单</span>
            <i />
          </div>
          <div className="slide-to-confirm__product">
            <div className="slide-to-confirm__thumb">🎧</div>
            <div>
              <strong>降噪耳机 Air 2</strong>
              <span>月光白 · 1 件</span>
              <em>¥288.00</em>
            </div>
          </div>
          <div className="slide-to-confirm__skeleton">
            <i />
            <i />
            <i />
          </div>
        </div>

        <motion.section
          className="slide-to-confirm__sheet"
          style={{ y: sheetY, scale: sheetScale, opacity: sheetOpacity }}
          role={dialog ? "dialog" : undefined}
          aria-modal={dialog || undefined}
          aria-label="支付确认"
        >
          <span className="slide-to-confirm__grabber" />
          <div className="slide-to-confirm__title">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={state === "success" ? "ok" : "pay"}
                initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
              >
                {state === "success" ? "支付成功" : "确认支付"}
              </motion.span>
            </AnimatePresence>
          </div>
          <div className="slide-to-confirm__amount">
            <small>¥</small>268<small>.00</small>
          </div>

          <ul className="slide-to-confirm__rows">
            <li>
              <span><CreditCard size={16} /> 支付方式</span>
              <b>储蓄卡（尾号 0921）</b>
            </li>
            <li>
              <span><TicketPercent size={16} /> 优惠券</span>
              <b className="is-off">−¥20.00</b>
            </li>
          </ul>

          <div className="slide-to-confirm__slot">
            <motion.div
              ref={trackRef}
              className="slide-to-confirm__track"
              initial={false}
              animate={{ width: idle ? "100%" : H, backgroundColor: idle ? trackBg : color }}
              transition={{
                width: idle ? { type: "spring", stiffness: 300, damping: 30 } : { type: "spring", stiffness: 340, damping: 30, delay: 0.06 },
                backgroundColor: { duration: idle ? 0.3 : 0.16 },
              }}
              onPointerDown={onTrackDown}
            >
              <AnimatePresence>
                {idle && (
                  <motion.div
                    key="fill"
                    className="slide-to-confirm__fill"
                    style={{ width: fillWidth, opacity: fillOpacity }}
                    exit={{ opacity: 0 }}
                  />
                )}
                {idle && (
                  <motion.span
                    key="hint"
                    className={`slide-to-confirm__hint${shimmer ? " is-shimmer" : ""}`}
                    style={{ opacity: hintOpacity, x: hintX }}
                    exit={{ opacity: 0 }}
                  >
                    滑动确认支付
                  </motion.span>
                )}
                {idle && (
                  <motion.button
                    key="knob"
                    className="slide-to-confirm__knob"
                    aria-label="滑动确认支付，或按回车键确认"
                    data-hover={(mouse && hover && !pressed) || undefined}
                    style={{ x: knobX }}
                    onPointerDown={onKnobDown}
                    onKeyDown={onKeyDown}
                    // 鼠标悬停：把手微微放大、外面亮一圈，提示「抓这里」；触屏没有悬停
                    onPointerEnter={(e) => mouse && e.pointerType === "mouse" && setHover(true)}
                    onPointerLeave={() => setHover(false)}
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: pressed ? 0.94 : mouse && hover ? 1.06 : 1, opacity: 1 }}
                    exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.15 } }}
                    transition={pressed ? { duration: 0.09 } : { type: "spring", stiffness: 520, damping: 26 }}
                  >
                    <motion.span style={{ opacity: chevronOpacity }} className="slide-to-confirm__chev">
                      <ChevronsRight size={24} strokeWidth={2.4} />
                    </motion.span>
                    <AnimatePresence>
                      {armed && (
                        <motion.span
                          className="slide-to-confirm__go"
                          initial={{ scale: 0.3, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.3, opacity: 0 }}
                          transition={{ type: "spring", stiffness: 600, damping: 20 }}
                        >
                          <Lock size={20} strokeWidth={2.4} />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.button>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {state === "loading" && (
                  <motion.svg
                    key="spin"
                    className="slide-to-confirm__spinner"
                    viewBox="0 0 24 24"
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1, transition: { delay: 0.2 } }}
                    exit={{ opacity: 0, scale: 0.6 }}
                  >
                    <circle cx="12" cy="12" r="9" pathLength={1} strokeDasharray="0.65 0.35" />
                  </motion.svg>
                )}
                {state === "success" && (
                  <motion.svg
                    key="check"
                    className="slide-to-confirm__check"
                    viewBox="0 0 24 24"
                    initial={{ scale: 0.5 }}
                    animate={{ scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ type: "spring", stiffness: 500, damping: 15 }}
                  >
                    <motion.path
                      d="M6 12.5l4 4L18 8.5"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.35, ease: [0.3, 0, 0.2, 1], delay: 0.05 }}
                    />
                  </motion.svg>
                )}
              </AnimatePresence>
            </motion.div>
            <AnimatePresence>
              {state === "success" && (
                <motion.span
                  key="ring"
                  className="slide-to-confirm__ring"
                  initial={{ scale: 1, opacity: 0.5 }}
                  animate={{ scale: 2.1, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.7, ease: [0.2, 0.7, 0.3, 1] }}
                />
              )}
            </AnimatePresence>
          </div>

          <p className="slide-to-confirm__foot">
            <Lock size={12} /> 支付环境安全 · 由 Zmotion Pay 提供保障
          </p>
        </motion.section>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="slide-to-confirm__status">
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
