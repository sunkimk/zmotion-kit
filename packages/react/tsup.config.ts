// 打包成一个 ESM 文件：CSS 注入到 JS 里（用的人不用另外引样式），顶部加 "use client"（Next.js App Router 可直接用）
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  injectStyle: true,
  external: ["react", "react-dom", "react/jsx-runtime", "motion", "motion/react", "lucide-react"],
  banner: { js: '"use client";' },
});
