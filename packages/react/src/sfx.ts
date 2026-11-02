// 交互音效：用 Web Audio 现场合成，不需要音频文件。
// 用法：import { sfx } from "./sfx";  sfx.tick();  （受组件的 sound 属性控制）

let ctx: AudioContext | null = null;

function audio() {
  if (typeof window === "undefined") return null;
  // 在 Zmotion 网站里运行时，借用外层页面提前启动好的音频引擎，第一次出声不卡顿；单独使用时自己创建
  try {
    const host = (window.parent as Window & { __zmotionAudio?: AudioContext }).__zmotionAudio;
    if (host) {
      if (host.state === "suspended") void host.resume();
      return host;
    }
  } catch {}
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, duration: number, opts: { type?: OscillatorType; gain?: number; to?: number } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + duration);
  g.gain.setValueAtTime(opts.gain ?? 0.12, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

export const sfx = {
  /** 很短的咔哒，用于刻度、步进 */
  tick: () => tone(1800, 0.03, { type: "square", gain: 0.03 }),
  /** 轻按 */
  tap: () => tone(520, 0.06, { type: "triangle", gain: 0.1, to: 300 }),
  /** 弹出、点亮 */
  pop: () => tone(380, 0.12, { type: "sine", gain: 0.16, to: 900 }),
  /** 完成、确认 */
  success: () => {
    tone(660, 0.12, { type: "sine", gain: 0.1 });
    setTimeout(() => tone(990, 0.18, { type: "sine", gain: 0.1 }), 90);
  },
  /** 滑走、甩出 */
  whoosh: () => tone(900, 0.18, { type: "sawtooth", gain: 0.025, to: 120 }),
};
