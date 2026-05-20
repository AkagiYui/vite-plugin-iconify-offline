# vite-plugin-iconify-offline

[![npm version](https://img.shields.io/npm/v/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)
[![npm downloads](https://img.shields.io/npm/dm/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)
[![npm license](https://img.shields.io/npm/l/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)

Vite 插件：自动扫描源码中的 Iconify 图标引用，从本地 `@iconify-json/*` 图标集提取实际用到的数据，并在 dev / build 中预注册到 Iconify 运行时，避免浏览器再向 Iconify API 拉取图标。

## 特性

- 自动扫描 `src` 中的 `.ts`、`.tsx`、`.js`、`.jsx`、`.vue`、`.svelte` 文件
- 支持 Vue、React、Solid、Svelte 的 Iconify 运行时包自动检测
- dev 模式通过 `window.IconifyPreload` 在页面启动前预载图标
- build 模式生成独立 `_iconify-offline_icons-*.js` chunk，并自动注入最终 HTML
- 支持非默认输出目录，例如 `dist/client/index.html`
- 只打包实际用到的图标，包含别名解析
- 内置过滤 Tailwind / Vue / Vite 常见 `prefix:name` 误报
- 对已预注册的图标集禁用自定义 loader 回退，减少运行时网络请求

## 安装

```bash
npm i -D vite-plugin-iconify-offline
npm i -D @iconify-json/lucide
```

按需安装你的项目实际使用的图标集：

```bash
npm i -D @iconify-json/lucide @iconify-json/radix-icons @iconify-json/mdi
```

## 使用

### Vue

```ts
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import iconifyOffline from "vite-plugin-iconify-offline"

export default defineConfig({
  plugins: [
    vue(),
    iconifyOffline(),
  ],
})
```

```vue
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>

<template>
  <Icon icon="lucide:shield-check" />
</template>
```

### Solid

```ts
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import iconifyOffline from "vite-plugin-iconify-offline"

export default defineConfig({
  plugins: [
    solid(),
    iconifyOffline(),
  ],
})
```

```tsx
import { Icon } from "@iconify-icon/solid"

export function App() {
  return <Icon icon="lucide:panel-left" />
}
```

### 手动指定 Iconify 包

插件会从 Vite 插件列表自动检测运行时包：

| 框架插件 | 自动选择 |
|---|---|
| `@vitejs/plugin-vue` | `@iconify/vue` |
| `@vitejs/plugin-react` | `@iconify/react` |
| `vite-plugin-solid` | `@iconify-icon/solid` |
| Svelte 插件 | `@iconify/svelte` |

如果自动检测不符合项目实际用法，可以显式指定：

```ts
iconifyOffline({ package: "@iconify/vue" })
iconifyOffline({ package: "@iconify-icon/solid" })
```

目标包需要导出 `addCollection`。如果希望插件同时禁用图标集的运行时 loader 回退，目标包也需要导出 `setCustomIconsLoader`。

## 配置

```ts
interface IconifyOfflineOptions {
  package?: string
  scanDir?: string
  verbose?: boolean
}
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `package` | `string` | 自动检测，失败时为 `@iconify/vue` | 注册图标数据时导入的 Iconify 运行时包 |
| `scanDir` | `string` | `"src"` | 扫描目录，相对于 Vite root。可设为 `"."` 扫描整个项目 |
| `verbose` | `boolean` | `true` | 是否输出扫描、预注册、注入等日志 |

## 工作方式

### dev

dev 模式中不能使用 Rollup 的 `emitFile()` 生成 chunk。插件会在 `transformIndexHtml` 中向页面头部注入：

```html
<script>window.IconifyPreload = [...];</script>
```

Iconify 运行时初始化时会读取 `window.IconifyPreload`，因此图标能在首屏渲染前进入本地 storage，不需要请求 `https://api.iconify.design` 或 fallback API。

### build

build 模式会生成一个独立图标注册 chunk：

```ts
import { addCollection, setCustomIconsLoader } from "@iconify/vue"

addCollection({ prefix: "lucide", icons: { ... } })
setCustomIconsLoader(() => ({ prefix: "lucide", icons: {} }), "lucide")
```

插件会把生成的 `_iconify-offline_icons-*.js` 注入到最终 `index.html` 中，并支持 `dist/index.html`、`dist/client/index.html` 等常见输出结构。

## 运行时包必须一致

插件注册到哪个 Iconify 包，组件也应该使用同一个包。否则不同包之间的 storage 可能不共享，图标会显示为空。

推荐：

```ts
// vite.config.ts
iconifyOffline({ package: "@iconify/vue" })

// 组件
import { Icon } from "@iconify/vue"
```

避免混用：

```ts
// 插件注册到 @iconify/vue
iconifyOffline({ package: "@iconify/vue" })

// 组件却使用 @iconify/vue/offline，可能读取不到同一份 storage
import { Icon } from "@iconify/vue/offline"
```

Solid 项目同理：插件应注册到 `@iconify-icon/solid`，组件也使用 `@iconify-icon/solid`。

## 可扫描的图标写法

插件扫描字符串字面量中的 `prefix:name`：

```vue
<Icon icon="lucide:mail" />
<Icon name="lucide:panel-left" />
```

```ts
const menu = [
  { icon: "lucide:layout-dashboard" },
  { icon: "radix-icons:gear" },
]
```

动态拼接无法被静态扫描：

```ts
const icon = `lucide:${name}`
```

这类图标需要改成静态字符串，或确保代码中另有可扫描到的字面量。

## 日志

构建或启动时会看到类似输出：

```text
[iconify-offline] 自动检测到图标包: @iconify/vue
[iconify-offline] 扫描到 12 个图标引用，1 个图标集
[iconify-offline] 预注册 lucide: 12/12 个图标
```

如果出现：

```text
[iconify-offline] 未找到图标集: @iconify-json/mdi，请安装后重试
```

说明源码中使用了 `mdi:*`，但项目没有安装 `@iconify-json/mdi`。安装对应图标集即可。

## 测试覆盖

当前测试覆盖：

- Vue build 注入离线 chunk
- Vue dev 注入 `IconifyPreload`
- Solid build 自动检测 `@iconify-icon/solid`
- Solid dev 注入 `IconifyPreload`
- 非默认输出目录，如 `dist/client`
- 自定义扫描目录
- 缺失图标集时不崩溃
- 图标别名解析和误报过滤

## 与 `@tomjs/vite-plugin-iconify` 对比

`@tomjs/vite-plugin-iconify` 更偏向 Iconify 资源管理：它通过 `transformIndexHtml` 注入 `IconifyProviders`，配置 Iconify 运行时的资源地址；也可以把 `@iconify/json` 或 `@iconify-json/*` 图标集复制到输出目录，让 Iconify 运行时从本地 JSON 资源加载图标。

本插件更偏向源码驱动的预注册：它扫描项目里实际写到的图标名，只提取这些图标，并在 dev / build 阶段直接预注册到 Iconify 运行时。

| 特性 | 本插件 | `@tomjs/vite-plugin-iconify` |
|---|---|---|
| 主要目标 | 扫描源码并预注册实际用到的图标 | 管理 Iconify API resources 和本地图标集资源 |
| 配置方式 | 默认零配置，可自动检测 Vue / React / Solid / Svelte | 需要配置 `resources`、`local`、`icons` 等资源选项 |
| dev 模式 | 注入 `window.IconifyPreload`，启动前预载图标数据 | 注入 `IconifyProviders`，让运行时按配置资源加载 |
| build 模式 | 生成 `_iconify-offline_icons-*.js` 注册 chunk 并注入 HTML | 复制本地图标 JSON 到输出目录，并替换/配置资源路径 |
| 图标裁剪 | 自动按源码中出现的字符串字面量裁剪 | 可通过 `icons` 选项手动指定需要保留的图标 |
| 本地资源 | 不复制整套图标集，只内嵌用到的数据 | 支持复制 `@iconify/json` / `@iconify-json/*` 到输出目录 |
| 运行时回退 | 已预注册图标集会禁用自定义 loader 回退，减少网络请求 | 支持多资源轮换，可配置本地或远程资源 |
| CLI | 无 | 提供 `ti` 命令生成图标集数据 |
| 依赖规模 | 仅依赖 Vite peer，本体无额外运行时依赖 | 使用 `fs-extra`、`lodash.clonedeep`、`node-html-parser`、`cac` 等 |

如果你希望“项目里写了哪些图标，就自动离线注册哪些图标”，本插件更直接。如果你希望管理完整图标集资源、配置多资源地址，或使用 CLI 生成图标数据，`@tomjs/vite-plugin-iconify` 更完整。

## License

MIT
