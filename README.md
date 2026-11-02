# Zmotion Kit

[Zmotion](https://zzmotion.vercel.app) 交互动效的组件包：同一套动效，React、SwiftUI、React Native 三个平台各一份，弹簧参数、时长和手势手感保持一致。在网站上调好参数，代码页会给出对应平台的安装命令和用法。

| 平台 | 包 | 说明 |
|---|---|---|
| React | `npm install @zmotion/react` | motion（Framer Motion）实现，样式已内置；想自己改可以从网站代码页复制源码 |
| SwiftUI | Swift Package `ZmotionKit`（iOS 17+） | Xcode：File › Add Package Dependencies… 粘贴本仓库地址 |
| React Native | `npm install @zmotion/react-native react-native-reanimated react-native-gesture-handler` | Reanimated + Gesture Handler 实现 |

## 用法

```tsx
// React
import { LikeBurst } from "@zmotion/react";
<LikeBurst color="#FF3B5C" particles={12} />

// React Native
import { LikeBurst } from "@zmotion/react-native";
<LikeBurst color="#FF3B5C" particles={12} />
```

```swift
// SwiftUI
import ZmotionKit

LikeBurst(color: Color(hex: "#FF3B5C"), particles: 12)
```

每个组件的参数和网站上参数卡一致（名字相同）；SwiftUI 里颜色是 `Color`、数字是 `Double`、选项是枚举（如 `.arc`）。网页版的音效在原生端换成触感反馈（SwiftUI 的 `haptics` 参数）。

## 目录

```
Package.swift               Swift Package（ZmotionKit）
Sources/ZmotionKit/         SwiftUI 组件（每个组件一个文件，Support.swift 是共用工具）
packages/react/             npm 包 @zmotion/react（src 由 Zmotion 网站的 scripts/sync-kit.mjs 同步，不要手改）
packages/react-native/      npm 包 @zmotion/react-native
```

12 个组件三个平台都有。原生版只包含组件本身，不画网页演示里的手机外壳（状态栏、导航栏、主屏），内容和结果通过参数、回调和你的 App 对接；各组件的 API 见源码顶部注释和 `#Preview`。

## 许可

MIT
