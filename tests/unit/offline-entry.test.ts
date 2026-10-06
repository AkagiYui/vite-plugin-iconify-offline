import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { generateIconRegistrationModule, isOfflineEntry, type IconifyJSON } from "../../src/index"

/** 每个用例用自己的前缀：同一个测试文件里各运行时包的 storage 是模块级单例。
 * 标记放 class 而不是 id：React 版会把 SVG 里的 id 改写成唯一值 */
function collection(prefix: string): IconifyJSON {
  return { prefix, icons: { sun: { body: `<circle class="${prefix}-sun" r="4"/>` } }, width: 24, height: 24 }
}

/**
 * 执行插件生成的注册模块。把 `import { a, b } from "pkg"` 换成从传入的模块对象里取，
 * 这样跑的就是生成的那几行原样代码，而且和测试里渲染组件用的是同一个模块实例。
 */
function runRegistration(code: string, mod: Record<string, unknown>): void {
  const body = code.replace(/^import \{([^}]+)\} from "[^"]+";\n/, (_, names: string) => `const {${names}} = __mod;\n`)
  new Function("__mod", body)(mod)
}

describe("isOfflineEntry", () => {
  it.each([
    "@iconify/vue/offline",
    "@iconify/vue/dist/offline",
    "@iconify/vue2/offline",
    "@iconify/react/offline",
    "@iconify/svelte/dist/offline-functions",
  ])("%s 是离线版入口", (pkg) => {
    expect(isOfflineEntry(pkg)).toBe(true)
  })

  it.each(["@iconify/vue", "@iconify/react", "@iconify/svelte", "@iconify-icon/solid", "iconify-icon"])("%s 不是", (pkg) => {
    expect(isOfflineEntry(pkg)).toBe(false)
  })
})

describe("离线版入口的注册模块", () => {
  it("注册进同一个入口，只调 addCollection", () => {
    const c = collection("lucide")
    expect(generateIconRegistrationModule([c], "@iconify/react/offline")).toBe(
      `import { addCollection } from "@iconify/react/offline";\naddCollection(${JSON.stringify(c)});\n`,
    )
    const svelte = generateIconRegistrationModule([c], "@iconify/svelte/dist/offline-functions")
    expect(svelte.split("\n")[0]).toBe(`import { addCollection } from "@iconify/svelte/dist/offline-functions";`)
    expect(svelte).not.toContain("setCustomIconsLoader")
  })
})

describe("真实的离线版运行时：注册的图标组件能读到", () => {
  it("Vue：@iconify/vue/offline", async () => {
    const offline = await import("@iconify/vue/offline")
    runRegistration(generateIconRegistrationModule([collection("vueoff")], "@iconify/vue/offline"), offline)
    const html = await renderToString(createSSRApp({ render: () => h(offline.Icon, { icon: "vueoff:sun" }) }))
    expect(html).toContain(`class="vueoff-sun"`)
  })

  it("Vue 对照：注册进主入口的话，离线版组件读不到（0.4.x 剥掉 /offline 的问题）", async () => {
    const [main, offline] = await Promise.all([import("@iconify/vue"), import("@iconify/vue/offline")])
    runRegistration(generateIconRegistrationModule([collection("vuemain")], "@iconify/vue"), main)
    const html = await renderToString(createSSRApp({ render: () => h(offline.Icon, { icon: "vuemain:sun" }) }))
    expect(html).not.toContain(`class="vuemain-sun"`)
  })

  it("React：@iconify/react/offline", async () => {
    const offline = await import("@iconify/react/offline")
    runRegistration(generateIconRegistrationModule([collection("reactoff")], "@iconify/react/offline"), offline)
    const html = renderToStaticMarkup(createElement(offline.Icon, { icon: "reactoff:sun" }))
    expect(html).toContain(`class="reactoff-sun"`)
  })

  it("Svelte：@iconify/svelte/dist/offline-functions（OfflineIcon.svelte 读的就是它）", async () => {
    const offline = await import("@iconify/svelte/dist/offline-functions")
    runRegistration(generateIconRegistrationModule([collection("svelteoff")], "@iconify/svelte/dist/offline-functions"), offline)
    const data = offline.generateIcon({ icon: "svelteoff:sun" })
    expect(data?.body).toContain(`class="svelteoff-sun"`)
  })
})
