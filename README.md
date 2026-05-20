# vite-plugin-iconify-offline

[![npm version](https://img.shields.io/npm/v/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)
[![npm downloads](https://img.shields.io/npm/dm/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)
[![npm license](https://img.shields.io/npm/l/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)

构建时自动扫描 Iconify 图标引用，将用到的图标数据预注册到运行时，实现**零网络请求、零运行时开销**的离线图标方案。

## 原理

1. **扫描** — `buildStart` 钩子中递归扫描 `src/` 目录，正则匹配 `"prefix:icon-name"` 模式的图标引用，自动过滤 Tailwind / Vue 修饰符等误报
2. **提取** — 从 `@iconify-json/*` 包中加载图标数据，仅保留用到的图标（含别名解析）
3. **生成** — 通过 `this.emitFile` 生成独立的图标注册 chunk，绕过 rolldown tree-shaking
4. **注入** — `writeBundle` 钩子将 chunk 的 `<script>` 标签注入到 `dist/index.html`，在主 bundle 之前加载
5. **共享** — chunk 和主 bundle 共享同一个 `@iconify/vue` 模块实例，`addCollection` 写入的 storage 就是 Icon 组件查询的 storage

## 安装

```bash
npm i -D vite-plugin-iconify-offline
# 安装你需要的图标集
npm i -D @iconify-json/lucide @iconify-json/mdi
```

## 使用

插件会自动从你的 Vite 插件列表检测框架，零配置即可使用：

```ts
// vite.config.ts
import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "vite-plugin-iconify-offline"

export default defineConfig({
  plugins: [
    vue(),            // ← 插件检测到这行，自动选择 @iconify/vue
    iconifyOffline(), // ← 无需指定 package
  ],
})
```

### 其他框架（自动检测）

```ts
// React — 自动检测到 @vitejs/plugin-react → 选择 @iconify/react
plugins: [react(), iconifyOffline()]

// SolidJS — 自动检测到 vite-plugin-solid → 选择 @iconify-icon/solid
plugins: [solid(), iconifyOffline()]
```

### 手动指定（覆盖自动检测）

```ts
// 显式指定离线版
iconifyOffline({ package: "@iconify/vue/offline" })

// 显式指定主包（自动检测失败时也可以这样写）
iconifyOffline({ package: "@iconify/vue" })
```

前提：目标包必须导出 `addCollection` 函数。

## 配置选项

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `package` | `string` | 自动检测 | Iconify 图标组件包名。不指定时自动从 Vite 插件检测框架（vue→`@iconify/vue`、react→`@iconify/react`、solid→`@iconify-icon/solid`） |
| `scanDir` | `string` | `"src"` | 自定义扫描目录，设为 `"."` 可扫描整个项目 |
| `verbose` | `boolean` | `true` | 是否在控制台输出详细日志 |

## 工作流程

```
构建开始
  │
  ├─ buildStart 钩子
  │   ├─ 递归扫描 src/ 下的 .ts/.tsx/.js/.jsx/.vue/.svelte 文件
  │   ├─ 提取所有 "prefix:icon-name" 引用，过滤误报
  │   ├─ 从 @iconify-json/* 加载并精简图标数据
  │   └─ this.emitFile 注册虚拟模块 chunk
  │
  ├─ resolveId → load
  │   └─ 返回图标注册代码（import addCollection + addCollection 调用）
  │
  ├─ Vite 打包
  │   ├─ 图标 chunk 被正常打包（与主 bundle 共享 @iconify/vue 实例）
  │   └─ 不被 tree-shake
  │
  └─ writeBundle 钩子
      └─ 将图标 chunk 的 <script> 注入到 index.html（在主 bundle 之前）
```

## 为什么选择 `@iconify/vue` 而非 `@iconify/vue/offline`

- `@iconify/vue`（主包）和插件生成的 chunk **共享同一模块实例**，`addCollection` 直接写入 Icon 组件查询的 storage
- `@iconify/vue/offline` 有自己**私有的 storage**，与主包不共享，需额外处理
- 对于未被扫描到的动态图标（如 `:icon="\`lucide:${name}\`"`），主包至少能降级在线加载，offline 版直接显示空白

如果确定所有图标引用都是静态字符串且希望彻底断网，仍可指定 `package: "@iconify/vue/offline"`。

## 动态图标

插件仅扫描**字符串字面量**格式的图标引用（`"lucide:sun"`、`'mdi:home'`）。动态表达式（如 `` `lucide:${name}` ``）无法被扫描到，不会被预注册。

## 与 `@tomjs/vite-plugin-iconify` 对比

| 特性 | 本插件 | @tomjs/vite-plugin-iconify |
|---|---|---|
| 配置方式 | 自动扫描，零配置 | 需手动指定图标集 |
| 图标裁剪 | 精确到每个用到的图标 | 可选图标级裁剪 |
| 运行时依赖 | 零额外依赖 | `fs-extra`、`lodash`、`node-html-parser` 等 |
| 注入机制 | `emitFile` 独立 chunk + ESM import | HTML providers 脚本 + 文件复制 |
| 在线回退 | 依赖主包降级（`@iconify/vue` 默认行为） | 支持多资源轮换 |
| CLI 工具 | ❌ | ✅ `ti` 命令 |
| Tailwind 误报 | ✅ 内置过滤 | ❌ |

## License

MIT
