"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence, animate, motionValue, useMotionValue, useSpring, useReducedMotion, type MotionValue } from "motion/react";
import {
  Folder,
  Compass,
  Mail,
  MessageCircle,
  Image as ImageIcon,
  Music,
  Calendar,
  Map as MapIcon,
  StickyNote,
  Terminal,
  Settings,
  ChevronLeft,
  X,
  type LucideIcon,
} from "lucide-react";
import { sfx } from "./sfx";
import { useEnd, useFinePointer, type End } from "./adaptive";
import "./MagnifyDock.css";

type Props = {
  magnification?: number;
  distance?: number;
  baseSize?: number;
  bounce?: boolean;
  labels?: boolean;
  theme?: "light" | "dark";
  sound?: boolean;
};

type App = { id: string; name: string; Icon: LucideIcon; a: string; b: string; fg?: string; divider?: boolean };

const APPS: App[] = [
  { id: "finder", name: "访达", Icon: Folder, a: "#7CC8FF", b: "#1F6BFF" },
  { id: "browser", name: "浏览器", Icon: Compass, a: "#8EE3FF", b: "#0A84FF" },
  { id: "messages", name: "信息", Icon: MessageCircle, a: "#7BEA8C", b: "#1DB954" },
  { id: "mail", name: "邮件", Icon: Mail, a: "#6FB6FF", b: "#3157F5" },
  { id: "photos", name: "照片", Icon: ImageIcon, a: "#FFC36B", b: "#FF4F8B" },
  { id: "music", name: "音乐", Icon: Music, a: "#FF8FA3", b: "#F2274B" },
  { id: "calendar", name: "日历", Icon: Calendar, a: "#FFFFFF", b: "#E9E9EE", fg: "#F2453D" },
  { id: "maps", name: "地图", Icon: MapIcon, a: "#B6F37A", b: "#25B05C" },
  { id: "notes", name: "备忘录", Icon: StickyNote, a: "#FFE58A", b: "#FFB800" },
  { id: "terminal", name: "终端", Icon: Terminal, a: "#565A66", b: "#16181D" },
  { id: "settings", name: "系统设置", Icon: Settings, a: "#C9CCD3", b: "#7A7F8A", divider: true },
];

/** 余弦衰减：指针正下方 1，距离 ≥ dist 时 0 */
const falloff = (t: number) => (t >= 1 ? 0 : (Math.cos(Math.PI * t) + 1) / 2);
const gapOf = (b: number) => Math.round(b * 0.2);
const padOf = (b: number) => Math.round(b * 0.2);
const OPEN_EASE = [0.33, 0.55, 0.2, 1] as const;

// iPad / 手机：程序坞里固定的常用 App（其余放在主屏上）；iPad 程序坞右侧最多放几个最近使用
const IPAD_DOCK = ["messages", "browser", "mail", "photos", "music", "calendar"];
const PHONE_DOCK = ["browser", "messages", "mail", "music"];
const IPAD_RECENT_MAX = 3;
// 触屏图标：按下压小、变暗，松手带弹簧回弹（和点赞按钮同一套手感）
const PRESS = { duration: 0.09, ease: [0.3, 0, 0.5, 1] } as const;
const RELEASE = { type: "spring", stiffness: 520, damping: 20, filter: { duration: 0.2 } } as const;
const appOf = (id: string) => APPS.find((a) => a.id === id)!;

/** 指针停在中间图标上方时整条程序坞的宽度，用来决定窄容器里放几个、多大 */
function peakWidth(n: number, b: number, mag: number, dist: number) {
  const g = gapOf(b);
  const pitch = b + g;
  const c = (n - 1) / 2;
  let w = 0;
  for (let k = 0; k < n; k++) w += b + (mag - 1) * b * falloff((Math.abs(k - c) * pitch) / dist);
  return w + (n - 1) * g + padOf(b) * 2 + g * 2;
}

function fit(width: number, baseSize: number, mag: number, dist: number) {
  const avail = width - 24;
  for (let n = APPS.length; n >= 5; n--) {
    for (let b = baseSize; b >= 26; b -= 2) {
      if (peakWidth(n, b, mag, dist) <= avail) {
        if (b >= Math.min(36, baseSize) || n === 5) return { n, b };
        break;
      }
    }
  }
  return { n: 5, b: 26 };
}

export default function MagnifyDock({
  magnification = 1.8,
  distance = 150,
  baseSize = 48,
  bounce = true,
  labels = true,
  theme = "light",
  sound = true,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [hovered, setHovered] = useState<string | null>(null);
  const [running, setRunning] = useState<string[]>(["finder"]);
  const [front, setFront] = useState<string | null>(null);
  // iPad 程序坞右侧的「最近使用」：最近打开的在前
  const [recent, setRecent] = useState<string[]>(["finder"]);
  const timers = useRef<number[]>([]);
  const origins = useRef(new Map<string, { x: number; y: number; s: number }>());
  // 每个 App 上次是从哪个图标点开的（iPad 上同一个 App 可能既在主屏又在程序坞），收回时回到那里
  const launchedFrom = useRef(new Map<string, Element>());

  // 分端：布局跟组件宽度走；悬停放大只在桌面宽度 + 有鼠标时启用，触屏的桌面宽度设备点按即可
  const end = useEnd(rootRef);
  const mouse = useFinePointer();
  const magnifyOn = end === "desktop" && mouse;
  const endRef = useRef<End>(end);
  endRef.current = end;
  const magnifyRef = useRef(magnifyOn);
  magnifyRef.current = magnifyOn;

  // 只在「放几个、多大」变化时才重渲染：详情展开时 iframe 连续变大，不能每帧都走 React
  const widthRef = useRef<number | null>(null);
  const cfg = useRef({ baseSize, magnification, distance });
  cfg.current = { baseSize, magnification, distance };
  const [, refit] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let lastKey = "";
    const ro = new ResizeObserver(([entry]) => {
      widthRef.current = entry.contentRect.width;
      const c = cfg.current;
      const f = fit(widthRef.current, c.baseSize, c.magnification, c.distance);
      const key = `${f.n}-${f.b}`;
      if (key !== lastKey) {
        lastKey = key;
        refit((t) => t + 1);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const { n, b: base } = widthRef.current == null ? { n: APPS.length, b: baseSize } : fit(widthRef.current, baseSize, magnification, distance);
  const apps = APPS.slice(0, n - 1).concat(APPS[APPS.length - 1]);

  // 每个图标一个目标尺寸，指针移动时由程序坞统一算（一次读布局），图标各自弹簧跟随
  const targets = useRef(new Map<string, MotionValue<number>>());
  const items = useRef(new Map<string, HTMLElement>());
  const targetOf = (id: string) => {
    let mv = targets.current.get(id);
    if (!mv) {
      // 惰性创建（不能在循环里调 hook）
      mv = motionValue(base);
      targets.current.set(id, mv);
    }
    return mv;
  };
  const hoveredRef = useRef<string | null>(null);
  hoveredRef.current = hovered;

  const magnify = (x: number) => {
    const rects: [string, DOMRect][] = [];
    items.current.forEach((el, id) => rects.push([id, el.getBoundingClientRect()]));
    const half = gapOf(base) / 2;
    let hit: string | null = null;
    for (const [id, r] of rects) {
      const dx = Math.abs(x - (r.left + r.width / 2));
      targetOf(id).set(base + (magnification - 1) * base * falloff(dx / distance));
      if (x >= r.left - half && x <= r.right + half) hit = id;
    }
    if (hit && hit !== hoveredRef.current) {
      hoveredRef.current = hit;
      setHovered(hit);
      if (sound) sfx.tick();
    }
  };
  const rest = () => {
    targets.current.forEach((mv) => mv.set(base));
    hoveredRef.current = null;
    setHovered(null);
  };

  // 参数或容器变化：静止时直接回到新尺寸
  useEffect(() => {
    if (!hoveredRef.current) targets.current.forEach((mv) => mv.set(base));
  }, [base]);
  // 跨端或换了输入设备：放大和名称全部复原，切回桌面时从静止状态开始
  useEffect(() => {
    targets.current.forEach((mv) => mv.set(base));
    hoveredRef.current = null;
    setHovered(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end, mouse]);

  const onMove = (e: React.PointerEvent) => {
    if (magnifyRef.current) magnify(e.clientX);
  };
  const onLeave = (e: React.PointerEvent) => {
    // 只有指针真的离开程序坞才复原（在图标之间移动时浏览器也可能报 leave）
    const r = dockRef.current?.getBoundingClientRect();
    if (r && e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return;
    rest();
  };

  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  /** 记下图标相对窗口中心的位置，窗口从这里放大出来、收回这里。
   *  桌面 / iPad 的窗口在桌面区域里居中，手机的页面铺满整个组件；起始缩放在触屏端按图标和画面的宽度比算 */
  const rememberOrigin = (id: string, from?: Element | null) => {
    const root = rootRef.current;
    const known = launchedFrom.current.get(id);
    const button = from?.isConnected ? from : known?.isConnected ? known : root?.querySelector(`.magnify-dock__icon[data-app="${id}"]`);
    // 用图标外层（不带跳动的位移）量位置
    const icon = button?.parentElement;
    const stage = endRef.current === "phone" ? root : deskRef.current;
    if (!icon || !stage) return;
    if (button) launchedFrom.current.set(id, button);
    const a = icon.getBoundingClientRect();
    const d = stage.getBoundingClientRect();
    const s = endRef.current === "desktop" ? 0.08 : Math.min(0.3, Math.max(0.05, a.width / d.width));
    origins.current.set(id, { x: a.left + a.width / 2 - (d.left + d.width / 2), y: a.top + a.height / 2 - (d.top + d.height / 2), s });
  };

  const activate = (id: string, y: MotionValue<number>, from?: Element | null) => {
    rememberOrigin(id, from);
    if (front === id) {
      // 再点前台应用：退出
      animate(y, [0, 4, 0], { duration: 0.24, ease: "easeOut" });
      setRunning((r) => r.filter((x) => x !== id));
      setFront(null);
      if (sound) sfx.tap();
      return;
    }
    setRecent((r) => [id, ...r.filter((x) => x !== id)]);
    if (running.includes(id)) {
      // 已在运行：直接切到前台
      setFront(id);
      if (sound) sfx.tap();
      return;
    }
    setRunning((r) => [...r, id]);
    if (bounce && !reduce) {
      // 跳动高度按图标尺寸算：桌面是静止尺寸，触屏端是图标实际大小
      const size = endRef.current === "desktop" ? base : ((from?.parentElement as HTMLElement | null)?.offsetHeight ?? base);
      const h = size * 0.62;
      animate(y, [0, -h, 0, -h * 0.5, 0, -h * 0.18, 0], {
        duration: 1.1,
        times: [0, 0.2, 0.42, 0.58, 0.74, 0.86, 1],
        ease: ["easeOut", "easeIn", "easeOut", "easeIn", "easeOut", "easeIn"],
      });
      later(() => setFront(id), 820);
    } else {
      later(() => setFront(id), 80);
    }
    if (sound) sfx.pop();
  };

  const quitFront = () => {
    if (!front) return;
    rememberOrigin(front);
    setRunning((r) => r.filter((x) => x !== front));
    setFront(null);
    if (sound) sfx.tap();
  };

  const frontApp = APPS.find((a) => a.id === front) ?? null;
  const origin = (front && origins.current.get(front)) || { x: 0, y: 200, s: 0.08 };
  const exitTo = (frontApp && origins.current.get(frontApp.id)) || { x: 0, y: 200, s: 0.08 };

  // 触屏端（iPad / 手机）的图标尺寸基准：比桌面大一点，窄屏时 CSS 再按宽度收
  const touchBase = Math.round(baseSize * (end === "ipad" ? 1.3 : 1.25));
  const dockIds = end === "ipad" ? IPAD_DOCK : PHONE_DOCK;
  const homeIds = APPS.map((a) => a.id).filter((id) => !dockIds.includes(id));
  const recentIds = recent.filter((id) => !IPAD_DOCK.includes(id)).slice(0, IPAD_RECENT_MAX);

  return (
    <div
      className="magnify-dock"
      data-theme={theme}
      data-end={end}
      ref={rootRef}
      style={end === "desktop" ? undefined : ({ "--md-base": `${touchBase}px`, "--md-n": IPAD_DOCK.length + recentIds.length } as React.CSSProperties)}
    >
      {end === "desktop" ? (
        <header className="magnify-dock__bar" aria-hidden>
          <span className="magnify-dock__bar-app">{frontApp?.name ?? "桌面"}</span>
          <span>文件</span>
          <span>编辑</span>
          <span>显示</span>
          <span className="magnify-dock__bar-time">9:41</span>
        </header>
      ) : (
        <StatusBar end={end} />
      )}

      <div className="magnify-dock__desk" ref={deskRef}>
        {/* iPad / 手机：主屏上放程序坞以外的 App */}
        {end !== "desktop" && (
          <div className="magnify-dock__home" aria-label="主屏幕">
            {end === "ipad" && (
              <div className="magnify-dock__widget" aria-hidden>
                <span>周二</span>
                <strong>9</strong>
                <i style={{ width: "78%" }} />
                <i style={{ width: "52%" }} />
              </div>
            )}
            {homeIds.map((id) => (
              <div key={id} className="magnify-dock__app">
                <TouchIcon app={appOf(id)} onActivate={activate} />
                {labels && <span className="magnify-dock__app-name">{appOf(id).name}</span>}
              </div>
            ))}
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {frontApp && (
            <motion.section
              key={frontApp.id}
              className="magnify-dock__window"
              aria-label={`${frontApp.name} 窗口`}
              initial={{ opacity: 0, scale: origin.s, x: origin.x, y: origin.y }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0, transition: { duration: 0.42, ease: OPEN_EASE, opacity: { duration: 0.12 } } }}
              exit={{
                opacity: 0,
                scale: exitTo.s,
                x: exitTo.x,
                y: exitTo.y,
                transition: { duration: 0.32, ease: [0.5, 0, 0.75, 0.2], opacity: { duration: 0.1, delay: 0.22 } },
              }}
            >
              {end === "desktop" ? (
                <div className="magnify-dock__titlebar">
                  <button type="button" className="is-close magnify-dock__close" aria-label={`退出${frontApp.name}`} onClick={quitFront} />
                  <i />
                  <i />
                  <span>{frontApp.name}</span>
                </div>
              ) : (
                // 触屏端：iPad 顶部是多任务的三个点、左上角关闭；手机是带「返回」的导航栏
                <>
                  {end === "ipad" && (
                    <div className="magnify-dock__grabber" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                  <div className="magnify-dock__navbar">
                    {end === "ipad" ? (
                      <button type="button" className="magnify-dock__close magnify-dock__close--round" aria-label={`关闭${frontApp.name}`} onClick={quitFront}>
                        <X strokeWidth={2.4} />
                      </button>
                    ) : (
                      <button type="button" className="magnify-dock__close magnify-dock__close--back" aria-label="返回主屏幕" onClick={quitFront}>
                        <ChevronLeft strokeWidth={2.4} />
                        返回
                      </button>
                    )}
                    <span>{frontApp.name}</span>
                  </div>
                </>
              )}
              <div className="magnify-dock__window-body">
                <span className="magnify-dock__tile" style={tileStyle(frontApp)}>
                  <frontApp.Icon />
                </span>
                <div className="magnify-dock__lines">
                  <strong>{frontApp.name}</strong>
                  <span>{end === "desktop" ? "再点一次图标，或点红点退出" : end === "ipad" ? "再点一次程序坞图标，或点左上角关闭" : "点左上角返回，或点底部横条回到主屏"}</span>
                  <i style={{ width: "86%" }} />
                  <i style={{ width: "64%" }} />
                </div>
              </div>
              {end !== "desktop" && (
                <div className="magnify-dock__rows" aria-hidden>
                  {[92, 70, 84, 58, 76, 66].map((w, i) => (
                    <div key={i}>
                      <b />
                      <i style={{ width: `${w}%` }} />
                    </div>
                  ))}
                </div>
              )}
            </motion.section>
          )}
        </AnimatePresence>
      </div>

      {end === "desktop" ? (
        <div
          ref={dockRef}
          className="magnify-dock__dock"
          role="toolbar"
          aria-label="程序坞"
          style={{ gap: gapOf(base), padding: padOf(base), height: base + padOf(base) * 2 }}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          onPointerUp={(e) => e.pointerType !== "mouse" && rest()}
          onPointerCancel={rest}
        >
          {apps.map((app) => (
            <DockItem
              key={app.id}
              app={app}
              target={targetOf(app.id)}
              running={running.includes(app.id)}
              hovered={hovered === app.id}
              showLabel={labels}
              register={(el) => {
                if (el) items.current.set(app.id, el);
                else items.current.delete(app.id);
              }}
              onFocus={() => setHovered(app.id)}
              onBlur={() => setHovered((h) => (h === app.id ? null : h))}
              onActivate={activate}
            />
          ))}
        </div>
      ) : (
        // iPad：悬浮圆角程序坞，左常用、竖线、右最近使用；手机：4 个图标的毛玻璃程序坞
        <div className={`magnify-dock__dock magnify-dock__dock--${end}`} role="toolbar" aria-label="程序坞">
          {dockIds.map((id) => (
            <TouchIcon key={id} app={appOf(id)} onActivate={activate} />
          ))}
          {end === "ipad" && (
            <AnimatePresence initial={false}>
              {recentIds.length > 0 && <motion.span key="divider" layout className="magnify-dock__divider" aria-hidden />}
              {recentIds.map((id) => (
                <TouchIcon key={`recent-${id}`} app={appOf(id)} onActivate={activate} enter />
              ))}
            </AnimatePresence>
          )}
        </div>
      )}

      {/* 手机底部的主屏横条：打开 App 时点它回到主屏 */}
      {end === "phone" &&
        (frontApp ? (
          <button type="button" className="magnify-dock__homebar" aria-label="回到主屏幕" onClick={quitFront}>
            <i />
          </button>
        ) : (
          <span className="magnify-dock__homebar" aria-hidden>
            <i />
          </span>
        ))}
    </div>
  );
}

function tileStyle(app: App): React.CSSProperties {
  return { background: `linear-gradient(160deg, ${app.a}, ${app.b})`, color: app.fg ?? "#fff" };
}

/** iPad / iOS 状态栏：左边时间（iPad 带日期），右边信号、Wi-Fi、电量 */
function StatusBar({ end }: { end: End }) {
  return (
    <header className="magnify-dock__status" aria-hidden>
      <span className="magnify-dock__status-time">
        9:41
        {end === "ipad" && <em>1月9日 周二</em>}
      </span>
      <span className="magnify-dock__status-icons">
        {end === "phone" && (
          <svg viewBox="0 0 18 12" width="18" height="12">
            <rect x="0" y="7.5" width="3" height="4.5" rx="1" />
            <rect x="5" y="5" width="3" height="7" rx="1" />
            <rect x="10" y="2.5" width="3" height="9.5" rx="1" />
            <rect x="15" y="0" width="3" height="12" rx="1" />
          </svg>
        )}
        <svg viewBox="0 0 16 12" width="16" height="12">
          <path d="M8 11.4 5.5 8.9a3.5 3.5 0 0 1 5 0z" />
          <path d="M3.2 6.6a6.8 6.8 0 0 1 9.6 0l-1.4 1.4a4.8 4.8 0 0 0-6.8 0z" />
          <path d="M.9 4.3a10 10 0 0 1 14.2 0l-1.4 1.4a8 8 0 0 0-11.4 0z" />
        </svg>
        {end === "ipad" && <span className="magnify-dock__status-pct">100%</span>}
        <svg viewBox="0 0 27 12" width="27" height="12">
          <rect x="0.5" y="0.5" width="22" height="11" rx="3.4" fill="none" stroke="currentColor" opacity="0.4" />
          <rect x="2" y="2" width="19" height="8" rx="2" />
          <path d="M24 4v4c.8-.3 1.4-1.1 1.4-2S24.8 4.3 24 4z" opacity="0.4" />
        </svg>
      </span>
    </header>
  );
}

/** 触屏端的图标：按下压小变暗、松手回弹；点开时和桌面一样会跳动（启动跳动参数） */
function TouchIcon({ app, onActivate, enter = false }: { app: App; onActivate: (id: string, y: MotionValue<number>, from?: Element | null) => void; enter?: boolean }) {
  const y = useMotionValue(0);
  return (
    <motion.div
      className="magnify-dock__tap"
      layout={enter ? "position" : false}
      initial={enter ? { scale: 0, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0, transition: { duration: 0.16 } }}
      transition={{ duration: 0.3, ease: [0.28, 1.3, 0.36, 1] }}
    >
      <motion.button
        type="button"
        className="magnify-dock__icon"
        data-app={app.id}
        aria-label={`打开${app.name}`}
        style={{ ...tileStyle(app), y, filter: "brightness(1)" }}
        whileTap={{ scale: 0.86, filter: "brightness(0.8)", transition: PRESS }}
        transition={RELEASE}
        onClick={(e) => onActivate(app.id, y, e.currentTarget)}
      >
        <app.Icon strokeWidth={2} />
      </motion.button>
    </motion.div>
  );
}

function DockItem({
  app,
  target,
  running,
  hovered,
  showLabel,
  register,
  onFocus,
  onBlur,
  onActivate,
}: {
  app: App;
  target: MotionValue<number>;
  running: boolean;
  hovered: boolean;
  showLabel: boolean;
  register: (el: HTMLElement | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onActivate: (id: string, y: MotionValue<number>, from?: Element | null) => void;
}) {
  const y = useMotionValue(0);
  const size = useSpring(target, { mass: 0.1, stiffness: 190, damping: 13 });

  return (
    <>
      {app.divider && <span className="magnify-dock__divider" aria-hidden />}
      <motion.div ref={register} className="magnify-dock__item" style={{ width: size, height: size }}>
        <AnimatePresence>
          {hovered && showLabel && (
            <motion.span
              className="magnify-dock__label"
              initial={{ opacity: 0, y: 6, scale: 0.9, x: "-50%" }}
              animate={{ opacity: 1, y: 0, scale: 1, x: "-50%" }}
              exit={{ opacity: 0, scale: 0.96, x: "-50%", transition: { duration: 0.07 } }}
              transition={{ duration: 0.24, ease: [0.28, 1.3, 0.36, 1] }}
            >
              {app.name}
            </motion.span>
          )}
        </AnimatePresence>
        <motion.button
          type="button"
          className="magnify-dock__icon"
          data-app={app.id}
          aria-label={running ? `${app.name}（运行中）` : `打开${app.name}`}
          style={{ ...tileStyle(app), y }}
          whileTap={{ scale: 0.92 }}
          transition={{ duration: 0.09, ease: "easeOut" }}
          onClick={(e) => onActivate(app.id, y, e.currentTarget)}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <app.Icon strokeWidth={2} />
        </motion.button>
        <AnimatePresence>
          {running && (
            <motion.span
              className="magnify-dock__dot"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.28, 1.3, 0.36, 1] }}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </>
  );
}
