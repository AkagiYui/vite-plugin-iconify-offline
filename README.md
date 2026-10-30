# vite-plugin-iconify-offline

[![npm version](https://img.shields.io/npm/v/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)
[![npm downloads](https://img.shields.io/npm/dm/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)
[![npm license](https://img.shields.io/npm/l/vite-plugin-iconify-offline)](https://npmx.dev/package/vite-plugin-iconify-offline)

Vite 插件：自动扫描源码中的 Iconify 图标引用，从本地 `@iconify-json/*` 或 `@iconify/json` 图标集提取实际用到的数据，并在 dev / build 中预注册到 Iconify 运行时，避免浏览器再向 Iconify API 拉取图标。

## 特性

- 自动扫描 `src` 中的 `.ts`、`.tsx`、`.js`、`.jsx`、`.vue`、`.svelte` 文件
- 支持 Vue、React、Solid、Svelte 的 Iconify 运行时包自动检测
- dev 模式通过虚拟模块预注册图标，源码新增图标后自动刷新
- build 模式生成独立 `_iconify-offline_icons-*.js` chunk，并自动注入最终 HTML
- 注入脚本使用绝对（`base` 感知）路径，兼容 SSG 预渲染的子路径页面、多页应用与自定义 `base` / 子路径部署
- 支持非默认输出目录，例如 `dist/client/index.html`
- 支持手动传入额外图标，覆盖模板字符串、动态拼接等无法静态扫描的场景
- 只打包实际用到的图标，包含别名解析
- 内置过滤 Tailwind / Vue / Vite / Open Graph / Twitter Card 常见 `prefix:name` 误报，并支持通过 `exclude` 自定义排除前缀
- 对已预注册的图标集禁用自定义 loader 回退，减少运行时网络请求
- 支持 Iconify 官方离线版入口（`@iconify/vue/offline` 等）：图标注册进组件用的同一个入口，产物里不含任何联网代码
- 可选 `disableApi`：没有离线版的运行时（`iconify-icon` 系列等）也能彻底禁用在线 API，漏打的图标不会联网

## 安装

```bash
npm i -D vite-plugin-iconify-offline
npm i -D @iconify-json/lucide
```

推荐按需安装你的项目实际使用的图标集：

```bash
npm i -D @iconify-json/lucide @iconify-json/radix-icons @iconify-json/mdi
```

如果项目已经安装 Iconify 全量大包，也可以直接使用：

```bash
npm i -D @iconify/json
```

插件会优先读取 `@iconify-json/{prefix}/icons.json`，找不到时再从 `@iconify/json/json/{prefix}.json` 读取对应图标集。对于应用项目，仍建议优先使用 `@iconify-json/*` 小包，安装体积更小。

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
iconifyOffline({ package: "@iconify/vue/offline" }) // 官方离线版，见下文
```

目标包需要导出 `addCollection`。主入口还需要导出 `setCustomIconsLoader`（插件用它关掉已注册图标集的 loader 回退）；
[官方离线版](#官方离线版推荐用于严格离线--csp-场景)入口没有 loader，只调 `addCollection`。

## 配置

```ts
interface IconifyOfflineOptions {
  package?: string
  scanDir?: string
  icons?: string[]
  exclude?: string[]
  excludeFiles?: string | RegExp | readonly (string | RegExp)[] | null
  disableApi?: boolean
  verbose?: boolean
}
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `package` | `string` | 自动检测，失败时为 `@iconify/vue` | 注册图标数据时导入的 Iconify 运行时包 |
| `scanDir` | `string` | `"src"` | 扫描目录，相对于 Vite root。可设为 `"."` 扫描整个项目 |
| `icons` | `string[]` | `[]` | 手动指定额外要离线化的图标，例如 `["lucide:sun"]` |
| `exclude` | `string[]` | `[]` | 自定义要排除的 `prefix:` 前缀，跳过对应的 `prefix:name` 误报，例如 `["og", "twitter"]` |
| `excludeFiles` | `string \| RegExp \| readonly (string \| RegExp)[] \| null` | 测试文件规则，见下文 | 不扫描的文件，glob 相对于 Vite root；自定义值替换默认规则，`[]` 可扫描测试文件 |
| `disableApi` | `boolean` | `false` | 彻底禁用 Iconify 在线 API，见下文「禁用在线 API」 |
| `verbose` | `boolean` | `true` | 是否输出扫描、预注册、注入等日志 |

## 工作方式

### dev

dev 模式中不能使用 Rollup 的 `emitFile()` 生成 chunk。插件会在 `transformIndexHtml` 中向页面头部注入虚拟模块入口：

```html
<script type="module" src="/@id/virtual:iconify-offline:icons"></script>
```

虚拟模块会导入当前项目使用的 Iconify 运行时包并调用 `addCollection()` 注册图标数据。开发服务器运行期间，如果源码中的图标集合发生变化，插件会重新扫描、失效虚拟模块并触发页面刷新，让新增图标进入本地 storage，不需要重启 dev server。

### build

build 模式会生成一个独立图标注册 chunk：

```ts
import { addCollection, setCustomIconsLoader } from "@iconify/vue"

addCollection({ prefix: "lucide", icons: { ... } })
setCustomIconsLoader(() => ({ prefix: "lucide", icons: {} }), "lucide")
```

插件会把生成的 `_iconify-offline_icons-*.js` 注入到最终 `index.html` 中，并支持 `dist/index.html`、`dist/client/index.html` 等常见输出结构。

注入脚本的 `src` 按 Vite 的 `base` 生成**绝对路径**（默认 `/` 下形如 `/assets/_iconify-offline_icons-*.js`），因此从子路径页面（如 SSG 预渲染的 `dist/about/index.html`）加载也不会 404；当 `base` 为相对（`./`）时则回退为相对 HTML 的路径。

### 禁用在线 API（`disableApi`）

默认情况下，插件只对**已预注册的图标集**关掉 loader 回退。其它前缀，或者扫描不到的图标（比如名字是拼出来的），
运行时仍会去 `api.iconify.design`（以及备用的 `api.simplesvg.com`、`api.unisvg.com`）现取。

开启 `disableApi` 后，注册脚本会先把运行时的 fetch 换掉：

```ts
import { _api, addCollection, setCustomIconsLoader } from "@iconify/vue"

_api.setFetch(() => Promise.resolve(new Response(null, { status: 404, statusText: "iconify-offline: API disabled" })))
addCollection({ prefix: "lucide", icons: { ... } })
// ...
```

- 漏打的图标只是不显示，**不产生任何网络请求**。用 404 而不是抛错：Iconify 把 404 当成「图标不存在」直接放弃，抛错则会轮换备用节点再试
- 即使一个图标都没扫到，也会生成并注入这个脚本，保证禁用总是生效
- 脚本注入在 `<head>` 起始处，先于应用入口执行，图标请求发出之前就已生效
- 要求运行时包导出 `_api`：`@iconify/vue`、`@iconify/react`、`@iconify/svelte`、`iconify-icon` 系列都满足
- 它替换的是 Iconify 内部用的 fetch（`_api.setFetch`），不动全局 `window.fetch`，对应用自己的请求没有影响
- 有官方离线版的运行时更推荐直接用[离线版](#官方离线版推荐用于严格离线--csp-场景)：产物里连联网代码都没有

```ts
iconifyOffline({ disableApi: true })
```

适合配了严格 CSP（`connect-src` 不放行 Iconify）、需要离线运行，或要求静态资源全部本地化的项目——比如 Capacitor / 鸿蒙等原生壳里的 H5。

## 运行时包必须一致

插件注册到哪个 Iconify 包，组件也必须使用同一个包——不同入口各有一份 storage，注册错了图标会显示为空。
`package` 不写时按框架自动检测为主入口（`@iconify/vue` 等）；用离线版时请显式写成组件用的那个入口。

```ts
// 主入口：组件和插件都用 @iconify/vue
iconifyOffline({ package: "@iconify/vue" })
import { Icon } from "@iconify/vue"
```

### 官方离线版（推荐用于严格离线 / CSP 场景）

Iconify 的经典组件包自带不含任何联网代码的离线版：只认 `addCollection` / `addIcon` 注册进来的图标，
没有 API、没有 loader，打出来的包也更小。插件会把扫描到的图标直接注册进这个入口：

| 运行时 | 插件 `package` | 组件从哪儿导入 |
|---|---|---|
| Vue 3 | `@iconify/vue/offline` | `import { Icon } from "@iconify/vue/offline"` |
| Vue 2 | `@iconify/vue2/offline` | `import { Icon } from "@iconify/vue2/offline"` |
| React | `@iconify/react/offline` | `import { Icon } from "@iconify/react/offline"` |
| Svelte | `@iconify/svelte/dist/offline-functions` | `import Icon from "@iconify/svelte/dist/OfflineIcon.svelte"` |

```ts
iconifyOffline({ package: "@iconify/vue/offline" })
```

`iconify-icon` 系列（含 `@iconify-icon/solid`、`@iconify-icon/react`）和 `@iconify/ember` **没有**离线版，
要彻底不联网请用 [`disableApi`](#禁用在线-apidisableapi)。离线版本身不含联网代码，`disableApi` 对它不生效也不需要。

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

这类图标可以通过 `icons` 手动补充：

```ts
iconifyOffline({
  icons: [
    "lucide:sun",
    "lucide:moon",
  ],
})
```

## 误报过滤

扫描会跳过 JS / JSX / HTML 注释，并保留字符串、Vue 绑定表达式和模板插值中的图标字面量。
默认不扫描 `*.test.{ts,tsx,js,jsx,vue,svelte}`、`*.spec.{ts,tsx,js,jsx,vue,svelte}` 和 `__tests__` 目录，避免测试数据中的时间（`"00:00"`）、缓存键（`"room-detail:5"`）等被当成图标。

可通过 `excludeFiles` 替换默认文件规则；该过滤同时用于初始扫描和开发时热更新。若需保留默认规则并追加目录：

```ts
iconifyOffline({
  excludeFiles: [
    "**/*.{test,spec}.{ts,tsx,js,jsx,vue,svelte}",
    "**/__tests__/**",
    "src/fixtures/**",
  ],
})
```

需要扫描测试文件的项目可设置 `excludeFiles: []`；手动配置的 `icons` 不受文件排除规则影响。

插件按 `prefix:name` 模式扫描字符串字面量，部分非图标写法也会命中该模式。已内置过滤常见误报，包括 Tailwind 修饰符（`hover:`、`sm:` 等）、Vue 事件（`update:`）、Vite 虚拟模块（`virtual:`）以及 Open Graph / Twitter Card 的 meta 前缀（`og:`、`twitter:`）：

```ts
setMeta("og:title", title)        // 不会被识别为图标
setMeta("twitter:description", d)  // 不会被识别为图标
```

如果项目里还有其他会触发误报的前缀，可以通过 `exclude` 自定义排除（前缀可带或不带尾部冒号）：

```ts
iconifyOffline({
  exclude: ["og", "twitter", "my-prefix"],
})
```

配置后，扫描时会跳过所有匹配这些前缀的 `prefix:name` 字符串，不再尝试解析对应的图标集。

## 日志

构建或启动时会看到类似输出：

```text
[iconify-offline] 自动检测到图标包: @iconify/vue
[iconify-offline] 扫描到 12 个图标引用，1 个图标集
[iconify-offline] 预注册 lucide: 12/12 个图标
```

如果出现：

```text
[iconify-offline] 未找到图标集: @iconify-json/mdi 或 @iconify/json，请安装后重试
```

说明源码中使用了 `mdi:*`，但项目没有安装可用的 `mdi` 图标集。安装对应小包或全量大包即可：

```bash
npm i -D @iconify-json/mdi
# 或
npm i -D @iconify/json
```

## 测试覆盖

当前测试覆盖：

- Vue build 注入离线 chunk
- Vue dev 注入图标注册虚拟模块
- dev 模式源码新增图标后刷新虚拟模块
- Solid build 自动检测 `@iconify-icon/solid`
- Solid dev 注入图标注册虚拟模块
- 非默认输出目录，如 `dist/client`
- 自定义扫描目录
- 缺失图标集时不崩溃
- 从 `@iconify/json` 大包读取图标集
- 图标别名解析和误报过滤
- `disableApi`：build / dev 均先禁用再注册、无图标时仍注入；对真实 `@iconify/vue` 验证未打包图标不联网、只尝试一次
- 官方离线版入口：Vue / React / Svelte 离线版的注册与渲染（含「注册进主入口则离线组件读不到」的对照），build 产物不含 Iconify API

## 与 `@tomjs/vite-plugin-iconify` 对比

`@tomjs/vite-plugin-iconify` 更偏向 Iconify 资源管理：它通过 `transformIndexHtml` 注入 `IconifyProviders`，配置 Iconify 运行时的资源地址；也可以把 `@iconify/json` 或 `@iconify-json/*` 图标集复制到输出目录，让 Iconify 运行时从本地 JSON 资源加载图标。

本插件更偏向源码驱动的预注册：它扫描项目里实际写到的图标名，只提取这些图标，并在 dev / build 阶段直接预注册到 Iconify 运行时。

| 特性 | 本插件 | `@tomjs/vite-plugin-iconify` |
|---|---|---|
| 主要目标 | 扫描源码并预注册实际用到的图标 | 管理 Iconify API resources 和本地图标集资源 |
| 配置方式 | 默认零配置，可自动检测 Vue / React / Solid / Svelte | 需要配置 `resources`、`local`、`icons` 等资源选项 |
| dev 模式 | 注入图标注册虚拟模块，图标集合变化时刷新 | 注入 `IconifyProviders`，让运行时按配置资源加载 |
| build 模式 | 生成 `_iconify-offline_icons-*.js` 注册 chunk 并注入 HTML | 复制本地图标 JSON 到输出目录，并替换/配置资源路径 |
| 图标裁剪 | 自动按源码中出现的字符串字面量裁剪 | 可通过 `icons` 选项手动指定需要保留的图标 |
| 本地资源 | 不复制整套图标集，只内嵌用到的数据 | 支持复制 `@iconify/json` / `@iconify-json/*` 到输出目录 |
| 运行时回退 | 已预注册图标集会禁用自定义 loader 回退，减少网络请求 | 支持多资源轮换，可配置本地或远程资源 |
| CLI | 无 | 提供 `ti` 命令生成图标集数据 |
| 依赖规模 | 仅依赖 Vite peer，本体无额外运行时依赖 | 使用 `fs-extra`、`lodash.clonedeep`、`node-html-parser`、`cac` 等 |

如果你希望“项目里写了哪些图标，就自动离线注册哪些图标”，本插件更直接。如果你希望管理完整图标集资源、配置多资源地址，或使用 CLI 生成图标数据，`@tomjs/vite-plugin-iconify` 更完整。

## 开发模式扫描恢复

热更新扫描源码或读取本地图标集失败时，插件会保留上一次有效图标数据和注册脚本，
避免所有图标持续消失。恢复文件或依赖后刷新页面即可重试，无需重启开发服务。
不同插件实例的图标快照相互隔离；正常删除图标引用仍会更新注册数据。

## License

MIT
