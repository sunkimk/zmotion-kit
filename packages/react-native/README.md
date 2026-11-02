# zmotion-native

[Zmotion](https://zzmotion.vercel.app) 交互动效的 React Native 版（Reanimated + Gesture Handler），动效参数和网页版一致。需要 React Native 0.76+。

```bash
npm install zmotion-native react-native-reanimated react-native-gesture-handler
```

按 Reanimated、Gesture Handler 的官方说明配置好（babel 插件、GestureHandlerRootView）后：

```tsx
import { LikeBurst } from "zmotion-native";

<LikeBurst color="#FF3B5C" particles={12} />
```

目前有：LikeBurst、LiquidToggle、SwipeDeck，其余组件陆续补上。React 和 SwiftUI 版见 [zmotion-kit](https://github.com/sunkimk/zmotion-kit)。

MIT
