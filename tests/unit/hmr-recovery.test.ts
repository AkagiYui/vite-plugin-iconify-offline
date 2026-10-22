import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import iconifyOffline from "../../src/index"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(source = `const icon = 'test-icons:check'`, command = "serve") {
  const root = fs.mkdtempSync(path.join(tmpdir(), "iconify-hmr-"))
  roots.push(root)
  fs.mkdirSync(path.join(root, "src"))
  const file = path.join(root, "src/main.ts")
  fs.writeFileSync(file, source)
  const data = path.join(root, "node_modules/@iconify-json/test-icons/icons.json")
  fs.mkdirSync(path.dirname(data), { recursive: true })
  const restore = (body = "<path />") => fs.writeFileSync(data, JSON.stringify({ prefix: "test-icons", icons: { check: { body } } }))
  restore()
  const plugin = iconifyOffline({ package: "@iconify/vue", verbose: false }) as any
  plugin.configResolved({ root, base: "/", command, plugins: [] })
  const server = { moduleGraph: { getModuleById: vi.fn(() => ({})), invalidateModule: vi.fn() }, ws: { send: vi.fn() } }
  plugin.configureServer(server)
  const start = () => plugin.buildStart.call({ emitFile: vi.fn() })
  start()
  const load = () => plugin.load("\0virtual:iconify-offline:icons") as string
  const html = () => plugin.transformIndexHtml()
  const update = () => plugin.handleHotUpdate({ file, server })
  return { root, file, data, restore, plugin, server, start, load, html, update }
}

describe("dev 图标快照恢复", () => {
  it("依赖暂时不可读时保留有效数据和 HTML 注入，恢复后页面刷新即可更新缓存", () => {
    const f = fixture()
    const original = f.load()
    fs.unlinkSync(f.data)
    f.update()
    expect(f.load()).toBe(original)
    expect(f.html()[0].attrs.src).toBe("/@id/virtual:iconify-offline:icons")
    expect(f.server.ws.send).not.toHaveBeenCalled()
    f.restore("<circle />")
    f.html()
    expect(f.load()).toContain("<circle />")
    expect(f.server.moduleGraph.invalidateModule).toHaveBeenCalledTimes(1)
  })

  it.each(["{", '{"icons":null}', '{"icons":[]}'])("图标集暂时损坏时不提交无效快照：%s", (invalid) => {
    const f = fixture()
    const original = f.load()
    fs.writeFileSync(f.data, invalid)
    f.update()
    expect(f.load()).toBe(original)
    f.restore("<circle />")
    expect(f.load()).toContain("<circle />")
  })

  it("源码读取失败不会清空图标，恢复后刷新即可重新扫描", () => {
    const f = fixture()
    const original = f.load()
    const read = fs.readFileSync
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      if (file === f.file) throw new Error("temporarily unavailable")
      return (read as any)(file, ...args)
    }) as typeof fs.readFileSync)
    f.update()
    expect(f.load()).toBe(original)
    expect(f.html()).toHaveLength(1)
    spy.mockRestore()
    f.restore("<circle />")
    expect(f.load()).toContain("<circle />")
  })

  it("一个图标集不可读时不会只提交剩余图标集", () => {
    const f = fixture(`const first = 'test-icons:check'; const second = 'other-icons:check'`)
    const second = path.join(f.root, "node_modules/@iconify-json/other-icons/icons.json")
    fs.mkdirSync(path.dirname(second), { recursive: true })
    fs.writeFileSync(second, JSON.stringify({ prefix: "other-icons", icons: { check: { body: "<circle />" } } }))
    f.update()
    const original = f.load()
    expect(original).toContain("other-icons")
    fs.unlinkSync(f.data)
    f.update()
    expect(f.load()).toBe(original)
  })

  it("没有图标的第二个实例不会删除第一个实例的注入脚本和构建 chunk", () => {
    const dev = fixture()
    const original = dev.load()
    fixture("console.log('no icons')")
    expect(dev.html()).toHaveLength(1)
    expect(dev.load()).toBe(original)
    const build = fixture(undefined, "build")
    fixture("console.log('no icons')", "build")
    const out = path.join(build.root, "dist")
    fs.mkdirSync(path.join(out, "assets"), { recursive: true })
    fs.writeFileSync(path.join(out, "index.html"), "<html><head></head></html>")
    build.plugin.writeBundle({ dir: out }, {
      icons: { type: "chunk", fileName: "assets/_iconify-offline_icons.js", facadeModuleId: "\0virtual:iconify-offline:icons" },
    })
    expect(fs.readFileSync(path.join(out, "index.html"), "utf8")).toContain("_iconify-offline_icons.js")
  })

  it("源码目录暂时不可读时保留数据，目录恢复后刷新即可更新", () => {
    const f = fixture()
    const original = f.load()
    const source = path.join(f.root, "src")
    const backup = path.join(f.root, "src-backup")
    fs.renameSync(source, backup)
    f.update()
    expect(f.load()).toBe(original)
    fs.renameSync(backup, source)
    f.restore("<circle />")
    f.html()
    expect(f.load()).toContain("<circle />")
  })

  it("没有源码目录时仍支持手动指定图标", () => {
    const f = fixture()
    fs.rmSync(path.join(f.root, "src"), { recursive: true })
    const plugin = iconifyOffline({ package: "@iconify/vue", icons: ["test-icons:check"], verbose: false }) as any
    plugin.configResolved({ root: f.root, base: "/", command: "serve", plugins: [] })
    plugin.buildStart()
    expect(plugin.load("\0virtual:iconify-offline:icons")).toContain("test-icons")
    expect(plugin.transformIndexHtml()).toHaveLength(1)
  })

  it("正常删除最后一个图标引用仍提交空快照", () => {
    const f = fixture()
    fs.writeFileSync(f.file, "console.log('no icons')")
    f.update()
    expect(f.load()).toBe("")
    expect(f.html()).toBeUndefined()
    expect(f.server.ws.send).toHaveBeenCalledWith({ type: "full-reload" })
  })

  it("启动时缺失图标依赖，安装后刷新即可生成注册脚本", () => {
    const f = fixture()
    fs.unlinkSync(f.data)
    const plugin = iconifyOffline({ package: "@iconify/vue", verbose: false }) as any
    plugin.configResolved({ root: f.root, base: "/", command: "serve", plugins: [] })
    plugin.buildStart()
    expect(plugin.load("\0virtual:iconify-offline:icons")).toBe("")
    f.restore()
    expect(plugin.transformIndexHtml()).toHaveLength(1)
    expect(plugin.load("\0virtual:iconify-offline:icons")).toContain("test-icons")
  })
})
