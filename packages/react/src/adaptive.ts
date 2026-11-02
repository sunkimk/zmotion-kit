// 多端适配：按组件自己的宽度分 手机 / iPad / 桌面 三段，按真实设备分鼠标 / 触屏。
// 用法：
//   const ref = useRef<HTMLDivElement>(null);
//   const end = useEnd(ref);          // "phone" | "ipad" | "desktop"，组件根元素变宽变窄时自动更新
//   const mouse = useFinePointer();   // 有鼠标（能悬停）为 true，触屏为 false
// CSS 里用容器查询写同样的断点：@container (min-width: 600px) { … }  @container (min-width: 900px) { … }
// （组件根元素设 container-type: size，里面的子元素就能按根元素宽度查询）
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export type End = "phone" | "ipad" | "desktop";

/** 断点：宽度 ≥ 600 算 iPad，≥ 900 算桌面（和 CSS 容器查询保持一致） */
export const BREAKPOINTS = { ipad: 600, desktop: 900 } as const;

export function endOf(width: number): End {
  return width >= BREAKPOINTS.desktop ? "desktop" : width >= BREAKPOINTS.ipad ? "ipad" : "phone";
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** 组件当前处在哪一端；只在跨过断点时更新，拖动改宽度时不会每帧重渲染。
 *  量的是根元素外框宽度（含内边距）：根元素有 padding 时，CSS 容器查询（量内容宽）要把断点减去左右内边距 */
export function useEnd(ref: RefObject<HTMLElement | null>): End {
  const [end, setEnd] = useState<End>("phone");
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setEnd(endOf(el.offsetWidth));
    const ro = new ResizeObserver(([entry]) => setEnd(endOf(entry.borderBoxSize?.[0]?.inlineSize ?? el.offsetWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return end;
}

/** 是否有能悬停的精确指针（鼠标、触控板）；手机、平板触屏为 false */
export function useFinePointer(): boolean {
  const query = "(hover: hover) and (pointer: fine)";
  const [fine, setFine] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setFine(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return fine;
}
