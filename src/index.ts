/**
 * vite-plugin-iconify-offline
 *
 * 在构建时扫描源码中的 Iconify 图标引用，将用到的图标数据
 * 通过 import 注入 addCollection 调用预注册到运行时，避免网络请求。
 *
 * 原理：
 * 1. 扫描源码中 `name="prefix:icon"` 和 `icon: 'prefix:icon'` 等模式
 * 2. 从本地 @iconify-json/* 或 @iconify/json 包读取图标数据，仅保留用到的图标
 * 3. 通过 this.emitFile 生成独立 chunk，自动被 Vite 打包
 * 4. chunk 中的 import { addCollection } + addCollection({...}) 经过标准构建通道，不会被 tree-shake
 */

import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { createFilter, type FilterPattern, type Plugin, type ViteDevServer } from "vite"
import { forEachSourceString } from "./source-strings"

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 图标集中单个图标的数据结构 */
export interface IconifyIconData {
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
export interface IconifyAliasData {
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
export interface IconifyJSON {
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
   * Iconify 图标组件包名，插件会从中导入 `addCollection`。
   * 例如：`@iconify/vue`、`@iconify/vue/offline`、`@iconify-icon/solid` 等。
   *
   * 官方离线版入口（不含任何联网代码）要和组件用同一个：`@iconify/vue/offline`、`@iconify/vue2/offline`、
   * `@iconify/react/offline`、`@iconify/svelte/dist/offline-functions`（Svelte 组件是 `dist/OfflineIcon.svelte`）。
   * 插件会把图标注册进这个入口本身——离线版和主入口各有一份 storage。
   * 不指定时自动从 Vite 插件列表检测框架：
   * vue → @iconify/vue，react → @iconify/react，solid → @iconify-icon/solid
   * @default 自动检测，检测不到时回退为 "@iconify/vue"
   */
  package?: string

  /**
   * 自定义扫描目录，默认扫描 `src/` 目录。
   * 设置为 `.` 可扫描整个项目根目录（会跳过 node_modules 等）。
   * @default "src"
   */
  scanDir?: string

  /**
   * 手动指定额外要离线化的图标，用于模板字符串、动态拼接等无法静态扫描的场景。
   * 格式与 Iconify 图标名一致，例如：`["lucide:sun", "mdi:home"]`。
   * @default []
   */
  icons?: string[]

  /**
   * 自定义要排除的 `prefix:` 前缀列表，用于规避误报。
   * 配置后，扫描时会跳过所有匹配这些前缀的 `prefix:name` 字符串，
   * 不再尝试解析对应的图标集。与内置过滤列表（Tailwind / Vue / og / twitter 等）合并生效。
   * 前缀可带或不带尾部冒号，例如 `["og", "twitter"]` 或 `["og:", "twitter:"]`。
   * @default []
   */
  exclude?: string[]

  /**
   * 不参与扫描的文件，支持相对于 Vite root 的 glob 或正则表达式。
   * 默认排除 *.test.*、*.spec.* 和 __tests__ 目录；传 [] 可扫描测试文件。
   * 自定义值会替换默认规则，不影响 exclude 的图标前缀过滤。
   */
  excludeFiles?: FilterPattern

  /**
   * 彻底禁用 Iconify 的在线 API（api.iconify.design 及其备用节点）。
   *
   * 默认只对已预注册的图标集关掉 loader 回退；其它前缀、或扫描漏掉的图标（例如动态拼接的名字）
   * 运行时仍会去 Iconify API 现取。开启后，注册脚本会把运行时的 fetch 换成一个不联网、
   * 直接回 404 的实现：漏打的图标只是不显示，不会产生任何网络请求。
   * 适合有严格 CSP、离线环境，或要求静态资源全部本地化（降低供应链风险）的项目。
   *
   * 开启后即使没有扫描到任何图标，也会生成并注入注册脚本，保证禁用总是生效。
   * 目标包需要导出 `_api`（`@iconify/vue`、`@iconify/react`、`@iconify/svelte`、`iconify-icon` 系列都有）。
   *
   * 有官方离线版的运行时（Vue / Vue2 / React / Svelte）更推荐直接用离线版入口（见 `package`），
   * 那里根本没有联网代码，这个选项对它们不生效也不需要。没有离线版的（`iconify-icon` 系列、Ember）用这个。
   * @default false
   */
  disableApi?: boolean

  /**
   * 是否在控制台输出详细日志。
   * @default true
   */
  verbose?: boolean
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)

/** 匹配源码中的图标引用，如 name="lucide:sun"、icon: 'lucide:map' 或 'lucide:pause' */
const ICON_PATTERN = /["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g

const VIRTUAL_MODULE_ID = "virtual:iconify-offline:icons"
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`

const DEFAULT_EXCLUDE_FILES = ["**/*.{test,spec}.{ts,tsx,js,jsx,vue,svelte}", "**/__tests__/**"]

/** 已知的 Tailwind 修饰符 / Vue 事件 / data-* 属性，排除误报 */
export const SKIP_PREFIXES = new Set([
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
  // Vite 虚拟模块 id
  "virtual",
  // Open Graph / Twitter Card meta property 前缀
  "og", "twitter",
])

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

/** prefix -> Set<iconName> */
export const collectedIcons = new Map<string, Set<string>>()

interface IconRegistrySnapshot {
  collections: IconifyJSON[]
  signature: string
}

/** 清空已收集的图标（供测试使用） */
export function clearCollectedIcons(): void {
  collectedIcons.clear()
}

/**
 * 收集单个 Iconify 图标引用。
 *
 * @param full - 完整的 `prefix:name` 字符串
 * @param exclude - 用户自定义要排除的前缀集合，与内置 {@link SKIP_PREFIXES} 合并生效
 */
export function collectIcon(full: string, exclude?: ReadonlySet<string>): boolean {
  return collectIconInto(full, exclude, collectedIcons)
}

function collectIconInto(full: string, exclude: ReadonlySet<string> | undefined, registry: Map<string, Set<string>>): boolean {
  const colonIdx = full.indexOf(":")
  if (colonIdx === -1) return false
  const prefix = full.slice(0, colonIdx)
  const iconName = full.slice(colonIdx + 1)

  // 跳过 Tailwind 修饰符 / Vue 事件 / og / twitter 等内置误报，以及用户自定义排除的前缀
  if (SKIP_PREFIXES.has(prefix) || exclude?.has(prefix)) return false

  // 跳过 data-[xxx]: 格式的属性修饰符
  if (prefix.endsWith("-") || iconName.startsWith("[")) return false

  if (!registry.has(prefix)) {
    registry.set(prefix, new Set())
  }
  registry.get(prefix)!.add(iconName)
  return true
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 从源码内容中提取图标引用。
 *
 * @param code - 源码文本
 * @param exclude - 用户自定义要排除的前缀集合
 */
export function extractIcons(code: string, exclude?: ReadonlySet<string>): void {
  extractIconsInto(code, exclude, collectedIcons)
}

function extractIconsInto(code: string, exclude: ReadonlySet<string> | undefined, registry: Map<string, Set<string>>, file?: string): void {
  forEachSourceString(code, (literal) => {
    for (const match of literal.matchAll(ICON_PATTERN)) {
      collectIconInto(match[1], exclude, registry)
    }
  }, file ? /\.(vue|svelte)$/.test(file) : undefined)
}

/**
 * 递归扫描目录，提取图标引用。
 */
function scanDir(dir: string, exclude: ReadonlySet<string>, registry: Map<string, Set<string>>, fileFilter: (file: string) => boolean): boolean {
  let complete = true
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false // 读取失败的扫描不能替换开发服务器的有效快照
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // 跳过常见无关目录
      if (["node_modules", ".git", "dist", ".output", ".cloudflare", ".vercel", ".next"].includes(entry.name)) {
        continue
      }
      if (!fileFilter(`${fullPath}/`)) continue
      if (!scanDir(fullPath, exclude, registry, fileFilter)) complete = false
      continue
    }

    // 只扫描源码文件
    if (/\.(tsx?|jsx?|vue|svelte)$/.test(entry.name) && fileFilter(fullPath)) {
      try {
        const code = fs.readFileSync(fullPath, "utf-8")
        extractIconsInto(code, exclude, registry, fullPath)
      } catch {
        complete = false
      }
    }
  }
  return complete
}

/**
 * 加载指定图标集的 JSON 数据。
 */
function loadIconSet(prefix: string, rootDir: string): IconifyJSON | null {
  function readSet(file: string): IconifyJSON {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"))
    if (!data || typeof data.icons !== "object" || !data.icons || Array.isArray(data.icons)) {
      throw new Error(`Invalid icon set: ${file}`)
    }
    return data
  }
  // 优先从 @iconify-json 包读取
  const tryPaths = [
    path.join(rootDir, "node_modules", "@iconify-json", prefix, "icons.json"),
    path.join(rootDir, "node_modules", "@iconify", "json", "json", `${prefix}.json`),
  ]
  for (const p of tryPaths) {
    try {
      if (fs.existsSync(p)) {
        return readSet(p)
      }
    } catch {
      // 继续尝试下一个路径
    }
  }

  // 通过 require.resolve 尝试解析
  try {
    const resolved = require.resolve(`@iconify-json/${prefix}/icons.json`, { paths: [rootDir] })
    return readSet(resolved)
  } catch {
    // 忽略
  }

  try {
    const resolved = require.resolve(`@iconify/json/json/${prefix}.json`, { paths: [rootDir] })
    return readSet(resolved)
  } catch {
    // 忽略
  }

  console.warn(`[iconify-offline] 未找到图标集: @iconify-json/${prefix} 或 @iconify/json，请安装后重试`)
  return null
}

/**
 * 解析别名链，返回最终图标数据。
 */
export function resolveAlias(fullSet: IconifyJSON, name: string): IconifyIconData | null {
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
function buildPreloadCollections(rootDir: string, verbose: boolean, registry: Map<string, Set<string>>) {
  const collections: IconifyJSON[] = []
  const failedPrefixes = new Set<string>()

  for (const [prefix, iconNames] of registry) {
    const fullSet = loadIconSet(prefix, rootDir)
    if (!fullSet) {
      failedPrefixes.add(prefix)
      continue
    }

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

  return { collections, failedPrefixes }
}

function createSnapshot(collections: IconifyJSON[]): IconRegistrySnapshot {
  return {
    collections,
    signature: JSON.stringify(collections),
  }
}

/**
 * 禁用在线 API 时注入的 fetch 实现：不发请求，直接回 404。
 * 用 404 而不是 reject：Iconify 把 404 视为「图标不存在」直接放弃（shouldAbort），
 * 其它失败会轮换到 api.simplesvg.com / api.unisvg.com 再试，白白多几轮超时和报错。
 */
export const DISABLED_API_FETCH = "() => Promise.resolve(new Response(null, { status: 404, statusText: \"iconify-offline: API disabled\" }))"

/**
 * 是否是 Iconify 官方离线版入口：只认 addCollection / addIcon 注册进来的数据，没有 loader、没有 API，也就没有联网代码。
 * Vue / Vue2 / React 是 `<pkg>/offline`（或 `<pkg>/dist/offline`），Svelte 是 `@iconify/svelte/dist/offline-functions`。
 */
export function isOfflineEntry(pkgName: string): boolean {
  return /\/(?:dist\/)?offline(?:-functions)?$/.test(pkgName)
}

export function generateIconRegistrationModule(collections: IconifyJSON[], pkgName: string, disableApi = false): string {
  if (isOfflineEntry(pkgName)) {
    // 注册进组件实际使用的那个入口：离线版和主入口各有一份 storage，注册到主入口的话组件读不到，图标是空的。
    // 离线版没有 setCustomIconsLoader / _api（也不需要：本来就不会联网），只调 addCollection
    if (collections.length === 0) return ""
    return `import { addCollection } from "${pkgName}";\n${collections.map(c => `addCollection(${JSON.stringify(c)});`).join("\n")}\n`
  }

  const imports: string[] = []
  const statements: string[] = []

  if (disableApi) {
    // 放在最前面：在任何图标请求发出之前生效
    imports.push("_api")
    statements.push(`_api.setFetch(${DISABLED_API_FETCH});`)
  }

  if (collections.length > 0) {
    imports.push("addCollection", "setCustomIconsLoader")
    statements.push(...collections.map(c => `addCollection(${JSON.stringify(c)});`))
    statements.push(...collections.map(c => `setCustomIconsLoader(() => ({ prefix: ${JSON.stringify(c.prefix)}, icons: {} }), ${JSON.stringify(c.prefix)});`))
  }

  if (statements.length === 0) return ""

  return `import { ${imports.join(", ")} } from "${pkgName}";\n${statements.join("\n")}\n`
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
 *       package: "@iconify/vue/offline",
 *     }),
 *   ],
 * })
 * ```
 */
function iconifyOffline(options: IconifyOfflineOptions = {}): Plugin {
  const {
    package: userPkg,
    verbose = true,
    scanDir: customScanDir,
    icons = [],
    exclude = [],
    excludeFiles = DEFAULT_EXCLUDE_FILES,
    disableApi = false,
  } = options

  // 用户自定义排除的前缀，规范化：去除尾部冒号、空白并转小写（图标 prefix 恒为小写）
  const excludeSet = new Set(
    exclude.map(p => p.trim().toLowerCase().replace(/:$/, "")).filter(Boolean),
  )

  let rootDir: string
  let fileFilter: (file: string) => boolean
  let base = "/"  // Vite 的 base，用于生成注入脚本的绝对 URL
  let pkgName = userPkg  // 用户显式指定优先，未指定则 auto-detect
  let command: "serve" | "build" = "build"
  let server: ViteDevServer | undefined
  let snapshot: IconRegistrySnapshot = createSnapshot([])
  let retrySnapshot = false
  let warnedAboutScan = false

  /** 是否需要注册模块：有图标要预注册，或者要禁用在线 API（哪怕一个图标都没扫到；离线版入口没有 API 可禁） */
  function hasRegistrationModule(): boolean {
    return snapshot.collections.length > 0 || (disableApi && !isOfflineEntry(pkgName!))
  }

  function findFiles(dir: string, predicate: (filePath: string) => boolean): string[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }

    const files: string[] = []
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...findFiles(fullPath, predicate))
      } else if (predicate(fullPath)) {
        files.push(fullPath)
      }
    }
    return files
  }

  /**
   * 计算注入脚本的 src。
   * 绝对 base（默认 "/"，或 "/sub/"、完整 URL）：用 base 拼接「chunk 相对输出根目录」的路径，
   *   得到形如 /assets/x.js——对根页面与（SSG 预渲染的）子路径页面都正确，
   *   这正是 Vite 处理自身资源 URL 的方式。
   * 相对 base（"" / "./" / "./xxx"）：回退到「相对 HTML 文件」的路径（与 Vite 相对 base 行为一致）。
   */
  function resolveScriptSrc(htmlPath: string, chunkPath: string, outDir: string): string {
    if (base === "" || base === "./" || base.startsWith("./")) {
      const rel = path.relative(path.dirname(htmlPath), chunkPath).split(path.sep).join("/")
      return rel.startsWith(".") ? rel : `./${rel}`
    }
    const relToOut = path.relative(outDir, chunkPath).split(path.sep).join("/")
    return `${base.endsWith("/") ? base : `${base}/`}${relToOut}`
  }

  function injectScriptToHtml(htmlPath: string, chunkPath: string, outDir: string): boolean {
    let html = fs.readFileSync(htmlPath, "utf-8")
    if (html.includes(path.basename(chunkPath))) return false

    const src = resolveScriptSrc(htmlPath, chunkPath, outDir)
    const scriptTag = `<script type="module" crossorigin src="${src}"></script>`
    // 注入到 <head> 起始处（应用入口脚本之前），保证图标注册先于应用渲染：
    // 否则应用会先创建 iconify-icon 元素、图标注册晚到，造成偶发图标缺失
    // （Service Worker 等改变资源加载时序后尤其明显）。与 dev 模式 head-prepend 行为一致。
    const headOpen = html.match(/<head[^>]*>/)
    if (headOpen) {
      html = html.replace(headOpen[0], `${headOpen[0]}\n    ${scriptTag}`)
    } else {
      html = html.replace("</head>", `    ${scriptTag}\n</head>`) // 兜底
    }
    fs.writeFileSync(htmlPath, html)
    return true
  }

  function injectGeneratedChunks(outDir: string): void {
    if (!hasRegistrationModule() || !fs.existsSync(outDir)) return

    const htmlFiles = findFiles(outDir, filePath => path.basename(filePath) === "index.html")
    const chunkFiles = findFiles(outDir, filePath => path.basename(filePath).includes("_iconify-offline_icons") && filePath.endsWith(".js"))
    if (htmlFiles.length === 0 || chunkFiles.length === 0) return

    for (const htmlPath of htmlFiles) {
      const htmlDir = path.dirname(htmlPath)
      const chunkPath = chunkFiles.find(filePath => path.dirname(filePath).startsWith(htmlDir)) || chunkFiles[0]
      if (injectScriptToHtml(htmlPath, chunkPath, outDir) && verbose) {
        console.log(`[iconify-offline] 已注入图标注册脚本: ${path.basename(chunkPath)}`)
      }
    }
  }

  function getTargetDir(): string {
    return customScanDir
      ? path.resolve(rootDir, customScanDir)
      : path.join(rootDir, "src")
  }

  function isSourceFile(filePath: string): boolean {
    return /\.(tsx?|jsx?|vue|svelte)$/.test(filePath)
  }

  function isInTargetDir(filePath: string): boolean {
    const relative = path.relative(getTargetDir(), filePath)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  }

  function refreshSnapshot(): boolean {
    // 扫描状态属于本次扫描，只有读取成功后才提交；不同插件实例不共享状态。
    const registry = new Map<string, Set<string>>()
    const targetDir = getTargetDir()
    // 没有源码目录的初始配置仍支持手动 icons；已有数据后目录丢失则视为失败。
    const complete = !fs.existsSync(targetDir) && snapshot.collections.length === 0
      ? true
      : scanDir(targetDir, excludeSet, registry, fileFilter)

    for (const icon of icons) {
      collectIconInto(icon, excludeSet, registry)
    }

    const total = Array.from(registry.values()).reduce((s, v) => s + v.size, 0)
    if (verbose) {
      console.log(`[iconify-offline] 扫描到 ${total} 个图标引用，${registry.size} 个图标集`)
    }

    const { collections, failedPrefixes } = buildPreloadCollections(rootDir, verbose, registry)
    retrySnapshot = !complete || failedPrefixes.size > 0
    const lostCollection = snapshot.collections.some(collection => failedPrefixes.has(collection.prefix))
    if (command === "serve" && (!complete || lostCollection)) {
      if (!warnedAboutScan) {
        console.warn("[iconify-offline] 图标扫描未完成，保留上一次有效数据；恢复文件或依赖后刷新页面即可重试")
        warnedAboutScan = true
      }
      return false
    }

    warnedAboutScan = false
    const next = createSnapshot(collections)
    const changed = next.signature !== snapshot.signature
    snapshot = next
    return changed
  }

  function retryFailedSnapshot(): void {
    if (command !== "serve" || !retrySnapshot) return
    if (!refreshSnapshot()) return
    // 页面刷新时也重试失败扫描，并清除先前缓存的空/旧模块。
    const module = server?.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID)
    if (module) server!.moduleGraph.invalidateModule(module)
  }

  /** 从 Vite 插件列表自动检测框架 */
  function detectPackageFromPlugins(plugins: readonly any[]): string | null {
    for (const p of plugins) {
      const name: string = p?.name || ""
      if (name.startsWith("vite:vue") || name.includes("unplugin-vue")) return "@iconify/vue"
      if (name.startsWith("vite:react") || name.includes("@vitejs/plugin-react")) return "@iconify/react"
      if (name.includes("solid")) return "@iconify-icon/solid"
      if (name.includes("svelte")) return "@iconify/svelte"
    }
    return null
  }

  return {
    name: "vite-plugin-iconify-offline",
    enforce: "pre",

    configResolved(config) {
      rootDir = config.root
      fileFilter = createFilter(undefined, excludeFiles, { resolve: rootDir })
      base = config.base
      command = config.command

      // 用户未显式指定 package 时，自动从 Vite 插件检测框架
      if (!pkgName) {
        pkgName = detectPackageFromPlugins(config.plugins) || "@iconify/vue"
        if (verbose) {
          console.log(`[iconify-offline] 自动检测到图标包: ${pkgName}`)
        }
      }

      if (disableApi && isOfflineEntry(pkgName) && verbose) {
        console.log(`[iconify-offline] ${pkgName} 是离线版入口，本身不含联网代码，disableApi 无需生效`)
      }
    },

    configureServer(viteServer) {
      server = viteServer
    },

    buildStart() {
      refreshSnapshot()

      if (hasRegistrationModule() && command === "build") {
        this.emitFile({
          type: "chunk",
          id: VIRTUAL_MODULE_ID,
          name: "_iconify-offline_icons",
        })
        if (verbose) {
          console.log("[iconify-offline] 已生成图标注册 chunk")
        }
      }
    },

    transformIndexHtml() {
      retryFailedSnapshot()
      if (command !== "serve" || !hasRegistrationModule()) return

      return [
        {
          tag: "script",
          attrs: { type: "module", src: `/@id/${VIRTUAL_MODULE_ID}` },
          injectTo: "head-prepend",
        },
      ]
    },

    // 虚拟模块：图标注册入口
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return
      retryFailedSnapshot()
      return generateIconRegistrationModule(snapshot.collections, pkgName!, disableApi)
    },

    handleHotUpdate(ctx) {
      if (command !== "serve" || !isSourceFile(ctx.file) || !fileFilter(ctx.file) || !isInTargetDir(ctx.file)) return

      const changed = refreshSnapshot()
      if (!changed) return

      const module = ctx.server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID)
      if (module) {
        ctx.server.moduleGraph.invalidateModule(module)
      }

      const viteServer = server || ctx.server
      viteServer.ws.send({ type: "full-reload" })
      return []
    },

    // 构建完成后，将 chunk 注入到实际输出目录中的 index.html
    writeBundle(outputOptions, bundle) {
      if (!hasRegistrationModule()) return

      let chunkFile = ""
      for (const [, info] of Object.entries(bundle)) {
        if (info.type === "chunk" && (
          info.facadeModuleId === RESOLVED_VIRTUAL_MODULE_ID
          || info.name === "_iconify-offline_icons"
          || info.fileName.includes("_iconify-offline_icons")
        )) {
          chunkFile = info.fileName
          break
        }
      }

      if (!chunkFile) {
        console.warn("[iconify-offline] 未找到图标注册 chunk，可能是 tree-shaking 了")
        return
      }

      const outDir = outputOptions.dir || path.join(rootDir, "dist")
      const htmlCandidates = [
        path.join(outDir, "index.html"),
        path.join(outDir, "client", "index.html"),
      ]
      const htmlPath = htmlCandidates.find(fs.existsSync)
      if (!htmlPath) return

      const chunkPath = path.join(outDir, chunkFile)
      const didInject = injectScriptToHtml(htmlPath, chunkPath, outDir)

      if (didInject && verbose) {
        console.log(`[iconify-offline] 已注入图标注册脚本: ${path.basename(chunkFile)}`)
      }
    },

    closeBundle() {
      injectGeneratedChunks(path.join(rootDir, "dist"))
    },
  }
}

export default iconifyOffline
