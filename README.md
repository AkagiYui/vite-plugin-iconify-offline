# vite-plugin-iconify-offline

[![npm version](https://img.shields.io/npm/v/vite-plugin-iconify-offline)](https://www.npmjs.com/package/vite-plugin-iconify-offline)
[![npm downloads](https://img.shields.io/npm/dm/vite-plugin-iconify-offline)](https://www.npmjs.com/package/vite-plugin-iconify-offline)
[![npm license](https://img.shields.io/npm/l/vite-plugin-iconify-offline)](https://www.npmjs.com/package/vite-plugin-iconify-offline)

在构建时自动扫描源码中的 Iconify 图标引用，将用到的图标数据预注册到运行时，**零网络请求、零运行时开销**的离线图标方案。

## 原理

1. **扫描** — 构建时递归扫描 `src/` 下所有 `.ts`/`.tsx`/`.js`/`.jsx`/`.vue`/`.svelte` 文件，正则匹配 `"prefix:icon-name"` 模式的图标引用
2. **提取** — 从本地的 `@iconify-json/*` 包中读取图标数据，仅保留用到的图标（含别名解析）
3. **注入** — 在应用入口文件顶部通过 `import` 注入 `addCollection(data)` 调用
4. **预注册** — 利用 ESM 静态提升特性，`addCollection` 在应用渲染前同步执行，图标立即可用

## 安装

```bash
npm i -D vite-plugin-iconify-offline
# 同时安装你需要的图标集
npm i -D @iconify-json/lucide @iconify-json/mdi
```

## 使用

### Vue 3 + `@iconify/vue/offline`

```ts
// vite.config.ts
import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "vite-plugin-iconify-offline"

export default defineConfig({
  plugins: [
    vue(),
    iconifyOffline({
      entry: "src/main.ts",
      package: "@iconify/vue/offline",
    }),
  ],
})
```

### React + `@iconify/react/offline`

```ts
// vite.config.ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import iconifyOffline from "vite-plugin-iconify-offline"

export default defineConfig({
  plugins: [
    react(),
    iconifyOffline({
      entry: "src/main.tsx",
      package: "@iconify/react/offline",
    }),
  ],
})
```

### 在线包 + 禁用 API（如 `@iconify/vue`）

如果出于某些原因必须使用在线包，可通过 `disableAPI` 禁止网络请求：

```ts
iconifyOffline({
  entry: "src/main.ts",
  package: "@iconify/vue",
  disableAPI: true,
  disableAPIImport: "disableFetch",
})
```

## 配置选项

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `entry` | `string` | `"src/main.ts"` | 应用入口文件路径，插件会在此文件顶部注入代码 |
| `package` | `string` | `"@iconify/vue/offline"` | Iconify 图标组件包名 |
| `disableAPI` | `boolean` | `false` | 是否注入 API 禁用代码（仅非 offline 包需要） |
| `addCollectionImport` | `string` | `"addCollection"` | `addCollection` 的导入名称 |
| `disableAPIImport` | `string` | `"disableFetch"` | 禁用 API 的导入名，仅 `disableAPI=true` 时生效 |
| `verbose` | `boolean` | `true` | 是否在控制台输出详细日志 |
| `scanDir` | `string` | `"src"` | 自定义扫描目录，设为 `"."` 可扫描整个项目 |
| `force` | `boolean` | `true` | 每次构建都重新扫描（保留接口，暂未实现缓存） |

## 工作流程

```
构建开始
  │
  ├─ buildStart 钩子
  │   ├─ 递归扫描 src/ 目录下的源码文件
  │   ├─ 提取所有 "prefix:icon-name" 引用
  │   ├─ 过滤 Tailwind/Vue 等误报
  │   └─ 从 @iconify-json/* 加载并精简图标数据
  │
  ├─ transform 钩子 (匹配入口文件)
  │   ├─ 注入 import { addCollection } from "xxx"
  │   ├─ 注入 addCollection({...}) 调用
  │   └─ （可选）注入 API 禁用代码
  │
  └─ 构建完成 → 浏览器中图标立即可用，无网络请求
```

## 与 `@tomjs/vite-plugin-iconify` 对比

| 特性 | 本插件 | @tomjs/vite-plugin-iconify |
|---|---|---|
| 配置方式 | 自动扫描，零配置 | 需手动指定图标集 |
| 图标裁剪 | 精确到每个用到的图标 | 可选图标级裁剪 |
| 运行时依赖 | 零依赖 | `fs-extra`、`lodash`、`node-html-parser` 等 |
| 注入机制 | ESM `import` 静态注入 | HTML providers 脚本 + 文件复制 |
| 在线回退 | ❌ 纯离线 | ✅ 支持多资源轮换 |
| CLI 工具 | ❌ | ✅ `ti` 命令 |
| Tailwind 误报 | ✅ 内置过滤 | ❌ |

## License

MIT
