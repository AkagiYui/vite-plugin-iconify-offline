import { describe, it, expect, vi, afterEach } from "vitest"
import { _api, addCollection, iconLoaded, loadIcon } from "@iconify/vue"
import { DISABLED_API_FETCH, generateIconRegistrationModule, type IconifyJSON } from "../../src/index"

const lucide: IconifyJSON = { prefix: "lucide", icons: { sun: { body: "<circle r=\"4\"/>" } }, width: 24, height: 24 }

describe("generateIconRegistrationModule", () => {
  it("默认不禁用 API：输出与之前一致，不引入 _api", () => {
    const code = generateIconRegistrationModule([lucide], "@iconify/vue")
    expect(code).toBe(
      `import { addCollection, setCustomIconsLoader } from "@iconify/vue";\n`
      + `addCollection(${JSON.stringify(lucide)});\n`
      + `setCustomIconsLoader(() => ({ prefix: "lucide", icons: {} }), "lucide");\n`,
    )
    expect(code).not.toContain("_api")
  })

  it("disableApi：引入 _api，并在预注册之前替换 fetch", () => {
    const code = generateIconRegistrationModule([lucide], "@iconify/vue", true)
    expect(code.split("\n")[0]).toBe(`import { _api, addCollection, setCustomIconsLoader } from "@iconify/vue";`)
    expect(code).toContain(`_api.setFetch(${DISABLED_API_FETCH});`)
    expect(code.indexOf("_api.setFetch")).toBeLessThan(code.indexOf("addCollection("))
  })

  it("disableApi 且没有任何图标：仍生成只含禁用逻辑的模块", () => {
    const code = generateIconRegistrationModule([], "@iconify/vue", true)
    expect(code).toBe(`import { _api } from "@iconify/vue";\n_api.setFetch(${DISABLED_API_FETCH});\n`)
  })

  it("没有图标也不禁用 API：不生成模块", () => {
    expect(generateIconRegistrationModule([], "@iconify/vue")).toBe("")
  })

  it("离线版入口：disableApi 不生效（离线版本身没有 API），没有图标就不生成模块", () => {
    expect(generateIconRegistrationModule([], "@iconify/vue/offline", true)).toBe("")
    expect(generateIconRegistrationModule([lucide], "@iconify/vue/offline", true)).not.toContain("_api")
  })
})

describe("禁用后的运行时行为（真实的 @iconify/vue）", () => {
  const original = _api.getFetch()
  afterEach(() => {
    if (original) _api.setFetch(original)
  })

  it("注入的 fetch 不联网，直接回 404", async () => {
    const disabledFetch = new Function(`return ${DISABLED_API_FETCH}`)() as () => Promise<Response>
    const response = await disabledFetch()
    expect(response.status).toBe(404)
  })

  it("未打包的图标直接失败，只尝试一次、不轮换备用节点；已打包的图标不经过 fetch", async () => {
    const disabledFetch = vi.fn(new Function(`return ${DISABLED_API_FETCH}`)() as typeof fetch)
    _api.setFetch(disabledFetch)

    // 未打包：Iconify 把 404 视为「不存在」直接放弃。换成 reject 的话会依次试
    // api.iconify.design / api.simplesvg.com / api.unisvg.com，这里就不止一次了
    await expect(loadIcon("mdi:disable-api-probe")).rejects.toBeTruthy()
    expect(disabledFetch).toHaveBeenCalledTimes(1)
    expect(String(disabledFetch.mock.calls[0][0])).toContain("disable-api-probe")

    // 已打包（插件生成的 addCollection）：直接从内存拿，不调 fetch
    disabledFetch.mockClear()
    addCollection({ prefix: "disableapitest", icons: { sun: { body: "<circle r=\"4\"/>" } }, width: 24, height: 24 })
    expect(iconLoaded("disableapitest:sun")).toBe(true)
    await expect(loadIcon("disableapitest:sun")).resolves.toMatchObject({ body: "<circle r=\"4\"/>" })
    expect(disabledFetch).not.toHaveBeenCalled()
  })
})
