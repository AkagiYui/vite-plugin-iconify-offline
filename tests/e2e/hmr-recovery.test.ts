import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, it } from "vitest"
import { createServer } from "vite"
import iconifyOffline from "../../src/index"

it("失败扫描和依赖恢复后刷新 HTML，应恢复真实 Vite 缓存中的图标模块", async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "iconify-hmr-server-"))
  const source = path.join(root, "src/main.ts")
  const data = path.join(root, "node_modules/@iconify-json/test-icons/icons.json")
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.mkdirSync(path.dirname(data), { recursive: true })
  fs.mkdirSync(path.join(root, "node_modules/@iconify"), { recursive: true })
  fs.symlinkSync(path.resolve("node_modules/@iconify/vue"), path.join(root, "node_modules/@iconify/vue"), "dir")
  fs.writeFileSync(source, `const icon = 'test-icons:check'`)
  const restore = (body: string) => fs.writeFileSync(data, JSON.stringify({ prefix: "test-icons", icons: { check: { body } } }))
  restore("<path />")
  const plugin = iconifyOffline({ package: "@iconify/vue", verbose: false })
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [plugin],
    optimizeDeps: { noDiscovery: true, exclude: ["@iconify/vue"] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  const html = '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>'
  const url = "/@id/virtual:iconify-offline:icons"
  try {
    await server.transformIndexHtml("/", html)
    const original = await server.transformRequest("virtual:iconify-offline:icons")
    expect(original?.code).toContain("<path />")
    fs.unlinkSync(data)
    const hook = plugin.handleHotUpdate as Function
    await hook({ file: source, server, modules: [], timestamp: Date.now(), read: () => Promise.resolve(fs.readFileSync(source, "utf8")) })
    expect(await server.transformIndexHtml("/", html)).toContain(url)
    expect((await server.transformRequest("virtual:iconify-offline:icons"))?.code).toBe(original?.code)
    restore("<circle />")
    expect(await server.transformIndexHtml("/", html)).toContain(url)
    expect((await server.transformRequest("virtual:iconify-offline:icons"))?.code).toContain("<circle />")
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30000)
