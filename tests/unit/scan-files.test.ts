import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import iconifyOffline, { type IconifyOfflineOptions } from "../../src/index"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(files: Record<string, string>, options: IconifyOfflineOptions = {}, command = "serve") {
  const root = fs.mkdtempSync(path.join(tmpdir(), "iconify-scan-"))
  roots.push(root)
  for (const [file, code] of Object.entries(files)) {
    const target = path.join(root, "src", file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, code)
  }
  const data = path.join(root, "node_modules/@iconify-json/test-icons/icons.json")
  fs.mkdirSync(path.dirname(data), { recursive: true })
  fs.writeFileSync(data, JSON.stringify({ prefix: "test-icons", icons: { check: { body: "<path />" }, sun: { body: "<circle />" } } }))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const plugin = iconifyOffline({ package: "@iconify/vue", verbose: false, ...options }) as any
  plugin.configResolved({ root, base: "/", command, plugins: [] })
  const server = { moduleGraph: { getModuleById: vi.fn(() => ({})), invalidateModule: vi.fn() }, ws: { send: vi.fn() } }
  plugin.configureServer(server)
  plugin.buildStart.call({ emitFile: vi.fn() })
  const load = () => plugin.load("\0virtual:iconify-offline:icons") as string
  return { root, plugin, server, warn, load }
}

describe("源码文件过滤", () => {
  it.each(["serve", "build"])("%s 默认忽略测试文件和注释，保留真实图标", (command) => {
    const files: Record<string, string> = {
      "App.vue": '<script setup>/* `v-model:open` */</script>\n<template><!-- "unused:html" --><Icon icon="test-icons:check" /></template>',
      "format.ts": '/** `13:45` */\nexport const format = () => ""',
      "__tests__/nested/helper.ts": 'const icon = "unused:helper"',
      "deep/__tests__/fixture.vue": '<Icon icon="unused:fixture" />',
    }
    for (const extension of ["ts", "tsx", "js", "jsx", "vue", "svelte"]) {
      files[`nested/time.test.${extension}`] = 'const time = "00:00"; const cache = "room-detail:5"'
      files[`nested/social.spec.${extension}`] = 'const dmKey = "7:8"; const icon = "test-icons:sun"'
    }
    const f = fixture(files, {}, command)
    expect(f.load()).toContain('"check"')
    expect(f.load()).not.toContain('"sun"')
    expect(f.warn).not.toHaveBeenCalled()
  })

  it("excludeFiles: [] 可恢复扫描测试文件", () => {
    const f = fixture({ "__tests__/icons.spec.ts": 'const icon = "test-icons:sun"' }, { excludeFiles: [] })
    expect(f.load()).toContain('"sun"')
    expect(f.warn).not.toHaveBeenCalled()
  })

  it("支持相对于 root 的 glob，并替换默认排除规则", () => {
    const f = fixture({
      "icons.test.ts": 'const icon = "test-icons:sun"',
      "private/icons.ts": 'const icon = "unused:private"',
    }, { excludeFiles: ["src/private/**"] })
    expect(f.load()).toContain('"sun"')
    expect(f.warn).not.toHaveBeenCalled()
  })

  it("支持正则排除规则", () => {
    const f = fixture({
      "main.ts": 'const icon = "test-icons:check"',
      "private/icons.ts": 'const icon = "unused:private"',
    }, { excludeFiles: /[/\\]private[/\\]/ })
    expect(f.load()).toContain('"check"')
    expect(f.warn).not.toHaveBeenCalled()
  })

  it("被排除文件的热更新不会触发扫描或刷新，源码热更新仍使用相同过滤规则", () => {
    const f = fixture({
      "main.ts": 'const icon = "test-icons:check"',
      "main.test.ts": 'const key = "room-detail:5"',
    })
    const original = f.load()
    fs.writeFileSync(path.join(f.root, "src/main.ts"), 'const icon = "test-icons:sun"')
    f.plugin.handleHotUpdate({ file: path.join(f.root, "src/main.test.ts"), server: f.server })
    expect(f.load()).toBe(original)
    expect(f.server.ws.send).not.toHaveBeenCalled()
    f.plugin.handleHotUpdate({ file: path.join(f.root, "src/main.ts"), server: f.server })
    expect(f.load()).toContain('"sun"')
    expect(f.load()).not.toContain('"check"')
    expect(f.server.ws.send).toHaveBeenCalledOnce()
    expect(f.warn).not.toHaveBeenCalled()
  })
})
