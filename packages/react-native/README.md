# @zmotion/react-native

[Zmotion](https://zzmotion.vercel.app) 交互动效的 React Native 版（Reanimated + Gesture Handler），动效参数和网页版一致。需要 React Native 0.76+。

```bash
npm install @zmotion/react-native react-native-reanimated react-native-gesture-handler
```

按 Reanimated、Gesture Handler 的官方说明配置好（babel 插件、GestureHandlerRootView）后：

```tsx
import { LikeBurst } from "@zmotion/react-native";

<LikeBurst color="#FF3B5C" particles={12} />
```

包含全部 12 个组件：LikeBurst、LiquidToggle、SwipeDeck、DotLoader、RollingCounter、MagneticButton、ImageCompare、SlideToConfirm、PullToRefresh、DynamicIsland、TabBar、MagnifyDock。部分配图用到的径向渐变需要 RN 0.80+，更早的版本会少掉这些层。React 和 SwiftUI 版见 [zmotion-kit](https://github.com/sunkimk/zmotion-kit)。

MIT
