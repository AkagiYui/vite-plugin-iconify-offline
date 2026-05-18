/**
 * vite-plugin-iconify-offline
 *
 * 在构建时扫描源码中的 Iconify 图标引用，将用到的图标数据
 * 通过 import 注入 addCollection 调用预注册到运行时，避免网络请求。
 *
 * 原理：
 * 1. 扫描源码中 `name="prefix:icon"` 和 `icon: 'prefix:icon'` 等模式
 * 2. 从本地 @iconify-json/* 包读取图标数据，仅保留用到的图标
 * 3. 通过 transform 钩子在应用入口文件中注入 addCollection 调用
 * 4. 由于 import 是静态提升的，addCollection 会在应用渲染前同步执行
 */

import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import type { Plugin } from "vite"

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 图标集中单个图标的数据结构 */
interface IconifyIconData {
  body: string
  left?: number
  top?: number
  width?: number
  height?: number
  rotate?: number
  hFlip?: boolean
  vFlip?: boolean
}

/** 图标集中单个别名的数据结构 */
interface IconifyAliasData {
  parent: string
  left?: number
  top?: number
  width?: number
  height?: number
  rotate?: number
  hFlip?: boolean
  vFlip?: boolean
}

/** Iconify JSON 数据集格式 */
interface IconifyJSON {
  prefix: string
  icons: Record<string, IconifyIconData>
  aliases?: Record<string, IconifyAliasData>
  width?: number
  height?: number
  left?: number
  top?: number
  lastModified?: number
  not_found?: string[]
}

/** 插件配置选项 */
export interface IconifyOfflineOptions {
  /**
   * 应用入口文件路径（相对于项目根目录），插件会在此文件顶部注入 addCollection 调用。
   * @default "src/main.ts"
   */
  entry?: string

  /**
   * Iconify 图标组件包名，插件会从中导入 `addCollection`。
   * 离线包：`@iconify/vue/offline`、`@iconify/react/offline` 等
   * 在线包（需配合 disableAPI）：`@iconify/vue`、`@iconify-icon/react` 等
   * @default "@iconify/vue/offline"
   */
  package?: string

  /**
   * 是否注入 API 禁用代码（仅非 offline 包需要）。
   * 当使用在线包且希望完全禁用网络请求时设为 true。
   * @default false
   */
  disableAPI?: boolean

  /**
   * addCollection 的导入名称。
   * @default "addCollection"
   */
  addCollectionImport?: string

  /**
   * 禁用 API 的导入名称，仅在 disableAPI=true 时生效。
   * 例如 `@iconify/vue` 使用 `disableFetch`，`@iconify-icon/react` 使用 `setCustomIconsLoader`。
   * @default "disableFetch"
   */
  disableAPIImport?: string

  /**
   * 是否在控制台输出详细日志。
   * @default true
   */
  verbose?: boolean

  /**
   * 自定义扫描目录，默认扫描 `src/` 目录。
   * 设置为 `.` 可扫描整个项目根目录（会跳过 node_modules 等）。
   * @default "src"
   */
  scanDir?: string

  /**
   * 是否在构建时始终重新扫描图标引用。
   * 设为 false 可复用缓存加速二次构建（暂未实现缓存，保留接口）。
   * @default true
   */
  force?: boolean
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)

/** 匹配源码中的图标引用，如 name="lucide:sun"、icon: 'lucide:map' 或 'lucide:pause' */
const ICON_PATTERN = /["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g

/** 已知的 Tailwind 修饰符 / Vue 事件 / data-* 属性，排除误报 */
const SKIP_PREFIXES = new Set([
  // Tailwind 响应式断点
  "sm", "md", "lg", "xl", "2xl",
  // Tailwind 状态修饰符
  "hover", "focus", "focus-visible", "active", "visited", "disabled",
  "group-hover", "group-focus", "peer-hover", "peer-focus",
  "first", "last", "odd", "even",
  "before", "after",
  "open", "closed",
  "motion-safe", "motion-reduce",
  // Tailwind data-* / aria-* 属性修饰符
  "data", "group-data", "peer-data",
  "aria", "aria-invalid", "aria-disabled",
  // 其他常见伪类修饰符
  "placeholder", "read-only", "read-write",
  "checked", "selected", "enabled", "required",
  "valid", "invalid", "in-range", "out-of-range",
  "default", "optional", "empty", "autofill",
  "target", "indeterminate",
  "print", "portrait", "landscape",
  "rtl", "ltr",
  // Vue 事件修饰符
  "update",
])

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

/** prefix -> Set<iconName> */
const collectedIcons = new Map<string, Set<string>>()
let preloadCollections: IconifyJSON[] = []

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 从源码内容中提取图标引用。
 */
function extractIcons(code: string): void {
  const matches = code.matchAll(ICON_PATTERN)
  for (const match of matches) {
    const full = match[1]
    const colonIdx = full.indexOf(":")
    if (colonIdx === -1) continue
    const prefix = full.slice(0, colonIdx)
    const iconName = full.slice(colonIdx + 1)

    // 跳过 Tailwind 修饰符 / Vue 事件等误报
    if (SKIP_PREFIXES.has(prefix)) continue

    // 跳过 data-[xxx]: 格式的属性修饰符
    if (prefix.endsWith("-") || iconName.startsWith("[")) continue

    if (!collectedIcons.has(prefix)) {
      collectedIcons.set(prefix, new Set())
    }
    collectedIcons.get(prefix)!.add(iconName)
  }
}

/**
 * 递归扫描目录，提取图标引用。
 */
function scanDir(dir: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在时静默跳过
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // 跳过常见无关目录
      if (["node_modules", ".git", "dist", ".output", ".cloudflare", ".vercel", ".next"].includes(entry.name)) {
        continue
      }
      scanDir(fullPath)
      continue
    }

    // 只扫描源码文件
    if (/\.(tsx?|jsx?|vue|svelte)$/.test(entry.name)) {
      try {
        const code = fs.readFileSync(fullPath, "utf-8")
        extractIcons(code)
      } catch {
        // 忽略读取失败的文件
      }
    }
  }
}

/**
 * 加载指定图标集的 JSON 数据。
 */
function loadIconSet(prefix: string, rootDir: string): IconifyJSON | null {
  // 优先从 @iconify-json 包读取
  const tryPaths = [
    path.join(rootDir, "node_modules", "@iconify-json", prefix, "icons.json"),
    path.join(rootDir, "node_modules", "@iconify", "json", "json", `${prefix}.json`),
  ]
  for (const p of tryPaths) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf-8"))
      }
    } catch {
      // 继续尝试下一个路径
    }
  }

  // 通过 require.resolve 尝试解析
  try {
    const resolved = require.resolve(`@iconify-json/${prefix}/icons.json`, { paths: [rootDir] })
    return JSON.parse(fs.readFileSync(resolved, "utf-8"))
  } catch {
    // 忽略
  }

  console.warn(`[iconify-offline] 未找到图标集: @iconify-json/${prefix}，请安装后重试`)
  return null
}

/**
 * 解析别名链，返回最终图标数据。
 */
function resolveAlias(fullSet: IconifyJSON, name: string): IconifyIconData | null {
  const aliases = fullSet.aliases
  if (!aliases || !aliases[name]) return null

  const alias = aliases[name]
  const parentName = alias.parent
  if (!parentName) return null

  if (fullSet.icons[parentName]) {
    return { ...fullSet.icons[parentName], ...alias }
  }

  // 递归解析父别名
  const parentData = resolveAlias(fullSet, parentName)
  if (parentData) {
    return { ...parentData, ...alias }
  }

  return null
}

/**
 * 从扫描结果构建精简后的图标集数据列表。
 */
function buildPreloadCollections(rootDir: string, verbose: boolean): IconifyJSON[] {
  const collections: IconifyJSON[] = []

  for (const [prefix, iconNames] of collectedIcons) {
    const fullSet = loadIconSet(prefix, rootDir)
    if (!fullSet) continue

    const filteredIcons: Record<string, IconifyIconData> = {}
    let found = 0

    for (const name of iconNames) {
      if (fullSet.icons[name]) {
        filteredIcons[name] = fullSet.icons[name]
        found++
      } else if (fullSet.aliases?.[name]) {
        const resolved = resolveAlias(fullSet, name)
        if (resolved) {
          filteredIcons[name] = resolved
          found++
        } else if (verbose) {
          console.warn(`[iconify-offline] 别名解析失败: ${prefix}:${name}`)
        }
      } else if (verbose) {
        console.warn(`[iconify-offline] 图标不存在: ${prefix}:${name}`)
      }
    }

    if (found > 0) {
      const collectionData: IconifyJSON = {
        prefix,
        icons: filteredIcons,
      }
      if (fullSet.width) collectionData.width = fullSet.width
      if (fullSet.height) collectionData.height = fullSet.height
      collections.push(collectionData)

      if (verbose) {
        console.log(`[iconify-offline] 预注册 ${prefix}: ${found}/${iconNames.size} 个图标`)
      }
    }
  }

  return collections
}

// ---------------------------------------------------------------------------
// Vite 插件
// ---------------------------------------------------------------------------

/**
 * Vite 插件：自动扫描并预注册 Iconify 图标以实现离线使用。
 *
 * @param options - 插件配置选项
 * @returns Vite 插件实例
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite"
 * import vue from "@vitejs/plugin-vue"
 * import iconifyOffline from "vite-plugin-iconify-offline"
 *
 * export default defineConfig({
 *   plugins: [
 *     vue(),
 *     iconifyOffline({
 *       entry: "src/main.ts",
 *       package: "@iconify/vue/offline",
 *     }),
 *   ],
 * })
 * ```
 */
function iconifyOffline(options: IconifyOfflineOptions = {}): Plugin {
  const {
    entry = "src/main.ts",
    package: pkg = "@iconify/vue/offline",
    disableAPI = false,
    addCollectionImport = "addCollection",
    disableAPIImport = "disableFetch",
    verbose = true,
    scanDir: customScanDir,
    force = true,
  } = options

  let rootDir: string

  return {
    name: "vite-plugin-iconify-offline",
    enforce: "pre",

    configResolved(config) {
      rootDir = config.root
    },

    buildStart() {
      if (!force && preloadCollections.length > 0) {
        return // 保留缓存（目前 force 始终为 true，此为预留）
      }

      collectedIcons.clear()
      preloadCollections = []

      // 确定扫描目录
      const targetDir = customScanDir
        ? path.resolve(rootDir, customScanDir)
        : path.join(rootDir, "src")

      if (fs.existsSync(targetDir)) {
        scanDir(targetDir)
      } else if (verbose) {
        console.warn(`[iconify-offline] 扫描目录不存在: ${targetDir}`)
      }

      const total = Array.from(collectedIcons.values()).reduce((s, v) => s + v.size, 0)
      if (verbose) {
        console.log(`[iconify-offline] 扫描到 ${total} 个图标引用，${collectedIcons.size} 个图标集`)
      }

      preloadCollections = buildPreloadCollections(rootDir, verbose)
    },

    transform(code, id) {
      // 在应用入口文件中注入 addCollection 调用
      if (!id.endsWith(entry)) return

      if (preloadCollections.length === 0) return

      // 生成 addCollection 调用
      const addCollectionCalls = preloadCollections
        .map(c => `addCollection(${JSON.stringify(c)});`)
        .join("\n")

      // 确定需要导入的名称
      const imports = disableAPI
        ? [addCollectionImport, disableAPIImport]
        : [addCollectionImport]

      // 构建注入代码
      let injection = `import { ${imports.join(", ")} } from "${pkg}";\n${addCollectionCalls}\n`

      if (disableAPI) {
        // 禁用 API 网络请求，确保图标仅从预注册数据加载
        injection += `${disableAPIImport}(() => ({}), "${preloadCollections[0]?.prefix}");\n`
      }

      return injection + code
    },
  }
}

export default iconifyOffline
