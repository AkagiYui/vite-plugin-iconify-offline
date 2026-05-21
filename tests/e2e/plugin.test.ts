import { describe, it, expect, afterAll } from "vitest"
import { build, createServer, type ViteDevServer } from "vite"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
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
function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "iconify-e2e-"))
  cleanupDirs.push(dir)

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath)
    mkdirp(join(fullPath, ".."))
    writeFileSync(fullPath, content)
  }

  // 软链接 node_modules 使插件能解析 @iconify-json 和 @vitejs/plugin-vue
  const nmTarget = resolve(projectRoot, "node_modules")
  symlinkSync(nmTarget, join(dir, "node_modules"), "dir")

  return dir
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

  it("Vue dev 模式应注入 IconifyPreload", async () => {
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

    expect(html).toContain("window.IconifyPreload")
    expect(html).toContain("lucide")
    expect(html).toContain("shield-check")
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

  it("Solid dev 模式应注入 IconifyPreload", async () => {
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

    expect(html).toContain("window.IconifyPreload")
    expect(html).toContain("lucide")
    expect(html).toContain("box")
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
})
