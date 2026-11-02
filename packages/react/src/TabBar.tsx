"use client";
import { useEffect, useId, useRef, useState } from "react";
import { motion, AnimatePresence, LayoutGroup, useMotionValue, animate, type Variants } from "motion/react";
import { House, Compass, MessageCircle, User, Search, ChevronRight, Bell, Settings, Star, Clock, Wallet, Heart } from "lucide-react";
import { sfx } from "./sfx";
import { useEnd } from "./adaptive";
import "./TabBar.css";

type Props = {
  indicator?: "pill" | "underline" | "dot";
  color?: string;
  showLabels?: boolean;
  stiffness?: number;
  theme?: "light" | "dark";
  sound?: boolean;
};

const TABS = [
  { key: "home", label: "首页", Icon: House },
  { key: "discover", label: "发现", Icon: Compass },
  { key: "inbox", label: "消息", Icon: MessageCircle },
  { key: "me", label: "我的", Icon: User },
] as const;

// 页面切换的方向跟着栏走：手机、iPad 栏在底部，按左右进出；桌面栏在左侧竖排，按上下进出
type Swap = { d: number; v: boolean };
const pageSpring = { type: "spring", stiffness: 380, damping: 38 } as const;
const pageVariants: Variants = {
  enter: ({ d, v }: Swap) => (v ? { y: d * 44, opacity: 0 } : { x: d * 44, opacity: 0 }),
  center: { x: 0, y: 0, opacity: 1 },
  // 离开的页面淡得更快，连点时不会好几层叠在一起
  exit: ({ d, v }: Swap) => ({
    ...(v ? { y: d * -44 } : { x: d * -44 }),
    opacity: 0,
    transition: { x: pageSpring, y: pageSpring, opacity: { duration: 0.12 } },
  }),
};
const pageTransition = { x: pageSpring, y: pageSpring, opacity: { duration: 0.2, ease: [0.33, 0.55, 0.2, 1] } } as const;

// 胶囊的圆角按端换：手机、iPad 底栏是大圆角，桌面侧栏的格子更方一些
const PILL_RADIUS = { phone: 22, ipad: 22, desktop: 12 } as const;

export default function TabBar({
  indicator = "pill",
  color = "#5B5BF6",
  showLabels = true,
  stiffness = 420,
  theme = "light",
  sound = true,
}: Props) {
  const [active, setActive] = useState(0);
  const [dir, setDir] = useState(1);
  const [taps, setTaps] = useState([0, 0, 0, 0]);
  const [badge, setBadge] = useState(3);
  const group = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // 按组件自己的宽度分端：手机底部标签栏，iPad 底部居中的横排标签栏，桌面带文字的侧边栏（布局在 CSS 容器查询里）
  const end = useEnd(rootRef);
  const vertical = end === "desktop";
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const badgeTimer = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => () => clearTimeout(badgeTimer.current), []);

  const select = (i: number) => {
    const prev = activeRef.current;
    setTaps((t) => t.map((n, j) => (j === i ? n + 1 : n)));
    if (sound) sfx.tap();
    if (i === prev) return;
    activeRef.current = i;
    setDir(i > prev ? 1 : -1);
    setActive(i);
    clearTimeout(badgeTimer.current);
    if (i === 2) setBadge(0);
    else if (prev === 2) badgeTimer.current = window.setTimeout(() => setBadge(1), 2400);
  };

  // 方向键切换：横栏用左右，竖栏用上下
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = vertical ? "ArrowDown" : "ArrowRight";
    const prev = vertical ? "ArrowUp" : "ArrowLeft";
    if (e.key !== next && e.key !== prev) return;
    e.preventDefault();
    const i = (active + (e.key === next ? 1 : -1) + TABS.length) % TABS.length;
    select(i);
    tabRefs.current[i]?.focus();
  };

  // 指示器：阻尼比约 0.62，到位时轻轻过冲一点再停
  const slide = { type: "spring", stiffness, damping: 1.24 * Math.sqrt(stiffness) } as const;

  return (
    <LayoutGroup id={group}>
      <div
        ref={rootRef}
        className="tab-bar"
        data-theme={theme}
        data-indicator={indicator}
        data-compact={showLabels ? undefined : ""}
        style={{ "--tab": color } as React.CSSProperties}
      >
        <div className="tab-bar__inner">
          <StatusBar />
          {/* 应用名：只在桌面侧边栏顶部显示（其它端由 CSS 隐藏） */}
          <div className="tab-bar__brand" aria-hidden>
            <i>狐</i>
            <span>狐狸日常</span>
          </div>
          <div className="tab-bar__screen">
            <AnimatePresence initial={false} custom={{ d: dir, v: vertical }}>
              <motion.div
                key={active}
                className="tab-bar__page"
                role="tabpanel"
                aria-label={TABS[active].label}
                custom={{ d: dir, v: vertical }}
                variants={pageVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={pageTransition}
              >
                <Page tab={TABS[active].key} cols={end === "desktop" ? 3 : 2} />
              </motion.div>
            </AnimatePresence>
          </div>

          <nav
            className={`tab-bar__bar${showLabels ? "" : " is-compact"}`}
            role="tablist"
            aria-label="主导航"
            aria-orientation={vertical ? "vertical" : undefined}
            onKeyDown={onKeyDown}
          >
            {TABS.map(({ key, label, Icon }, i) => {
              const on = i === active;
              return (
                <TabButton
                  key={key}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  on={on}
                  label={label}
                  taps={taps[i]}
                  stiffness={stiffness}
                  showLabel={showLabels}
                  labelAxis={end === "phone" ? "height" : "width"}
                  onSelect={() => select(i)}
                  icon={<Icon size={end === "desktop" ? 20 : 23} strokeWidth={on ? 2.3 : 1.9} />}
                  badge={key === "inbox" ? badge : 0}
                  indicator={on ? <Indicator kind={indicator} transition={slide} pillRadius={PILL_RADIUS[end]} /> : null}
                  indicatorKind={indicator}
                />
              );
            })}
          </nav>
        </div>
      </div>
    </LayoutGroup>
  );
}

// 指示器用 layoutId 在标签之间飞：横栏里横着滑，竖栏里竖着滑，弹簧是同一个
function Indicator({ kind, transition, pillRadius }: { kind: string; transition: object; pillRadius: number }) {
  if (kind === "underline") return <motion.span layoutId="tab-bar-indicator" className="tab-bar__underline" style={{ borderRadius: 2 }} transition={transition} />;
  if (kind === "dot") return <motion.span layoutId="tab-bar-indicator" className="tab-bar__dot" style={{ borderRadius: 3 }} transition={transition} />;
  return <motion.span layoutId="tab-bar-indicator" className="tab-bar__pill" style={{ borderRadius: pillRadius }} transition={transition} />;
}

type TabButtonProps = {
  ref: (el: HTMLButtonElement | null) => void;
  on: boolean;
  label: string;
  taps: number;
  stiffness: number;
  showLabel: boolean;
  labelAxis: "height" | "width";
  onSelect: () => void;
  icon: React.ReactNode;
  badge: number;
  indicator: React.ReactNode;
  indicatorKind: string;
};

/**
 * 图标的按压和弹跳用 motion value 驱动：按下 90ms 缩到 0.86，
 * 松手时从「当前」状态带着初速度弹回，所以连点、打断都不会跳。
 */
function TabButton({ ref, on, label, taps, stiffness, showLabel, labelAxis, onSelect, icon, badge, indicator, indicatorKind }: TabButtonProps) {
  const scale = useMotionValue(1);
  const y = useMotionValue(0);
  const k = stiffness * 1.2;
  const bounce = { type: "spring", stiffness: k, damping: 0.85 * Math.sqrt(k) } as const;

  const press = () => animate(scale, 0.86, { duration: 0.09, ease: [0.33, 0.55, 0.2, 1] });
  const release = () => animate(scale, 1, { ...bounce, velocity: scale.get() < 0.95 ? 3 : 0 });

  useEffect(() => {
    if (!taps) return;
    // 选中时图标往上一跳：给一个向上的初速度，交给弹簧收回
    animate(y, 0, { ...bounce, velocity: -240 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taps]);

  return (
    <button
      ref={ref}
      className={`tab-bar__tab${on ? " is-active" : ""}`}
      role="tab"
      aria-selected={on}
      aria-label={label}
      tabIndex={on ? 0 : -1}
      onPointerDown={(e) => e.button === 0 && press()}
      onPointerUp={release}
      onPointerLeave={() => scale.get() < 1 && release()}
      onPointerCancel={release}
      onClick={onSelect}
    >
      {indicatorKind === "pill" && indicator}
      <motion.span className="tab-bar__icon" style={{ scale, y }}>
        {icon}
        <AnimatePresence>
          {badge > 0 && (
            <motion.span
              key="badge"
              className="tab-bar__badge"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 560, damping: 22 }}
            >
              {badge}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.span>
      {/* 文字收起 / 展开：图标在上、文字在下时收高度；iPad、桌面图标和文字横排时收宽度。
          展开态宽高都写 auto，跨端切换后不会残留上一端量出来的尺寸 */}
      <AnimatePresence initial={false}>
        {showLabel && (
          <motion.span
            className="tab-bar__label"
            initial={{ opacity: 0, [labelAxis]: 0 }}
            animate={{ opacity: 1, height: "auto", width: "auto" }}
            exit={{ opacity: 0, [labelAxis]: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
      {indicatorKind !== "pill" && indicator}
    </button>
  );
}

function StatusBar() {
  return (
    <div className="tab-bar__status" aria-hidden>
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

const SHOTS: [string, string, string, string, number][] = [
  ["#FDE68A", "#F97316", "落日公路", "阿远", 196],
  ["#A5F3FC", "#6366F1", "玻璃质感图标", "Lumi", 150],
  ["#BBF7D0", "#14B8A6", "森林小屋", "木木", 150],
  ["#FBCFE8", "#A855F7", "霓虹夜", "Kiki", 210],
  ["#FECACA", "#F43F5E", "草莓汽水", "小橘", 170],
  ["#C7D2FE", "#0EA5E9", "云端", "Ocean", 170],
];

/** cols：发现页瀑布流的列数，手机和 iPad 两列，桌面三列 */
function Page({ tab, cols }: { tab: (typeof TABS)[number]["key"]; cols: number }) {
  if (tab === "home")
    return (
      <>
        <header className="tab-bar__head">
          <div>
            <small>10月29日 星期四</small>
            <h2>早上好，小狐</h2>
          </div>
          <span className="tab-bar__round" aria-hidden>
            <Bell size={18} />
          </span>
        </header>
        <div className="tab-bar__hero">
          <span>今日专注</span>
          <strong>2 小时 15 分</strong>
          <div className="tab-bar__progress">
            <i style={{ width: "68%" }} />
          </div>
          <small>已完成今日目标的 68%，再坚持 40 分钟</small>
        </div>
        <div className="tab-bar__tiles">
          {[
            ["🧘", "冥想", "10 分钟"],
            ["📚", "阅读", "第 12 章"],
            ["🏃", "跑步", "3.2 公里"],
            ["💧", "喝水", "5 / 8 杯"],
          ].map(([e, t, s]) => (
            <div key={t} className="tab-bar__tile">
              <span>{e}</span>
              <b>{t}</b>
              <small>{s}</small>
            </div>
          ))}
        </div>
        {/* 「接下来」包成一块：大屏网格里作为一张卡片整体排列 */}
        <div className="tab-bar__next">
          <h3 className="tab-bar__section">接下来</h3>
          <ul className="tab-bar__agenda">
            {[
              ["14:00", "设计评审", "会议室 B · 45 分钟"],
              ["19:30", "夜跑", "滨江步道 · 5 公里"],
            ].map(([t, n, d]) => (
              <li key={t}>
                <time>{t}</time>
                <div>
                  <b>{n}</b>
                  <small>{d}</small>
                </div>
                <Clock size={16} />
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  if (tab === "discover")
    return (
      <>
        <header className="tab-bar__head">
          <h2>发现</h2>
        </header>
        <div className="tab-bar__search">
          <Search size={16} /> 搜索灵感、作者、话题
        </div>
        <div className="tab-bar__chips">
          {["推荐", "动效", "插画", "摄影", "3D", "字体"].map((c, i) => (
            <span key={c} className={i === 0 ? "is-on" : ""}>
              {c}
            </span>
          ))}
        </div>
        <div className="tab-bar__grid">
          {Array.from({ length: cols }, (_, col) => (
            <div key={col} className="tab-bar__col">
              {SHOTS.filter((_, i) => i % cols === col).map(([a, b, t, by, h]) => (
                // 大屏列更宽，卡片高度按 --shot-k 等比放高（手机为 1）
                <div key={t} className="tab-bar__shot" style={{ background: `linear-gradient(150deg, ${a}, ${b})`, height: `calc(${h}px * var(--shot-k, 1))` }}>
                  <span>
                    <b>{t}</b>
                    <small>
                      <Heart size={11} fill="currentColor" /> {by}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </>
    );
  if (tab === "inbox")
    return (
      <>
        <header className="tab-bar__head">
          <h2>消息</h2>
        </header>
        <ul className="tab-bar__chats">
          {[
            ["🐻", "#FED7AA", "小熊", "周六去爬山吗？我带零食", "09:41", true],
            ["🎨", "#DDD6FE", "设计小组", "阿远：新版图标已经上传了", "09:12", true],
            ["🌙", "#BFDBFE", "阿月", "晚安，明天见～", "昨天", true],
            ["🍜", "#FECACA", "楼下面馆", "您的外卖已送达，祝您用餐愉快", "昨天", false],
            ["🎮", "#BBF7D0", "游戏搭子", "上号！今晚三排", "周一", false],
            ["📦", "#FDE68A", "快递助手", "您的包裹已到驿站，取件码 6-2-0917", "周一", false],
            ["🐶", "#E9D5FF", "豆豆妈", "[图片]", "周日", false],
          ].map(([e, bg, n, m, t, unread]) => (
            <li key={n as string}>
              <span className="tab-bar__avatar" style={{ background: bg as string }}>
                {e}
              </span>
              <div>
                <b>{n}</b>
                <small>{m}</small>
              </div>
              <time>{t}</time>
              {unread && <i className="tab-bar__unread" />}
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <>
      <header className="tab-bar__head">
        <h2>我的</h2>
        <span className="tab-bar__round" aria-hidden>
          <Settings size={18} />
        </span>
      </header>
      <div className="tab-bar__profile">
        <span className="tab-bar__me">🦊</span>
        <div>
          <b>狐狸不睡觉</b>
          <small>交互设计师 · 上海</small>
        </div>
      </div>
      <div className="tab-bar__stats">
        {[
          ["128", "关注"],
          ["2.4k", "粉丝"],
          ["9.6k", "获赞"],
        ].map(([n, l]) => (
          <div key={l}>
            <b>{n}</b>
            <small>{l}</small>
          </div>
        ))}
      </div>
      <div className="tab-bar__vip">
        <div>
          <b>Pro 会员</b>
          <small>还有 23 天到期 · 续费享 8 折</small>
        </div>
        <span>续费</span>
      </div>
      <ul className="tab-bar__menu">
        {[
          [Star, "我的收藏", "36"],
          [Wallet, "钱包", ""],
          [Bell, "通知设置", ""],
          [Settings, "通用", ""],
        ].map(([I, t, n]) => {
          const Ico = I as typeof Star;
          return (
            <li key={t as string}>
              <Ico size={18} /> <span>{t as string}</span>
              {n ? <em>{n as string}</em> : null}
              <ChevronRight size={16} />
            </li>
          );
        })}
      </ul>
    </>
  );
}
