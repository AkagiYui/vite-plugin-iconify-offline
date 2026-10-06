import { describe, it, expect, afterAll } from "vitest"
import { build, createServer, type ViteDevServer } from "vite"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const projectRoot = resolve(__dirname, "../..")

/** 用于收集需要清理的临时目录 */
const cleanupDirs: string[] = []
afterAll(async () => {
  for (const dir of cleanupDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

function mkdirp(dir: string): void {
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
}

/**
 * 创建临时 fixture 项目，返回项目根目录路径。
 */
function linkNodeModule(fixtureDir: string, packageName: string): void {
  const parts = packageName.split("/")
  const target = resolve(projectRoot, "node_modules", ...parts)
  const linkPath = join(fixtureDir, "node_modules", ...parts)
  mkdirp(dirname(linkPath))
  symlinkSync(target, linkPath, "dir")
}

function writeFixtureFiles(dir: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath)
    mkdirp(join(fullPath, ".."))
    writeFileSync(fullPath, content)
  }
}

function createFixture(files: Record<string, string>, packages?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "iconify-e2e-"))
  cleanupDirs.push(dir)

  writeFixtureFiles(dir, files)

  if (packages) {
    mkdirp(join(dir, "node_modules"))
    for (const packageName of packages) {
      linkNodeModule(dir, packageName)
    }
  } else {
    // 软链接 node_modules 使插件能解析 @iconify-json 和 @vitejs/plugin-vue
    const nmTarget = resolve(projectRoot, "node_modules")
    symlinkSync(nmTarget, join(dir, "node_modules"), "dir")
  }

  return dir
}

function createFixtureWithAncestorNodeModules(
  appFiles: Record<string, string>,
  ancestorFiles: Record<string, string>,
  packages: string[],
): string {
  const parentDir = mkdtempSync(join(tmpdir(), "iconify-e2e-parent-"))
  cleanupDirs.push(parentDir)

  const appDir = join(parentDir, "app")
  mkdirp(appDir)
  writeFixtureFiles(appDir, appFiles)
  writeFixtureFiles(parentDir, ancestorFiles)

  mkdirp(join(appDir, "node_modules"))
  for (const packageName of packages) {
    linkNodeModule(appDir, packageName)
  }

  return appDir
}

/**
 * 在 fixture 目录中执行 Vite 构建并返回 dist 目录路径。
 */
async function buildFixture(fixtureDir: string) {
  const origCwd = process.cwd()
  try {
    process.chdir(fixtureDir)
    await build({ logLevel: "warn" })
  } finally {
    process.chdir(origCwd)
  }
  return join(fixtureDir, "dist")
}

async function readDevHtml(fixtureDir: string): Promise<string> {
  const server = await createServer({
    root: fixtureDir,
    logLevel: "warn",
    server: {
      middlewareMode: true,
      hmr: false,
    },
  })

  try {
    const html = readFileSync(join(fixtureDir, "index.html"), "utf-8")
    return await server.transformIndexHtml("/", html)
  } finally {
    await server.close()
  }
}

async function createDevServer(fixtureDir: string): Promise<ViteDevServer> {
  return createServer({
    root: fixtureDir,
    logLevel: "warn",
    server: {
      middlewareMode: true,
    },
  })
}

async function readDevVirtualModule(server: ViteDevServer): Promise<string> {
  const result = await server.pluginContainer.load("\0virtual:iconify-offline:icons")
  if (typeof result === "string") return result
  return result?.code || ""
}

/**
 * 从 dist 目录中读取插件生成的图标注册 chunk 内容。
 * 返回 chunk 文本，或 null 如果没有。
 */
function readIconChunk(distDir: string): string | null {
  const assetsDir = join(distDir, "assets")
  let files: string[] = []
  try {
    files = readdirSync(assetsDir)
  } catch {
    return null
  }

  const iconFile = files.find(f => f.startsWith("_iconify-offline_icons") && f.endsWith(".js"))
  if (!iconFile) return null

  return readFileSync(join(assetsDir, iconFile), "utf-8")
}

/**
 * 读取构建后的 index.html。
 */
function readHtml(distDir: string): string {
  return readFileSync(join(distDir, "index.html"), "utf-8")
}

function readHtmlAt(dir: string, subdir: string): string {
  return readFileSync(join(dir, subdir, "index.html"), "utf-8")
}

/** 从 HTML 中提取 iconify 注册脚本的 src。 */
function getIconScriptSrc(html: string): string | null {
  const m = html.match(/<script[^>]*src="([^"]*_iconify-offline_icons[^"]*)"/)
  return m ? m[1] : null
}

// ─────────────────────────── 测试用例 ───────────────────────────

describe("iconifyOffline 集成测试", () => {

  it("应在有图标引用的项目中注入注册脚本", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template>
  <Icon name="lucide:sun" />
</template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    // HTML 中应注入图标注册脚本标签
    expect(html).toContain("_iconify-offline_icons")
    // JS chunk 中应包含图标数据（即使被压缩，图标名依然存在）
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/lucide/)
    expect(chunk!).toMatch(/sun/)
  }, 30000)

  it("默认 base 下注入脚本应为绝对路径（兼容 SSG 子路径页面）", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template><Icon name="lucide:sun" /></template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    })

    const src = getIconScriptSrc(readHtml(await buildFixture(fixtureDir)))
    expect(src).not.toBeNull()
    // 必须是绝对路径 /assets/...；相对 ./assets/... 在 SSG 子路径页面会解析成 404
    expect(src!.startsWith("/assets/")).toBe(true)
    expect(src!.startsWith("./")).toBe(false)
  }, 30000)

  it("应遵循自定义 base 前缀", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template><Icon name="lucide:sun" /></template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  base: "/sub/",
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    })

    const src = getIconScriptSrc(readHtml(await buildFixture(fixtureDir)))
    expect(src).not.toBeNull()
    expect(src!.startsWith("/sub/assets/")).toBe(true)
  }, 30000)

  it("应放过不存在的图标集而不崩溃", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>`,
      "src/main.ts": `import "vue"`,
      "src/App.vue": `<template>
  <Icon name="mdi:rocket-launch" />
</template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    // mdi 图标集未安装，不应注入 addCollection
    expect(html).not.toContain("_iconify-offline_icons")
    expect(chunk).toBeNull()
  }, 30000)

  it("应支持从 @iconify/json 大包读取图标集", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template>
  <Icon name="lucide:sun" />
</template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "node_modules/@iconify/json/json/lucide.json": JSON.stringify({
        prefix: "lucide",
        icons: {
          sun: {
            body: '<circle cx="12" cy="12" r="5"/>',
          },
        },
        width: 24,
        height: 24,
      }),
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    }, ["vite", "@vitejs/plugin-vue", "vue", "@iconify/vue"])

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(html).toContain("_iconify-offline_icons")
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/lucide/)
    expect(chunk!).toMatch(/sun/)
    expect(chunk!).toMatch(/circle/)
  }, 30000)

  it("应支持通过 require.resolve 从上级 node_modules 解析 @iconify/json", async () => {
    const fixtureDir = createFixtureWithAncestorNodeModules({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template>
  <Icon name="fixture-icons:search" />
</template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    }, {
      "node_modules/@iconify/json/package.json": JSON.stringify({
        name: "@iconify/json",
        version: "0.0.0-test",
        exports: {
          "./*": "./*",
        },
      }),
      "node_modules/@iconify/json/json/fixture-icons.json": JSON.stringify({
        prefix: "fixture-icons",
        icons: {
          search: {
            body: '<path d="M1 1h10v10H1z"/>',
          },
        },
        width: 12,
        height: 12,
      }),
    }, ["vite", "@vitejs/plugin-vue", "vue", "@iconify/vue"])

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(html).toContain("_iconify-offline_icons")
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/fixture-icons/)
    expect(chunk!).toMatch(/search/)
    expect(chunk!).toMatch(/M1 1h10v10H1z/)
  }, 30000)

  it("应在没有图标引用的项目中不注入任何内容", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `console.log("no icons here")`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(html).not.toContain("_iconify-offline_icons")
    expect(chunk).toBeNull()
  }, 30000)

  it("应支持自定义扫描目录", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body></body></html>`,
      "custom/icons.tsx": `export default () => <Icon name="lucide:github" />`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, scanDir: "custom" })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    // 自定义目录中的图标应被扫描到
    expect(html).toContain("_iconify-offline_icons")
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/lucide/)
    expect(chunk!).toMatch(/github/)
  }, 30000)

  it("应支持手动传入额外离线图标", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body></body></html>`,
      "src/main.ts": `const icon = \`lucide:\${name}\``,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, icons: ["lucide:settings"] })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(html).toContain("_iconify-offline_icons")
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/lucide/)
    expect(chunk!).toMatch(/settings/)
  }, 30000)

  it("应跳过 exclude 指定的前缀，不收集对应图标集", async () => {
    // 排除一个本可被解析的真实图标集（lucide），验证 exclude 确实阻止了收集：
    // 唯一的图标引用被排除后，不应生成任何注册 chunk。
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>`,
      "src/main.ts": `const icon = "lucide:sun"`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, exclude: ["lucide"], package: "@iconify/vue" })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(html).not.toContain("_iconify-offline_icons")
    expect(chunk).toBeNull()
  }, 30000)

  it("应自动检测 icon 包为 @iconify/vue", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body></body></html>`,
      "src/App.vue": `<template><Icon name="lucide:check" /></template>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    // 应自动检测框架并注入图标
    expect(html).toContain("_iconify-offline_icons")
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/lucide/)
    expect(chunk!).toMatch(/check/)
  }, 30000)

  it("Vue dev 模式应注入图标注册虚拟模块", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template><Icon icon="lucide:shield-check" /></template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    })

    const html = await readDevHtml(fixtureDir)

    expect(html).toContain(`"/@id/virtual:iconify-offline:icons"`)

    const server = await createDevServer(fixtureDir)
    try {
      const moduleCode = await readDevVirtualModule(server)
      expect(moduleCode).toContain("addCollection")
      expect(moduleCode).toContain("setCustomIconsLoader")
      expect(moduleCode).toContain("lucide")
      expect(moduleCode).toContain("shield-check")
    } finally {
      await server.close()
    }
  }, 30000)

  it("dev 模式源码新增图标后应刷新虚拟模块", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template><Icon icon="lucide:sun" /></template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
})`,
    })

    const server = await createDevServer(fixtureDir)
    try {
      let moduleCode = await readDevVirtualModule(server)
      expect(moduleCode).toContain("sun")
      expect(moduleCode).not.toContain("moon")

      const appPath = join(fixtureDir, "src/App.vue")
      writeFileSync(appPath, `<template>
  <Icon icon="lucide:sun" />
  <Icon icon="lucide:moon" />
</template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`)

      const fullReload = new Promise<void>((resolveReload) => {
        const send = server.ws.send.bind(server.ws)
        server.ws.send = ((payload: any, ...args: any[]) => {
          if (payload?.type === "full-reload") resolveReload()
          return send(payload, ...args)
        }) as typeof server.ws.send
      })

      server.watcher.emit("change", appPath)
      await fullReload

      moduleCode = await readDevVirtualModule(server)
      expect(moduleCode).toContain("sun")
      expect(moduleCode).toContain("moon")
    } finally {
      await server.close()
    }
  }, 30000)

  it("Solid build 模式应自动检测并注册到 @iconify-icon/solid", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><div id="app"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
      "src/main.tsx": `import { render } from "solid-js/web"
import { Icon } from "@iconify-icon/solid"

render(() => <Icon icon="lucide:panel-left" />, document.getElementById("app")!)`,
      "vite.config.ts": `import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [solid(), iconifyOffline({ verbose: false })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(html).toContain("_iconify-offline_icons")
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/lucide/)
    expect(chunk!).toMatch(/panel-left/)
  }, 30000)

  it("Solid dev 模式应注入图标注册虚拟模块", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><div id="app"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
      "src/main.tsx": `import { render } from "solid-js/web"
import { Icon } from "@iconify-icon/solid"

render(() => <Icon icon="lucide:box" />, document.getElementById("app")!)`,
      "vite.config.ts": `import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [solid(), iconifyOffline({ verbose: false })],
})`,
    })

    const html = await readDevHtml(fixtureDir)

    expect(html).toContain(`"/@id/virtual:iconify-offline:icons"`)

    const server = await createDevServer(fixtureDir)
    try {
      const moduleCode = await readDevVirtualModule(server)
      expect(moduleCode).toContain("@iconify-icon/solid")
      expect(moduleCode).toContain("lucide")
      expect(moduleCode).toContain("box")
    } finally {
      await server.close()
    }
  }, 30000)

  it("应兼容非默认输出目录并注入注册脚本", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>`,
      "src/main.ts": `console.log("client outdir")`,
      "src/App.vue": `<template><Icon name="lucide:check" /></template>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts") }"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false })],
  build: {
    outDir: "dist/client",
  },
})`,
    })

    const origCwd = process.cwd()
    try {
      process.chdir(fixtureDir)
      await build({ logLevel: "warn" })
    } finally {
      process.chdir(origCwd)
    }

    const html = readHtmlAt(fixtureDir, "dist/client")
    const assetsDir = join(fixtureDir, "dist/client/assets")
    const files = readdirSync(assetsDir)
    const chunkFile = files.find(f => f.startsWith("_iconify-offline_icons") && f.endsWith(".js"))

    expect(html).toContain("_iconify-offline_icons")
    expect(chunkFile).toBeTruthy()
  }, 30000)

  it("disableApi：构建产物在预注册之前禁用 API，且注册脚本先于应用入口", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template><Icon icon="lucide:sun" /></template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false, disableApi: true })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(chunk).not.toBeNull()
    // 压缩后 _api 会被改名，但 setFetch 方法名和 404 都还在
    expect(chunk!).toMatch(/\.setFetch\(/)
    expect(chunk!).toContain("status:404")
    expect(chunk!).toContain("iconify-offline: API disabled")
    expect(chunk!.indexOf(".setFetch(")).toBeLessThan(chunk!.indexOf("lucide"))

    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1])
    expect(scripts[0]).toContain("_iconify-offline_icons")
    expect(scripts.findIndex(src => src.includes("/assets/index"))).toBeGreaterThan(0)
  }, 30000)

  it("disableApi：没有扫描到任何图标时仍注入禁用脚本", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { loadIcon } from "@iconify/vue"
// 名字是拼出来的，扫描扫不到
const set = "md" + "i"
loadIcon(set + ":home")`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, disableApi: true, package: "@iconify/vue" })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const html = readHtml(distDir)
    const chunk = readIconChunk(distDir)

    expect(getIconScriptSrc(html)).toMatch(/^\/assets\/_iconify-offline_icons/)
    expect(chunk).not.toBeNull()
    expect(chunk!).toMatch(/\.setFetch\(/)
    expect(chunk!).not.toContain("addCollection")
  }, 30000)

  it("disableApi：dev 模式的虚拟模块同样禁用 API（包括没有图标时）", async () => {
    const withIcons = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template><Icon icon="lucide:shield-check" /></template>
<script setup lang="ts">
import { Icon } from "@iconify/vue"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false, disableApi: true })],
})`,
    })
    const server = await createDevServer(withIcons)
    try {
      const moduleCode = await readDevVirtualModule(server)
      expect(moduleCode).toMatch(/^import \{ _api, addCollection, setCustomIconsLoader \} from "@iconify\/vue";\n_api\.setFetch\(/)
      expect(moduleCode).toContain("shield-check")
    } finally {
      await server.close()
    }

    const noIcons = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>`,
      "src/main.ts": `console.log("no icons here")`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, disableApi: true, package: "@iconify/vue" })],
})`,
    })
    expect(await readDevHtml(noIcons)).toContain(`"/@id/virtual:iconify-offline:icons"`)
  }, 30000)

  // ─────────────── 官方离线版入口 ───────────────

  /** 构建产物里所有 JS 拼在一起，用来断言整个包里没有联网代码 */
  function readAllJs(distDir: string): string {
    const assetsDir = join(distDir, "assets")
    return readdirSync(assetsDir).filter(f => f.endsWith(".js")).map(f => readFileSync(join(assetsDir, f), "utf-8")).join("\n")
  }

  it("Vue 离线版：注册进 @iconify/vue/offline，整个产物没有 Iconify API", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { createApp } from "vue"
import App from "./App.vue"
createApp(App).mount("#app")`,
      "src/App.vue": `<template><Icon icon="lucide:sun" /></template>
<script setup lang="ts">
import { Icon } from "@iconify/vue/offline"
</script>`,
      "vite.config.ts": `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [vue(), iconifyOffline({ verbose: false, package: "@iconify/vue/offline" })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const chunk = readIconChunk(distDir)
    const allJs = readAllJs(distDir)

    expect(getIconScriptSrc(readHtml(distDir))).toBeTruthy()
    expect(chunk).not.toBeNull()
    expect(chunk!).toContain("lucide")
    // 0.4.x 会剥掉 /offline 注册进主入口：主入口带着 API 代码一起进包，组件却读不到图标
    expect(allJs).not.toContain("api.iconify.design")
    expect(allJs).not.toContain("setCustomIconsLoader")
  }, 30000)

  it("React 离线版：注册进 @iconify/react/offline，整个产物没有 Iconify API", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `import { createElement } from "react"
import { Icon } from "@iconify/react/offline"
export const icon = createElement(Icon, { icon: "lucide:sun" })
console.log(icon)`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, package: "@iconify/react/offline" })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const chunk = readIconChunk(distDir)

    expect(chunk).not.toBeNull()
    expect(chunk!).toContain("lucide")
    expect(readAllJs(distDir)).not.toContain("api.iconify.design")
  }, 30000)

  it("Svelte 离线版：@iconify/svelte/dist/offline-functions 能构建（它没有 setCustomIconsLoader）", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><script type="module" src="/src/main.ts"></script></body>
</html>`,
      // 只用离线版的函数入口，不编译 .svelte：OfflineIcon.svelte 读的正是这个模块的 storage
      "src/main.ts": `import { generateIcon } from "@iconify/svelte/dist/offline-functions"
console.log(generateIcon({ icon: "lucide:sun" }))`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, package: "@iconify/svelte/dist/offline-functions" })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    const chunk = readIconChunk(distDir)

    expect(chunk).not.toBeNull()
    expect(chunk!).toContain("lucide")
    expect(readAllJs(distDir)).not.toContain("api.iconify.design")
  }, 30000)

  it("离线版入口 + disableApi 且没有图标：不注入任何东西（没有 API 可禁）", async () => {
    const fixtureDir = createFixture({
      "index.html": `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><script type="module" src="/src/main.ts"></script></body>
</html>`,
      "src/main.ts": `console.log("no icons here")`,
      "vite.config.ts": `import { defineConfig } from "vite"
import iconifyOffline from "${resolve(projectRoot, "src/index.ts")}"

export default defineConfig({
  plugins: [iconifyOffline({ verbose: false, disableApi: true, package: "@iconify/vue/offline" })],
})`,
    })

    const distDir = await buildFixture(fixtureDir)
    expect(readHtml(distDir)).not.toContain("_iconify-offline_icons")
    expect(readIconChunk(distDir)).toBeNull()
  }, 30000)
})
