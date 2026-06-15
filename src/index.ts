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

import type { Plugin, ViteDevServer } from "vite"

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
])

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

/** prefix -> Set<iconName> */
export const collectedIcons = new Map<string, Set<string>>()
let preloadCollections: IconifyJSON[] = []

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
 */
export function collectIcon(full: string): boolean {
  const colonIdx = full.indexOf(":")
  if (colonIdx === -1) return false
  const prefix = full.slice(0, colonIdx)
  const iconName = full.slice(colonIdx + 1)

  // 跳过 Tailwind 修饰符 / Vue 事件等误报
  if (SKIP_PREFIXES.has(prefix)) return false

  // 跳过 data-[xxx]: 格式的属性修饰符
  if (prefix.endsWith("-") || iconName.startsWith("[")) return false

  if (!collectedIcons.has(prefix)) {
    collectedIcons.set(prefix, new Set())
  }
  collectedIcons.get(prefix)!.add(iconName)
  return true
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 从源码内容中提取图标引用。
 */
export function extractIcons(code: string): void {
  const matches = code.matchAll(ICON_PATTERN)
  for (const match of matches) {
    collectIcon(match[1])
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

  try {
    const resolved = require.resolve(`@iconify/json/json/${prefix}.json`, { paths: [rootDir] })
    return JSON.parse(fs.readFileSync(resolved, "utf-8"))
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

function createSnapshot(collections: IconifyJSON[]): IconRegistrySnapshot {
  return {
    collections,
    signature: JSON.stringify(collections),
  }
}

function generateIconRegistrationModule(collections: IconifyJSON[], pkgName: string): string {
  if (collections.length === 0) return ""

  const addCollectionCalls = collections
    .map(c => `addCollection(${JSON.stringify(c)});`)
    .join("\n")

  const disableLoaderCalls = collections
    .map(c => `setCustomIconsLoader(() => ({ prefix: ${JSON.stringify(c.prefix)}, icons: {} }), ${JSON.stringify(c.prefix)});`)
    .join("\n")

  const importFrom = pkgName.replace(/\/offline$/, "")

  return `import { addCollection, setCustomIconsLoader } from "${importFrom}";\n${addCollectionCalls}\n${disableLoaderCalls}\n`
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
  } = options

  let rootDir: string
  let base = "/"  // Vite 的 base，用于生成注入脚本的绝对 URL
  let pkgName = userPkg  // 用户显式指定优先，未指定则 auto-detect
  let command: "serve" | "build" = "build"
  let server: ViteDevServer | undefined
  let snapshot: IconRegistrySnapshot = createSnapshot([])

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
    const scriptTag = `    <script type="module" crossorigin src="${src}"></script>\n`
    html = html.replace("</head>", scriptTag + "</head>")
    fs.writeFileSync(htmlPath, html)
    return true
  }

  function injectGeneratedChunks(outDir: string): void {
    if (preloadCollections.length === 0 || !fs.existsSync(outDir)) return

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
    const previousSignature = snapshot.signature

    collectedIcons.clear()
    preloadCollections = []

    const targetDir = getTargetDir()

    if (fs.existsSync(targetDir)) {
      scanDir(targetDir)
    } else if (verbose) {
      console.warn(`[iconify-offline] 扫描目录不存在: ${targetDir}`)
    }

    for (const icon of icons) {
      collectIcon(icon)
    }

    const total = Array.from(collectedIcons.values()).reduce((s, v) => s + v.size, 0)
    if (verbose) {
      console.log(`[iconify-offline] 扫描到 ${total} 个图标引用，${collectedIcons.size} 个图标集`)
    }

    preloadCollections = buildPreloadCollections(rootDir, verbose)
    snapshot = createSnapshot(preloadCollections)

    return snapshot.signature !== previousSignature
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
      base = config.base
      command = config.command

      // 用户未显式指定 package 时，自动从 Vite 插件检测框架
      if (!pkgName) {
        pkgName = detectPackageFromPlugins(config.plugins) || "@iconify/vue"
        if (verbose) {
          console.log(`[iconify-offline] 自动检测到图标包: ${pkgName}`)
        }
      }
    },

    configureServer(viteServer) {
      server = viteServer
    },

    buildStart() {
      refreshSnapshot()

      if (preloadCollections.length > 0 && command === "build") {
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
      if (command !== "serve" || preloadCollections.length === 0) return

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
      return generateIconRegistrationModule(snapshot.collections, pkgName!)
    },

    handleHotUpdate(ctx) {
      if (command !== "serve" || !isSourceFile(ctx.file) || !isInTargetDir(ctx.file)) return

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
      if (preloadCollections.length === 0) return

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
